# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private reporting instead:
[**Report a vulnerability**](https://github.com/CharanMN7/ig-comment-dm/security/advisories/new)

If that is unavailable to you, email `charanxmn@gmail.com` with `[ig-comment-dm security]`
in the subject line.

Please include: what you found, the steps to reproduce it, and what an attacker
gains. A proof of concept against **your own** deployment is welcome. Do not test
against someone else's Worker.

You will get an acknowledgement within 72 hours and a fix or a decision within 14
days. Credit in the release notes if you want it.

## Scope

This is **self-hosted software**. Every deployment is a separate Cloudflare Worker
owned by whoever deployed it. There is no hosted service, no shared database, and
no vendor with access to your data.

**In scope:** anything in this repository — the Worker source, the migrations, the
setup scripts, the CI workflows, and the documentation where it tells you to do
something unsafe.

**Out of scope:** Meta's Graph API, Cloudflare's platform, and misconfiguration of
a deployment you control (for example, publishing your own admin URL).

## Threat model

The admin panel is on the public internet. It is protected by two independent
factors:

1. **A secret path segment.** The panel lives at `/a/<ADMIN_URL_SECRET>`, where the
   secret is 32 hex characters (128 bits). Every other path returns `404`, so the
   panel is not discoverable by crawling.
2. **A password**, chosen on first visit, stored as a PBKDF2-SHA256 hash with a
   random 16-byte salt.

Sessions are stateless cookies signed with HMAC-SHA256 (`SESSION_SIGNING_KEY`),
marked `HttpOnly`, `SameSite=Strict`, and `Secure` on HTTPS. Every mutating form
carries a CSRF token bound to the session. The signature also covers the
password's salt and a logout counter, so logging out ends every session on every
device, and setting a new password ends every session from before it.

Logins are rate limited in D1. Five wrong passwords are free; after that each wait
doubles from one minute, up to an hour. Each attempt is counted before its password
is checked, so guesses sent in parallel get no more tries than guesses sent one at a
time. The limit is shared by every browser rather than tracked per IP, so someone
guessing locks you out too, but only someone who already has the secret URL can try.

Connecting an Instagram account needs the same logged-in session. The OAuth
`state` is signed, expires after 10 minutes, and only completes in the browser
that started it, which holds a matching short-lived cookie. The callback shows
Instagram's error text only in that browser; anyone else opening the same link
gets a fixed message, so the page can't be made to show someone else's words.

### Webhooks

Every POST to `/webhook` is checked against `X-Hub-Signature-256` over the raw body
before it is parsed. A body declared or found to be over 256 KB gets a `413` before
the rest is read. A POST with no signature writes nothing, and a wrong signature is
logged at most once a minute, so a flood of forged requests can't use up D1's daily
writes and stop real sends.

### The code and its pipeline

- One runtime dependency (`hono`), and no client-side JavaScript: the CSP is
  `default-src 'none'` with no `script-src`.
- Every GitHub Action is pinned to a commit SHA, with its version in a comment.
  Dependabot keeps the pins and the npm packages current.
- `npm run selftest` requires `ADMIN_PASSWORD`. It creates a first password only on
  `localhost` unless `--allow-setup` is passed, so it never leaves a known password
  on a deployed Worker, and it deletes its fake account when it finishes.

### Installing the panel on a phone

A phone fetches the web app manifest and its icons without cookies, so four paths
under the admin URL answer without the password: `manifest.webmanifest`,
`icon.svg`, `icon-192.png` and `icon-512.png`. They still need the secret path
(anything else under it still needs the password), are sent `no-store`, and hold
only the app's name, colours and icon.

Installing on Android sends the manifest, and with it your admin URL (the
manifest's `start_url`), to Google's WebAPK service, which builds the app Android
installs. Google then has the URL. The password still protects the panel, so this
is the same exposure as any leaked admin URL (see below). If you would rather
Google never sees it, use a bookmark instead of installing.

### What is encrypted

Instagram access tokens are encrypted at rest with **AES-256-GCM** using
`TOKEN_ENCRYPTION_KEY`, with a fresh random 12-byte IV per token. The key lives in
Cloudflare's secret store, never in D1 and never in the repository. Losing the key
means every account must reconnect; leaking it means every stored token is exposed.

### What is deliberately not defended against

- **An attacker with your Cloudflare account.** They can read every secret. Protect
  that account with a hardware key.
- **A leaked admin URL plus a weak password.** The path secret is a filter, not a
  substitute for a real password. Use a generated one.
- **Traffic analysis of Meta's webhooks.** Signature verification proves the sender
  knows an app secret; it does not hide that a request happened.

### Known, accepted weaknesses

| Item | Why it is this way |
|---|---|
| PBKDF2 at 12,000 iterations, not 600,000 | Workers' free tier caps CPU per request. 600k reliably 500s the first password save. 12k + a 128-bit secret path is the trade the free tier forces. Raise `PBKDF2_ITERATIONS` in `src/crypto.ts` if you are on a paid plan — existing hashes keep working only if you also reset the password. |
| `ADMIN_URL_SECRET` appears in the URL | It has to, to gate the panel before any DB read. Mitigated by `Referrer-Policy: no-referrer` on every admin response, so clicking an outbound link never leaks it. Still: do not paste the URL into a chat, a screenshot, or a bug report. |
| Webhook signatures accepted from either app secret | Meta signs Instagram Login webhooks with the Instagram App Secret in some flows and the Facebook App Secret in others. Both are yours; accepting either is not a downgrade. |

## Secret inventory

Everything the Worker needs, where it comes from, and what it costs you if it leaks.

| Secret | Origin | If leaked |
|---|---|---|
| `META_APP_ID` | Meta dashboard | Public by design — it is sent to Instagram in the OAuth URL. |
| `META_APP_SECRET` | Meta dashboard | Rotate in Meta immediately. Allows forging webhooks and token exchanges. |
| `FACEBOOK_APP_SECRET` | Meta dashboard | Same as above. |
| `WEBHOOK_VERIFY_TOKEN` | You generate | Low impact — used once, during webhook setup. Rotate anyway. |
| `TOKEN_ENCRYPTION_KEY` | You generate | **Critical.** Decrypts every stored Instagram token. Rotate, then reconnect every account. |
| `SESSION_SIGNING_KEY` | You generate | **Critical.** Allows forging an authenticated admin session. Rotate immediately. |
| `ADMIN_URL_SECRET` | You generate | Reveals the panel URL. Rotate, redeploy, re-bookmark. |
| `PUBLIC_BASE_URL` | Your Worker URL | Not a secret. |

None of these ever leave your Cloudflare account. They are not in the repository,
not in D1, and not in any log line this Worker writes.

## Rotating a secret

```bash
npx wrangler secret put SESSION_SIGNING_KEY   # paste the new value
npx wrangler deploy
```

Rotating `SESSION_SIGNING_KEY` logs everyone out. Rotating `TOKEN_ENCRYPTION_KEY`
makes stored tokens undecryptable — every account shows **Reconnect** on the
Accounts page, which takes about 20 seconds each.

## Supported versions

The latest version on `master` is the only supported one; there are no backports.
`npm run update` brings a copy up to date, and the
[changelog](https://charanmn7.github.io/ig-comment-dm/docs/changelog/) lists security
fixes under each version.
