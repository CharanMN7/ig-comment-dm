# Architecture

Single-tenant per deployment. Each customer gets their own Cloudflare account, Worker, D1 database, and Meta app in development mode with themselves as admin. No signup, no multi-user model, no billing. One deployment may manage several Instagram accounts; they all belong to the same person.

The operator uses the admin UI and never sees the code.

## Stack

- Cloudflare Workers, TypeScript, ESM
- Hono, default Workers export (`fetch` + `scheduled`). Not `hono/vercel`.
- Hono `{ strict: false }` so `/a/:secret` and `/a/:secret/` both work
- D1 via the `DB` binding. Raw parameterized SQL (`.prepare().bind()`). No ORM.
- Schema in `migrations/001_init.sql`, applied by the Wrangler CLI
- Server-rendered HTML via `hono/html`. No React, no Tailwind, no bundler, no client framework. One `<style>` block in the layout.
- Runtime dependency: `hono` only. `wrangler` / `typescript` / `@cloudflare/workers-types` are devDependencies.
- Do **not** enable `nodejs_compat`. Do **not** import `node:crypto`.

## Crypto (Web Crypto only)

- All randomness: `crypto.getRandomValues`. Never `Math.random`.
- Webhook signatures (`X-Hub-Signature-256`): `crypto.subtle.importKey` + `crypto.subtle.verify` (HMAC-SHA256). Verify, do not sign-and-`===`.
- Token encryption: AES-256-GCM, random 96-bit IV per encryption, IV stored in `accounts.token_iv`, ciphertext in `accounts.access_token_enc`. Key is `TOKEN_ENCRYPTION_KEY` (32 random bytes, base64).
- Password hashing: PBKDF2-HMAC-SHA256 via `crypto.subtle.deriveBits`, **12,000** iterations (spec asked for 600,000; that exceeds Free-plan CPU and 500s on first password save), 16-byte random salt. Not scrypt. Hash and salt live in `system`. Do not set `[limits] cpu_ms` — Cloudflare rejects that on the Free plan.
- Session cookie: HMAC-signed, HttpOnly, SameSite=Strict, 30-day expiry. CSRF token is inside the session; mutating admin POSTs must send it.

## What it does

1. Meta POSTs a signed webhook when someone comments on a connected post.
2. The Worker verifies the signature, routes on `entry.id` to an account, matches comment text against that account’s rules.
3. On a match it sends **one** DM via Private Replies (`recipient.comment_id`, not the commenter’s user id) and optionally a public reply on the comment.
4. Everything is logged. The operator manages accounts and rules in `/a/:secret`.

Follow-up DMs are out of scope. They need the person to reply first (24h window) or App Review for the 7-day human-agent extension. One DM, everything in it.

## Hard constraints (Meta)

- **Self-comment guard:** never act when `from.id === account.ig_user_id`. Webhooks include the operator’s own comments. Implemented in `src/guard.ts` `isSelfComment`, called before any send/dedupe work besides looking up the account. Unit-tested in `scripts/test-unit.ts`.
- **One private reply per comment, ever.** Meta rejects the second attempt. Dedupe anyway.
- **At-least-once delivery.** Duplicate POSTs are normal. Dedupe is `INSERT … ON CONFLICT DO NOTHING` on `sent.comment_id`; if `meta.changes` is 0, stop. Claim a `pending` row first, then `UPDATE` the outcome. No SELECT-then-INSERT.
- **Private reply only works for comments ≤ 7 days old.** Skip older; do not call Meta.
- **Verify every POST** against `X-Hub-Signature-256` using the **raw body text**, before `JSON.parse`. Re-serializing breaks HMAC. 401 on mismatch.
- **Long-lived tokens expire in 60 days.** Unrefreshed tokens die permanently. Refresh requires the token to be ≥ 24h old and not yet expired.
- **~200 calls per account per hour.** No tight retry loops. 5xx and 429: exponential backoff, 3 attempts, jittered. Other 4xx: never retry; log the body verbatim.

## Routes

| Method | Path | Role |
|---|---|---|
| GET | `/` | `ok` — deploy smoke check |
| GET | `/webhook` | Meta verify handshake. Right `hub.verify_token` → echo `hub.challenge`. Wrong → 403. |
| POST | `/webhook` | Verify signature, return **200 immediately**, process in `waitUntil`. |
| GET | `/connect` | Instagram Business Login. Also the reconnect path (`?reconnect=1` forces re-auth). |
| GET | `/connect/callback` | Code → short-lived → long-lived token, fetch `user_id`/`username`, encrypt, **upsert** account. |
| GET/POST | `/a/:secret/*` | Admin. `:secret` is `ADMIN_URL_SECRET` (32-char). Wrong secret → 404. |

Admin pages (password + CSRF on POSTs): `/` dashboard, `/rules`, `/test` (dry run, sends nothing), `/accounts`, first-run `/setup`, `/login`, `/logout`, `POST /run-cron`.

Unlisted, session-gated, used by `scripts/selftest.ts`:

- `POST /a/:secret/selftest/seed`
- `GET /a/:secret/selftest/status`

## Processing pipeline (each comment change)

`field === "comments"` only. Instagram Login sometimes puts `field`/`value` on the entry instead of `changes[]`; both shapes are handled.

1. Look up account by `entry.id`. Unknown or inactive → drop silently.
2. Self-comment guard. Stop, no `sent` row.
3. Age check. Older than 7 days → claim `sent` as `skipped`, stop.
4. Atomic claim: `INSERT INTO sent … ON CONFLICT DO NOTHING`. `changes === 0` → already handled, stop.
5. Active rules. `media_id` set → that post only; `NULL` → all posts. Media-scoped rules win. First match wins.
6. Normalize comment: lowercase, strip emoji, strip punctuation, collapse whitespace.
7. Word-boundary regex per keyword (metacharacters escaped). Keywords under 3 characters are rejected at **save** time in admin, not here.
8. Decrypt token.
9. `POST https://graph.instagram.com/v23.0/{ig_user_id}/messages` with `{ recipient: { comment_id }, message: { text } }`.
10. If `public_reply_text`, `POST /{comment-id}/replies`.
11. `UPDATE sent` with both outcomes (`ok` / `failed` / `skipped`).

## Token refresh (cron `0 3 * * *`)

Cloudflare cron has **no retries**. A missed tick is gone until tomorrow.

1. Select accounts with `token_expires_at < now + 10 days` (about ten chances if a run is missed).
2. Skip tokens younger than 24h (`last_refreshed_at` or `connected_at`).
3. `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=…`
4. Success: re-encrypt, update `token_expires_at` and `last_refreshed_at`, clear `needs_reconnect`.
5. Failure with < 14 days left: set `needs_reconnect`. Admin shows a red banner with Reconnect → `/connect`.
6. On a clean run (whether or not there was work), write `last_cron_ok_at`. Admin banners if that is > 72h stale.

Idempotent: running five times in a day is harmless.

## Admin auth

Mounted at `/a/:secret`. The unguessable URL is a layer, not the auth.

- First visit: create password (PBKDF2). No email reset. Recovery: delete `admin_password_hash` / `admin_password_salt` via `wrangler d1 execute` (see README).
- Signed session cookie, 30 days.
- CSRF on every mutating form, including logout.

Keyword save error (exact): `Keywords under 3 characters match inside other words — 'AI' would fire on 'again' and 'email'.`

DM text: live character count vs 1,000; server rejects above that.

## Selftest

`scripts/selftest.ts` against a deployed or `wrangler dev` URL. `scripts/test-unit.ts` covers the guard, matching, and HMAC verify without a network.

Live checks: handshake 200, wrong verify token 403, bad signature 401, synthetic comment creates one `sent` row, duplicate delivery still one row, self-comment creates no row, admin login page + wrong password rejected, cron writes `last_cron_ok_at`.

## Intentional deviations from the original spec sheet

- `accounts.needs_reconnect` column (required by cron + banner).
- `CREATE … IF NOT EXISTS` so re-running the migration is harmless.
- Transient `dm_status = 'pending'` on the claim row, then updated.
- Graph version kept at **v23.0** as specified. Current Meta docs show v26.0; bump `GRAPH_VERSION` in `src/meta.ts` if calls start failing.
- Instagram Login webhook flattening (`field`/`value` on entry).
- Hono `{ strict: false }`.
- No `[limits] cpu_ms` in `wrangler.toml` — paid Workers only; Free deploy rejects it.
- PBKDF2 iterations **12,000** instead of 600,000 so first-time password setup fits Free-plan CPU.
- Unlisted selftest admin endpoints.
- First-run password setup; there is no `ADMIN_PASSWORD` Worker secret.
