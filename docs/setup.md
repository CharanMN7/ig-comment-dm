# Setup

This is the full manual walkthrough: every Meta dashboard screen, every secret,
every command. If you just want it done, run:

```bash
npm run setup
```

That one command checks your Cloudflare login, deploys the Worker (which
auto-provisions the D1 database), runs both migrations, asks for the three
secrets that come from Meta, generates the four secrets you don't have to
think about, sets `PUBLIC_BASE_URL`, and deploys again. At the end it prints
the exact OAuth redirect URIs, the webhook callback URL and verify token, the
three legal-page URLs, and your admin URL — the values you still have to
paste into Meta's dashboard by hand, because a script cannot click through
someone else's website for you.

Read this page if you want to understand what each step does, if `npm run
setup` fails partway and you need to finish by hand, or if you're doing the
Meta dashboard parts (Parts 1, 2, 4, 5 below) — nothing automates those.

If your deployment already exists and something's broken, go to
[troubleshooting.md](troubleshooting.md) instead.

---

## Prerequisites

| What | Why |
|---|---|
| An Instagram **professional** account (Creator or Business) | A personal account cannot use the Instagram API. In the Instagram app: Settings → Account type and tools → Switch to professional account. |
| A free [Cloudflare](https://dash.cloudflare.com/sign-up) account | This program runs as a Cloudflare Worker, on your account, at your cost (free tier is enough). |
| A free [Meta for Developers](https://developers.facebook.com/) account | Signed in with the Facebook login that can manage the Instagram account you're automating. |
| [Node.js](https://nodejs.org/) 20 or newer | Runs the setup script, `wrangler`, and the test suite. |

Keep a notes file open. You will generate and paste several secret values.
Do not post those values anywhere public.

---

## Part 1 — Create the Meta app

1. Open [https://developers.facebook.com/apps/](https://developers.facebook.com/apps/).
2. Click **Create app**.
3. If it asks for a use case, pick **Other**, then continue. If it asks for an app type, pick **Business**.
4. Give the app a name you'll recognize, for example `Comment to DM`. Click **Create app**.
5. On the app dashboard, find **Add products** (or **Add use case**) and add **Instagram**.
6. Open **Instagram → API setup with Instagram login** (wording may be "Business login").
7. You'll **Publish** this app later (Part 5). Staying in Development is why live comments never arrive — Meta only delivers the dashboard **Test** button until the app is Live. Testers can usually go Live without App Review. Don't submit App Review unless strangers will connect their own Instagram accounts.

### Copy three values

Still under **Instagram → API setup with Instagram login → Business login settings**:

- Copy **Instagram App ID** → save as `META_APP_ID`
- Click **Show** next to **Instagram App Secret** → save as `META_APP_SECRET`

Then open **App settings → Basic** (left sidebar):

- Click **Show** next to **App secret** → save as `FACEBOOK_APP_SECRET`

These are not your Instagram password. They identify this app to Instagram.

**The number at the top of the Meta dashboard is a different Facebook App
ID.** It is not the Instagram App ID. If you put that number in `META_APP_ID`,
Connect fails with **Invalid redirect_uri**.

`META_APP_SECRET` and `FACEBOOK_APP_SECRET` are **two different secrets**.
Live comment notifications are often signed with the Facebook one. If only
the Instagram secret is stored, Home stays empty even when Meta is actually
POSTing to your webhook.

Do **not** paste the token from **Generate access tokens** into Cloudflare.
Connecting through this program's admin panel already stores a token for
each account. That "Generate access tokens" screen exists for one thing:
turning on the per-account **Webhook subscription** toggle (see Part 4).

### Where every secret comes from

| Secret | Where it comes from |
|---|---|
| `META_APP_ID` | Instagram → API setup with Instagram login → **3. Set up Instagram business login** → **Business login settings** → **Instagram App ID**. Not the ID at the top of the dashboard. |
| `META_APP_SECRET` | Same page → **Instagram App Secret** → Show. Not the Generate token. |
| `FACEBOOK_APP_SECRET` | **App settings → Basic → App secret** → Show. Different from the Instagram App Secret. Required so live comment notifications are accepted. |
| `WEBHOOK_VERIFY_TOKEN` | You make it: `openssl rand -hex 16` (or `npm run keys`). Then type the **same** value into Meta's webhook **Verify token** box. |
| `TOKEN_ENCRYPTION_KEY` | You make it: `openssl rand -base64 32` (or `npm run keys`). Never from Meta. Must decode to exactly 32 bytes. |
| `SESSION_SIGNING_KEY` | You make it: another `openssl rand -base64 32` (or `npm run keys`). Never from Meta. Never reuse the key above. |
| `ADMIN_URL_SECRET` | You make it: `openssl rand -hex 16` (or `npm run keys`). Goes in the admin URL. |
| `PUBLIC_BASE_URL` | Your Worker URL, no trailing slash, e.g. `https://ig-comment-dm.YOURNAME.workers.dev`. |

`npm run keys` prints all four self-generated secrets at the correct size in
one shot, so you never accidentally paste a truncated `openssl` output.

---

## Part 2 — Instagram Tester invites

A Facebook **Admin** role on the app is **not enough**. Each Instagram
username you will Connect must be an **Instagram Tester**, even if that IG
account is yours and even if you've already connected a different one.

For **each** creator account:

1. In the Meta app: **App roles → Roles → Add people**.
2. Choose **Instagram Tester** (not Developer, not Tester).
3. Type that account's Instagram **username**, select it, Add.
4. On a phone or browser **logged into that same Instagram account**, open
   [instagram.com/accounts/manage_access](https://www.instagram.com/accounts/manage_access/)
   → **Tester invites** → **Accept**.

If you skip step 4, Connect fails with **Insufficient developer role**.
Repeat for every extra creator account.

When you click Connect, Instagram must be logged in as the account you just
invited. A different account already logged in on that browser is the usual
reason one profile works and another doesn't — use a private window if
needed.

If Meta refuses to add the username because it already has a role on the
business that owns the app, that's a different block — worth flagging so it
can be worked through separately.

---

## Part 3 — Deploy

### The easy way

```bash
npm install
npx wrangler login
npm run setup
```

`npm run setup` does the rest of this section for you: it deploys once
(which provisions the D1 database), runs both migrations, prompts for the
three Meta secrets from Part 1, generates and stores the four self-issued
secrets, sets `PUBLIC_BASE_URL` to your real Worker URL, and deploys again.
It's safe to re-run — deploys are idempotent, migrations use `IF NOT
EXISTS`, and it leaves existing secrets alone unless you pass `--rotate`.

If it stops partway, the sections below are what it was going to run next.

### Doing it by hand

```bash
cd ig-comment-dm
npm install
npx wrangler login
```

Wrangler auto-provisions the D1 database from the `database_name` in
`wrangler.toml` on your first deploy — there's no `wrangler d1 create` step
and no database ID to copy into a config file. A fresh clone needs zero file
edits before it can deploy.

```bash
npx wrangler deploy
```

Wrangler prints a URL like `https://ig-comment-dm.YOURNAME.workers.dev`.
That's the program.

Do **not** add a `[limits]` / `cpu_ms` block to `wrangler.toml`. That setting
is only for paid Workers; on the Free plan, deploy fails with an error that
CPU limits are not supported.

Create the tables:

```bash
npx wrangler d1 execute ig-comment-dm --remote --file=migrations/001_init.sql
npx wrangler d1 execute ig-comment-dm --remote --file=migrations/002_webhook_events.sql
```

(Both of those are also `npm run db:migrate`.)

Generate the four secrets you issue yourself:

```bash
npm run keys
```

Or manually:

```bash
openssl rand -base64 32    # TOKEN_ENCRYPTION_KEY
openssl rand -base64 32    # SESSION_SIGNING_KEY  (run it again; do not reuse the first)
openssl rand -hex 16       # ADMIN_URL_SECRET     (32 characters)
openssl rand -hex 16       # WEBHOOK_VERIFY_TOKEN
```

Put every secret into Cloudflare. Paste when prompted, then press Enter:

```bash
npx wrangler secret put META_APP_ID
npx wrangler secret put META_APP_SECRET
npx wrangler secret put FACEBOOK_APP_SECRET
npx wrangler secret put WEBHOOK_VERIFY_TOKEN
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put ADMIN_URL_SECRET
npx wrangler secret put SESSION_SIGNING_KEY
npx wrangler secret put PUBLIC_BASE_URL
```

For `PUBLIC_BASE_URL`, you don't have the live URL until after your first
deploy. Use a placeholder like `https://example.com` for now, deploy once,
then set it to the real URL and deploy again. Connect no longer uses this
secret for the Instagram return address — it uses the host you actually
opened — but session cookies still read it.

```bash
npx wrangler secret put PUBLIC_BASE_URL
# paste: https://ig-comment-dm.YOURNAME.workers.dev
# (no trailing slash)

npx wrangler deploy
```

Your admin site is:

```
https://ig-comment-dm.YOURNAME.workers.dev/a/ADMIN_URL_SECRET
```

Replace `ADMIN_URL_SECRET` with the 32-character value you generated.
Bookmark it. Anyone who guesses this URL still needs the password, but don't
share the link.

Open that URL. The first visit asks you to **create a password**. There's no
"forgot password" email. If you forget it, see
[Rotating a secret / forgetting the admin password](#rotating-a-secret--forgetting-the-admin-password)
below.

Run `npm run doctor` at any point after this to confirm the deployment,
secrets, and database are all in a healthy state — see
[troubleshooting.md](troubleshooting.md).

---

## Part 4 — Meta dashboard: redirect URIs and webhooks

Back in the Meta app dashboard.

### Login return address

Meta doesn't show a field named just "oauth". Do this:

1. Left menu: **Instagram → API setup with Instagram login** (wording may be "API setup with Instagram business login").
2. Find **3. Set up Instagram business login** and click **Set up**. A popup asks for a **Redirect URL**.
3. Paste:

   ```
   https://ig-comment-dm.YOURNAME.workers.dev/connect/callback
   ```

4. Save. Then click **Business login settings**.
5. Under **OAuth redirect URIs**, paste **both** lines (also shown on the admin **Accounts** page, or on Connect):

```
https://ig-comment-dm.YOURNAME.workers.dev/connect/callback
https://ig-comment-dm.YOURNAME.workers.dev/connect/callback/
```

Both lines matter — one with the trailing slash, one without. Meta's docs
require an exact match to a listed "base URI", and the dashboard often adds
the trailing slash on its own, so a login that only works from one entry
point is usually missing the other line.

If you only see **Facebook Login → Valid OAuth Redirect URIs**, that's the
wrong screen. Stay on the Instagram product, not Facebook Login — they are
different settings pages even though they sound similar.

Save, then click Connect and continue to Instagram.

If you still see **Invalid redirect_uri**, the usual cause is the Facebook
App ID instead of the **Instagram App ID** (same Business login settings
page).

### Webhook (the comment notifications)

**Instagram → API setup with Instagram login → Configure webhooks**
(sometimes a **Webhooks** item in the left menu).

1. Click **Configure**. Callback URL:

   ```
   https://ig-comment-dm.YOURNAME.workers.dev/webhook
   ```

2. Verify token: paste the `WEBHOOK_VERIFY_TOKEN` you generated.
3. Click **Save**. Subscribe to **comments** (leave **Include values** on). You can turn the other fields off.

If verify fails, the Worker isn't deployed, or `WEBHOOK_VERIFY_TOKEN` doesn't
match what you typed into Meta.

### Turn on webhook subscription per Instagram account (required)

Callback URL setup is not enough on its own. On the same **API setup with
Instagram login** page, find **Generate access tokens**.

For **each** account you connected:

1. If the username is missing, click **Add Instagram account**, log in as that account, finish.
2. On that row, set **Webhook subscription** to **On**. Leave it Off and Instagram will never tell this program about comments.
3. You do **not** have to click **Generate token** for this program, and you must **not** paste that token into Cloudflare. Connecting through the admin panel already saved a token. If Meta won't let you flip the webhook switch until you generate a token, generate it, then flip the switch, and ignore the token string it shows you.

The person who **comments** (a friend testing this) does not need to be in
this list. The account that **owns the post or reel** does.

---

## Part 5 — Publish the app

Real comment notifications are only delivered when the app is **Live**.
Development mode is the usual reason "I set everything up and nothing
happens."

1. After you deploy, these pages exist on your Worker:

   ```
   https://ig-comment-dm.YOURNAME.workers.dev/privacy
   https://ig-comment-dm.YOURNAME.workers.dev/terms
   https://ig-comment-dm.YOURNAME.workers.dev/data-deletion
   ```

2. In the Meta app, open **Publish** in the left sidebar. Paste those three URLs into privacy policy, terms of service, and data deletion.
3. Click **Publish** so the app is Live.
4. Keep your Instagram accounts as **Instagram Testers** and keep **Webhook subscription** On.

You do **not** need App Review if only tester accounts connect. App Review
is for other people's Instagram accounts.

---

## Part 6 — Connect and write your first rule

1. Open your bookmarked admin URL and log in.
2. Go to **Accounts → Connect a new account**. Instagram asks you to allow access. Allow it.
3. Go to **Rules → New rule**.
   - Name, for example `Free guide`.
   - Keywords, one per line, at least 3 letters each (`guide`, not `AI`).
   - The private message (the DM). Keep it under 1,000 characters. Put everything they need in this one message — Instagram will not let you send a follow-up unless they reply first.
   - Optional public reply under the comment.
   - **Which posts:** leave on **All posts and reels**. That includes Reels. A reel ID is a long number (from the dropdown after you connect), not the share link `instagram.com/reel/…`.
4. Go to **Test**. Paste a sample comment. Confirm the right rule lights up. This sends nothing to real people.

Open **Home** once after connecting. In Meta, **Generate access tokens** →
**Webhook subscription** must be **On** for each connected account.

Finish **Part 5 (Publish)** before expecting a friend's comment to fire
instantly. Until the app is Live, Meta only delivers the webhook **Test**
button. This program also checks recent comments every 5 minutes, so a real
comment can still get a DM while you're waiting to Publish.

Then comment on your own post or reel from a **different** Instagram account
(a friend's phone is fine). The friend does **not** need to be an Instagram
Tester. Your own comments on your own posts are ignored on purpose.

The private message lands in that other account's Instagram **inbox**, or in
**Message requests** if they don't follow you.

On **Home**, look at two lists:

- **Did Instagram reach us?** A row here means Meta POSTed to your webhook. **Wrong secret** means add `FACEBOOK_APP_SECRET`. Empty while a friend already commented usually means the app is still in Development, or Hidden Words hid the comment.
- **Last 20 sends** is the DM / skip / fail log.

In the Meta app, the webhook must be subscribed to **comments** with
**Include values** on. Use **Test** next to that field, then **Send to My
Server** — clicking Test alone only previews the sample, it doesn't send
anything. That test should show up under **Did Instagram reach us?**
immediately.

Turn off Instagram **Hidden Words** / comment filters on the creator account
while testing. Filtered comments never reach this program, even when
everything else is correct.

If something here doesn't work, [troubleshooting.md](troubleshooting.md)
walks through each symptom.

---

## Local development

Copy `.dev.vars.example` to `.dev.vars` and fill in the same secrets. Use
`PUBLIC_BASE_URL=http://localhost:8787`.

```bash
npm install
npm run keys                 # generates the four secrets you issue yourself
npx wrangler d1 execute ig-comment-dm --local --file=migrations/001_init.sql
npx wrangler d1 execute ig-comment-dm --local --file=migrations/002_webhook_events.sql
npm run dev
```

(Both migration commands are also `npm run db:migrate:local`.)

In the Meta app, add `http://localhost:8787/connect/callback` as an OAuth
redirect URI if you want to click Connect locally. Webhooks from Instagram
cannot reach localhost; use the curl command below instead.

### Curl: fake a comment webhook

Replace `YOUR_APP_SECRET` and, after you've connected an account,
`YOUR_IG_USER_ID` (the account id stored in the database).

```bash
export META_APP_SECRET='YOUR_APP_SECRET'
BODY='{"object":"instagram","entry":[{"id":"YOUR_IG_USER_ID","time":'"$(date +%s)"',"changes":[{"field":"comments","value":{"id":"TEST_COMMENT_ID_1","text":"guide please","from":{"id":"OTHER_PERSON_ID","username":"someone"},"media":{"id":"MEDIA_ID"}}}]}]}'
SIG="$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$META_APP_SECRET" | awk '{print $NF}')"
curl -sS -D - -o /tmp/webhook-body.txt \
  -X POST 'http://localhost:8787/webhook' \
  -H 'Content-Type: application/json' \
  -H "X-Hub-Signature-256: sha256=${SIG}" \
  --data-binary "$BODY"
```

A `200` with an empty body is success. Instagram retries anything slow; this
program answers immediately and works in the background.

### Unit tests and live selftest

```bash
npm test

ADMIN_URL_SECRET=... WEBHOOK_VERIFY_TOKEN=... META_APP_SECRET=... ADMIN_PASSWORD=... \
  npm run selftest -- http://localhost:8787
```

---

## Rotating a secret / forgetting the admin password

To rotate any secret:

```bash
npx wrangler secret put SESSION_SIGNING_KEY   # paste the new value
npx wrangler deploy
```

Rotating `SESSION_SIGNING_KEY` logs everyone out. Rotating
`TOKEN_ENCRYPTION_KEY` makes every stored token undecryptable — every
account shows **Reconnect** on the Accounts page, about 20 seconds each. See
[SECURITY.md](../SECURITY.md) for the full secret inventory and what leaking
each one costs you.

There is no "forgot password" email for the admin panel. If you forget it,
whoever has Cloudflare access can clear it:

```bash
npx wrangler d1 execute ig-comment-dm --remote --command \
  "DELETE FROM system WHERE key IN ('admin_password_hash','admin_password_salt');"
```

Then open the admin URL and create a new password.
