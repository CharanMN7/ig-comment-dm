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
7. You will **Publish** this app later (section 5). Staying in Development is why live comments never arrive: Meta only delivers the dashboard **Test** button until the app is Live. Testers can usually go Live without App Review. Do not submit App Review unless strangers will connect their Instagram.

### Copy three values

Still under **Instagram → API setup with Instagram login → Business login settings**:

- Copy **Instagram App ID** → save as `META_APP_ID`
- Click **Show** next to **Instagram App Secret** → save as `META_APP_SECRET`

Then open **App settings → Basic** (left sidebar):

- Click **Show** next to **App secret** → save as `FACEBOOK_APP_SECRET`

These are not your Instagram password. They identify this app to Instagram.

The number at the **top** of the Meta dashboard is a different Facebook App ID. If you put that in `META_APP_ID`, Connect fails with **Invalid redirect_uri**.

`META_APP_SECRET` and `FACEBOOK_APP_SECRET` are **two different secrets**. Comment notifications are often signed with the Facebook one. If only the Instagram secret is stored, Home stays empty even when Meta POSTs.

Do **not** paste the token from **Generate access tokens** into Cloudflare. Connect already stores a token. That screen is for turning **Webhook subscription** on (see below).

### Where every secret comes from

| Secret | Where it comes from |
|---|---|
| `META_APP_ID` | Instagram → API setup with Instagram login → **3. Set up Instagram business login** → **Business login settings** → **Instagram App ID**. Not the id at the top of the dashboard. |
| `META_APP_SECRET` | Same page → **Instagram App Secret** → Show. Not the Generate token. |
| `FACEBOOK_APP_SECRET` | **App settings → Basic → App secret** → Show. Different from the Instagram App Secret. Required so live comment notifications are accepted. |
| `WEBHOOK_VERIFY_TOKEN` | You make it: `openssl rand -hex 16`. Then type the **same** value into Meta’s webhook **Verify token** box. |
| `TOKEN_ENCRYPTION_KEY` | You make it: `openssl rand -base64 32`. Never from Meta. |
| `SESSION_SIGNING_KEY` | You make it: another `openssl rand -base64 32`. Never from Meta. |
| `ADMIN_URL_SECRET` | You make it: `openssl rand -hex 16`. Goes in the admin URL. |
| `PUBLIC_BASE_URL` | Your Worker URL, no trailing slash, e.g. `https://ig-comment-dm.ig-comment-dm.workers.dev`. |

### Add every Instagram account as a tester (required in Development mode)

A Facebook **Admin** role on the app is not enough. Each Instagram username you will Connect must be an **Instagram Tester**, even if that IG account is yours and even if you already connected a different one.

For **each** creator account:

1. In the Meta app: **App roles → Roles → Add people**.
2. Choose **Instagram Tester** (not Developer, not Tester).
3. Type that account’s Instagram **username**, select it, Add.
4. On a phone or browser **logged into that same Instagram account**, open [instagram.com/accounts/manage_access](https://www.instagram.com/accounts/manage_access/) → **Tester invites** → **Accept**.

If you skip step 4, Connect fails with **Insufficient developer role**. Repeat for every extra creator account.

When you click Connect, Instagram must be logged in as the account you just invited. A different account in that browser is the usual reason one profile works and another does not — use a private window if needed.

If Meta refuses to add the username because it already has a role on the business that owns the app, that is a different block. Say so and we can walk through it.

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
npx wrangler d1 execute ig-comment-dm --remote --file=migrations/002_webhook_events.sql
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
npx wrangler secret put FACEBOOK_APP_SECRET
npx wrangler secret put WEBHOOK_VERIFY_TOKEN
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put ADMIN_URL_SECRET
npx wrangler secret put SESSION_SIGNING_KEY
npx wrangler secret put PUBLIC_BASE_URL
```

For `PUBLIC_BASE_URL`, you do not have the live URL yet. Use a placeholder like `https://example.com` for now, deploy once, then set it to the real URL and deploy again. Connect no longer uses this secret for the Instagram return address (it uses the host you actually opened), but cookies still look at it.

```bash
npx wrangler deploy
```

Wrangler prints a URL like `https://ig-comment-dm.YOURNAME.workers.dev`. That is the program.

Do not add a `[limits]` / `cpu_ms` block to `wrangler.toml`. That setting is only for paid Workers; on the Free plan deploy fails with an error that CPU limits are not supported.

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

Meta does not show a field named just “oauth”. Do this:

1. Left menu: **Instagram → API setup with Instagram login** (wording may be “API setup with Instagram business login”).
2. Find **3. Set up Instagram business login** and click **Set up**. A popup asks for a **Redirect URL**.
3. Paste:

   ```
   https://ig-comment-dm.YOURNAME.workers.dev/connect/callback
   ```

4. Save. Then click **Business login settings**.
5. Under **OAuth redirect URIs**, paste **both** lines shown on the admin **Accounts** page (or on Connect):

```
https://ig-comment-dm.YOURNAME.workers.dev/connect/callback
https://ig-comment-dm.YOURNAME.workers.dev/connect/callback/
```

If you only see Facebook Login → Valid OAuth Redirect URIs, that is the wrong screen. Stay on the Instagram product.

Meta’s docs require an exact match to a listed “base URI”, and the dashboard often adds a trailing slash. Save, then click Connect and continue to Instagram.

If you still see **Invalid redirect_uri**, the usual cause is the Facebook App ID instead of **Instagram App ID** (same Business login settings page).

### Webhook (the comment notifications)

**Instagram → API setup with Instagram login → Configure webhooks** (sometimes a **Webhooks** item in the left menu).

1. Click **Configure**. Callback URL:

   ```
   https://ig-comment-dm.YOURNAME.workers.dev/webhook
   ```

2. Verify token: paste the `WEBHOOK_VERIFY_TOKEN` you generated.
3. Click **Save**. Subscribe to **comments** (leave **Include values** on). You can turn the other fields off.

If verify fails, the Worker is not deployed or `WEBHOOK_VERIFY_TOKEN` does not match what you typed.

### Turn on webhook subscription per Instagram account (required)

Callback URL setup is not enough. On the same **API setup with Instagram login** page, find **Generate access tokens**.

For **each** account you connected (`iam.charan.dev`, `hardware.charan.dev`, …):

1. If the username is missing, click **Add Instagram account**, log in as that account, finish.
2. On that row, set **Webhook subscription** to **On**. Leave it Off and Instagram will never tell this program about comments.
3. You do **not** have to click **Generate token** for this program, and you must **not** paste that token into Cloudflare. Connect already saved a token. If Meta will not let you flip the webhook switch until you generate a token, generate it, then flip the switch, and ignore the token string.

The person who **comments** (a friend) does not need to be in this list. The account that **owns the reel** does.

---

## 4. Connect Instagram and write a rule

1. Open your bookmarked admin URL and log in.
2. Go to **Accounts → Connect a new account**. Instagram asks you to allow access. Allow it.
3. Go to **Rules → New rule**.
   - Name, for example `Free guide`.
   - Keywords, one per line, at least 3 letters each (`guide`, not `AI`).
   - The private message (the DM). Keep it under 1,000 characters. Put everything they need in this one message — Instagram will not let you send a follow-up unless they reply first.
   - Optional public reply under the comment.
   - **Which posts:** leave on **All posts and reels**. That includes Reels. A reel ID is a long number (from the dropdown after you connect), not the share link `instagram.com/reel/…`.
4. Go to **Test**. Paste a sample comment. Confirm the right rule lights up. This sends nothing to real people.

Open **Home** once after connecting. In Meta, **Generate access tokens** → **Webhook subscription** must be **On** for each connected account.

Finish **section 5 (Publish)** before expecting a friend’s comment to fire instantly. Until the app is Live, Meta only delivers the webhook **Test** button. This program also checks recent comments every 5 minutes, so a real comment can still get a DM while you are waiting to Publish.

Then comment on your own post or reel from a **different** Instagram account (a friend’s phone is fine). The friend does **not** need to be an Instagram Tester. Your own comments on your own posts are ignored on purpose.

The private message lands in that other account’s Instagram **inbox**, or in **Message requests** if they do not follow you.

On **Home**, look at two lists:

- **Did Instagram reach us?** A row here means Meta POSTed. **Wrong secret** means add `FACEBOOK_APP_SECRET`. Empty while a friend already commented usually means the app is still in Development, or Hidden Words hid the comment.
- **Last 20 sends** is the DM / skip / fail log.

In the Meta app, the webhook must be subscribed to **comments** with **Include values** on. Use **Test** next to that field, then **Send to My Server** — clicking Test alone only previews the sample. That test should show up under **Did Instagram reach us?** immediately.

Turn off Instagram **Hidden Words** / comment filters on the creator account while testing. Filtered comments never reach this program, even when everything else is correct.

---

## 5. Publish the Meta app (required for live comments)

Real comment notifications are only delivered when the app is **Live**. Development mode is the usual reason “I set everything up and nothing happens.”

1. After you deploy, these pages exist on your Worker:

   ```
   https://ig-comment-dm.YOURNAME.workers.dev/privacy
   https://ig-comment-dm.YOURNAME.workers.dev/terms
   https://ig-comment-dm.YOURNAME.workers.dev/data-deletion
   ```

2. In the Meta app, open **Publish** in the left sidebar. Paste those three URLs into privacy policy, terms of service, and data deletion.
3. Click **Publish** so the app is Live.
4. Keep your Instagram accounts as **Instagram Testers** and keep **Webhook subscription** On.

You do **not** need App Review if only tester accounts connect. App Review is for other people’s Instagram accounts.

---

## Local testing (for the person setting it up)

Copy `.dev.vars.example` to `.dev.vars` and fill in the same secrets. Use `PUBLIC_BASE_URL=http://localhost:8787`.

```bash
npm install
npx wrangler d1 execute ig-comment-dm --local --file=migrations/001_init.sql
npx wrangler d1 execute ig-comment-dm --local --file=migrations/002_webhook_events.sql
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
- **Missed comments.** A second job runs every 5 minutes and looks at recent comments on your posts, in case Instagram never sent a notification. There can be a delay of a few minutes.
- **Forgot admin password:** the person with Cloudflare access can run:

  ```bash
  npx wrangler d1 execute ig-comment-dm --remote --command \
    "DELETE FROM system WHERE key IN ('admin_password_hash','admin_password_salt');"
  ```

  Then open the admin URL and create a new password.

---

## Schema note

`accounts.needs_reconnect` is in `migrations/001_init.sql` even though it was not in the original column list. The nightly job sets it when a refresh fails and fewer than 14 days remain, and the home page uses it for the red banner.

`webhook_events` is in `migrations/002_webhook_events.sql`. Home uses it to show whether Instagram POSTed, including failed signatures.

---

## Changing the Worker

Operator setup is this file. Bindings, schema dump, CLI contract, pipeline, and crypto notes are in [docs/](docs/).
