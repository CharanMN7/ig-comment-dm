# Phase 1 dump

Printed at the end of Phase 1 for Phase 2. Do not summarize — this is the contract.

Operator-facing setup (what to click in Meta, how to generate secrets, curl against localhost) is in [README.md](../README.md), not here.

## 1. Full contents of `migrations/001_init.sql`

```sql
-- SQLite / D1. Timestamps are INTEGER unix epoch seconds.

CREATE TABLE IF NOT EXISTS accounts (
  ig_user_id        TEXT PRIMARY KEY,
  username          TEXT NOT NULL,
  access_token_enc  TEXT NOT NULL,
  token_iv          TEXT NOT NULL,
  token_expires_at  INTEGER NOT NULL,
  active            INTEGER NOT NULL DEFAULT 1,
  connected_at      INTEGER NOT NULL,
  last_refreshed_at INTEGER,
  needs_reconnect   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rules (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ig_user_id        TEXT NOT NULL REFERENCES accounts(ig_user_id) ON DELETE CASCADE,
  label             TEXT NOT NULL,
  keywords          TEXT NOT NULL,
  media_id          TEXT,
  dm_text           TEXT NOT NULL,
  public_reply_text TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sent (
  comment_id   TEXT PRIMARY KEY,
  ig_user_id   TEXT NOT NULL,
  rule_id      INTEGER,
  commenter_id TEXT,
  dm_status    TEXT NOT NULL,
  reply_status TEXT,
  error        TEXT,
  sent_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS system (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_sent_account_time ON sent(ig_user_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_rules_account_active ON rules(ig_user_id, active);
```

`accounts.needs_reconnect` is extra vs the original column list. The nightly job sets it when a refresh fails and fewer than 14 days remain. The home page uses it for the red banner.

## 2. Every Worker secret name, exactly as read in code

```
META_APP_ID
META_APP_SECRET
WEBHOOK_VERIFY_TOKEN
TOKEN_ENCRYPTION_KEY
ADMIN_URL_SECRET
SESSION_SIGNING_KEY
PUBLIC_BASE_URL
```

Never put these in `wrangler.toml`. Local copies go in `.dev.vars` (gitignored). See `.dev.vars.example`.

## 3. Complete `wrangler.toml`

```toml
name = "ig-comment-dm"
main = "src/index.ts"
compatibility_date = "2026-08-14"
# Do not enable nodejs_compat. Web Crypto (crypto.subtle) only.

[limits]
# PBKDF2-HMAC-SHA256 at 600,000 iterations on admin login needs headroom.
cpu_ms = 30000

[[d1_databases]]
binding = "DB"
database_name = "ig-comment-dm"
database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"

[triggers]
crons = ["0 3 * * *"]
```

## 4. Every environment variable or binding referenced anywhere

**Worker bindings / secrets** (from `src/types.ts` `Env`, read as `env.*` / `c.env.*`):

| Name | Kind |
|---|---|
| `DB` | D1 binding |
| `META_APP_ID` | Worker secret |
| `META_APP_SECRET` | Worker secret |
| `WEBHOOK_VERIFY_TOKEN` | Worker secret |
| `TOKEN_ENCRYPTION_KEY` | Worker secret |
| `ADMIN_URL_SECRET` | Worker secret |
| `SESSION_SIGNING_KEY` | Worker secret |
| `PUBLIC_BASE_URL` | Worker secret |

**Not Worker env — `system` table keys:**

```
last_cron_ok_at
admin_password_hash
admin_password_salt
```

**Not Worker env — `scripts/selftest.ts` only:**

```
BASE_URL               (optional; otherwise argv[2] or http://localhost:8787)
WEBHOOK_VERIFY_TOKEN
META_APP_SECRET
ADMIN_URL_SECRET
ADMIN_PASSWORD         (optional; default selftest-password-change-me)
```

**Not env — code constant:** `GRAPH_VERSION = 'v23.0'` in `src/meta.ts`.

## 5. Exact wrangler CLI commands

Create the D1 database:

```bash
npx wrangler d1 create ig-comment-dm
```

Paste the printed `database_id` over `REPLACE_WITH_YOUR_D1_DATABASE_ID` in `wrangler.toml`.

Apply the migration:

```bash
npx wrangler d1 execute ig-comment-dm --remote --file=migrations/001_init.sql
```

Set each secret (paste the value when prompted, Enter):

```bash
npx wrangler secret put META_APP_ID
npx wrangler secret put META_APP_SECRET
npx wrangler secret put WEBHOOK_VERIFY_TOKEN
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put ADMIN_URL_SECRET
npx wrangler secret put SESSION_SIGNING_KEY
npx wrangler secret put PUBLIC_BASE_URL
```

Deploy:

```bash
npx wrangler deploy
```

If `PUBLIC_BASE_URL` was a placeholder on the first deploy, set the real `https://ig-comment-dm.<subdomain>.workers.dev` value (no trailing slash) and deploy again.
