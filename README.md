# Comment to DM

A small program that lives on Cloudflare. When someone comments on your Instagram post with a keyword you chose, it sends them **one private message** (and, if you want, a public reply under the comment).

You do not need to know how to code. Someone sets this up once. After that you only use the website.

This is **one copy per person**. Your Instagram, your Cloudflare account, your password. There is no signup and no shared dashboard with other people.

---

## What you need before starting

- A computer and about 45 minutes.
- An Instagram **professional** account (Creator or Business). A personal account will not work. In the Instagram app: Settings → Account type and tools → Switch to professional account.
- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account.
- A free [Meta for Developers](https://developers.facebook.com/) account, signed in with the Facebook login that can manage that Instagram account.

Keep a notes file open. You will paste several secret values into it. Do not post those values anywhere public.

---

## 1. Create the Meta app (Instagram’s side)

1. Open [https://developers.facebook.com/apps/](https://developers.facebook.com/apps/).
2. Click **Create app**.
3. If it asks for a use case, pick **Other**, then continue. If it asks for an app type, pick **Business**.
4. Give the app a name you will recognize, for example `Comment to DM`. Click **Create app**.
5. On the app dashboard, find **Add products** (or **Add use case**) and add **Instagram**.
6. Open **Instagram → API setup with Instagram login** (wording may be “Business login”).
7. Stay in **Development** mode. Do not submit the app for review. You are the only person who will use it, and in development mode that is enough as long as your Instagram account is an admin or tester on this app.

### Copy two values

Still under **Instagram → API setup with Instagram login → Business login settings**:

- Copy **Instagram App ID** → save as `META_APP_ID`
- Click **Show** next to **Instagram App Secret** → save as `META_APP_SECRET`

These are not your Instagram password. They identify this app to Instagram.

### Add yourself as a tester if needed

**App roles → Roles**: your Facebook user should be Admin. Under Instagram testers, add the Instagram username you will connect, if the screen asks for it.

---

## 2. Put this program on Cloudflare

Someone technical can do this part. Commands assume they have [Node.js](https://nodejs.org/) installed.

```bash
cd ig-comment-dm
npm install
npx wrangler login
```

Create the database (D1). Cloudflare will print a long **database_id**. Copy it.

```bash
npx wrangler d1 create ig-comment-dm
```

Open `wrangler.toml` and replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` with that id.

Create the tables:

```bash
npx wrangler d1 execute ig-comment-dm --remote --file=migrations/001_init.sql
```

### Generate secrets

In a terminal:

```bash
openssl rand -base64 32    # TOKEN_ENCRYPTION_KEY
openssl rand -base64 32    # SESSION_SIGNING_KEY  (run it again; do not reuse the first)
openssl rand -hex 16       # ADMIN_URL_SECRET     (32 characters)
openssl rand -hex 16       # WEBHOOK_VERIFY_TOKEN
```

Put each secret into Cloudflare. Paste when prompted, then press Enter. Do this for every line:

```bash
npx wrangler secret put META_APP_ID
npx wrangler secret put META_APP_SECRET
npx wrangler secret put WEBHOOK_VERIFY_TOKEN
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put ADMIN_URL_SECRET
npx wrangler secret put SESSION_SIGNING_KEY
npx wrangler secret put PUBLIC_BASE_URL
```

For `PUBLIC_BASE_URL`, you do not have the live URL yet. Use a placeholder like `https://example.com` for now, deploy once, then set it to the real URL and deploy again.

```bash
npx wrangler deploy
```

Wrangler prints a URL like `https://ig-comment-dm.YOURNAME.workers.dev`. That is the program.

Set the real public URL and deploy once more:

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

Replace `ADMIN_URL_SECRET` with the 32-character value you generated. Bookmark it. Anyone who guesses this URL still needs the password, but do not share the link.

Open that URL. The first visit asks you to **create a password**. There is no “forgot password” email. If you forget it, the person who set this up can clear it in the database (see the bottom of this file).

---

## 3. Tell Instagram where to send comments and where to return after login

Back in the Meta app dashboard.

### Login return address

**Instagram → API setup with Instagram login → Business login settings → OAuth redirect URIs**

Click **Add** (or paste into the list) **exactly**:

```
https://ig-comment-dm.YOURNAME.workers.dev/connect/callback
```

No extra slash at the end. Click **Save**.

### Webhook (the comment notifications)

**Instagram → Webhooks** (sometimes under “API setup with Instagram login → Webhooks”).

1. Callback URL:

   ```
   https://ig-comment-dm.YOURNAME.workers.dev/webhook
   ```

2. Verify token: paste the `WEBHOOK_VERIFY_TOKEN` you generated.
3. Click **Verify and save**.
4. Subscribe to the **comments** field. Leave the others off.

If verify fails, the Worker is not deployed or `WEBHOOK_VERIFY_TOKEN` does not match what you typed.

---

## 4. Connect Instagram and write a rule

1. Open your bookmarked admin URL and log in.
2. Go to **Accounts → Connect a new account**. Instagram asks you to allow access. Allow it.
3. Go to **Rules → New rule**.
   - Name, for example `Free guide`.
   - Keywords, one per line, at least 3 letters each (`guide`, not `AI`).
   - The private message (the DM). Keep it under 1,000 characters. Put everything they need in this one message — Instagram will not let you send a follow-up unless they reply first.
   - Optional public reply under the comment.
4. Go to **Test**. Paste a sample comment. Confirm the right rule lights up. This sends nothing to real people.

Then comment on your own post from a **different** Instagram account (a friend’s phone is fine). Your own comments on your own posts are ignored on purpose.

---

## Local testing (for the person setting it up)

Copy `.dev.vars.example` to `.dev.vars` and fill in the same secrets. Use `PUBLIC_BASE_URL=http://localhost:8787`.

```bash
npm install
npx wrangler d1 execute ig-comment-dm --local --file=migrations/001_init.sql
npm run dev
```

In the Meta app, add `http://localhost:8787/connect/callback` as an OAuth redirect URI if you want to click Connect locally. Webhooks from Instagram cannot reach localhost; use the curl command below instead.

### Curl: fake a comment webhook

Replace `YOUR_APP_SECRET` and, after you have connected an account, `YOUR_IG_USER_ID` (the account id stored in the database).

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

A `200` with an empty body is success. Instagram retries anything slow; this program answers immediately and works in the background.

### Unit tests and live selftest

```bash
npm test

ADMIN_URL_SECRET=... WEBHOOK_VERIFY_TOKEN=... META_APP_SECRET=... ADMIN_PASSWORD=... \
  npm run selftest -- http://localhost:8787
```

---

## How this behaves (so nothing surprises you)

- **One private message per comment, ever.** A second attempt is blocked here, and Instagram would reject it anyway.
- **Your own comments are ignored.** Instagram notifies us when you comment on your own post. We drop those.
- **Comments older than 7 days** cannot get a private reply. They are skipped.
- **Instagram tokens last 60 days.** A job runs every night at 03:00 UTC to refresh them. If a token is not refreshed in time it dies permanently and you must click **Reconnect** (about 20 seconds). The home page turns red if that is needed, or if the nightly job has not run in 3 days.
- **Forgot admin password:** the person with Cloudflare access can run:

  ```bash
  npx wrangler d1 execute ig-comment-dm --remote --command \
    "DELETE FROM system WHERE key IN ('admin_password_hash','admin_password_salt');"
  ```

  Then open the admin URL and create a new password.

---

## Schema note

`accounts.needs_reconnect` is in `migrations/001_init.sql` even though it was not in the original column list. The nightly job sets it when a refresh fails and fewer than 14 days remain, and the home page uses it for the red banner.

---

## Changing the Worker

Operator setup is this file. Bindings, schema dump, CLI contract, pipeline, and crypto notes are in [docs/](docs/).
