# Troubleshooting

Start here:

```bash
npm run doctor
```

It checks your live deployment — secrets, database tables, connected accounts,
active rules, rejected webhooks, and whether the scheduled jobs are running —
and names the fix for anything it finds.

Two things it cannot see from outside: whether your Meta app is **Live**, and
whether Instagram's **Hidden Words** filter is eating comments before Meta ever
sees them. Those are the first two things to check if `doctor` comes back clean
and it still does not work.

## Contents

- [The two delivery paths](#the-two-delivery-paths)
- [Nothing happens when someone comments](#nothing-happens-when-someone-comments)
- ["Did Instagram reach us?" is empty](#did-instagram-reach-us-is-empty)
- ["Did Instagram reach us?" says Wrong secret](#did-instagram-reach-us-says-wrong-secret)
- [Invalid redirect_uri](#invalid-redirect_uri)
- [Insufficient developer role](#insufficient-developer-role)
- [Deploy fails on the free plan](#deploy-fails-on-the-free-plan)
- [The admin page shows 404](#the-admin-page-shows-404)
- [Locked out of the admin page](#locked-out-of-the-admin-page)
- [Creating the first password returns a 500](#creating-the-first-password-returns-a-500)
- [The DM failed but the public reply worked](#the-dm-failed-but-the-public-reply-worked)
- [Red banner: an account needs reconnecting](#red-banner-an-account-needs-reconnecting)
- [Red banner: the daily check has not run](#red-banner-the-daily-check-has-not-run)
- [Home shows a table of secrets needing attention](#home-shows-a-table-of-secrets-needing-attention)
- [Reading the logs directly](#reading-the-logs-directly)
- [Still stuck](#still-stuck)

---

## The two delivery paths

Almost every confusing symptom makes sense once you know there are two of them.

| | **The webhook** | **The poll** |
|---|---|---|
| **Speed** | About two seconds | Up to five minutes |
| **How it starts** | Meta POSTs to `/webhook` | The Worker asks Instagram for recent comments |
| **Needs the app to be Live** | Yes | **No** |
| **Sees Hidden Words comments** | No | No |
| **Covers old posts** | Yes | Only the 3 most recent posts, last 72 hours |

They share the same rule matching and the same duplicate protection, so a
comment can never be answered twice regardless of which path finds it.

This explains the two most common confusing reports:

- **"It works, but it takes five minutes."** The webhook is not being delivered.
  The poll is doing all the work. Your app is probably still in Development, or
  the per-account webhook subscription is off.
- **"It worked for my new reel and not my old post."** The poll only looks at
  recent posts. Again: the webhook is not being delivered.

If DMs arrive but slowly, you do not have a matching problem. You have a webhook
problem.

---

## Nothing happens when someone comments

The most common report, and it has eight causes. Work down the list in order —
they are sorted by how often they are the answer.

### 1. The Meta app is still in Development

**By far the most common.** Meta does not deliver real webhooks to an app in
Development mode. It only delivers the dashboard's **Test** button.

**Confirm:** open your app in the Meta dashboard. The mode toggle is at the top.

**Fix:** Meta → **Publish**. Paste your three legal URLs, then click Publish.

```
https://ig-comment-dm.YOURNAME.workers.dev/privacy
https://ig-comment-dm.YOURNAME.workers.dev/terms
https://ig-comment-dm.YOURNAME.workers.dev/data-deletion
```

You do **not** need App Review as long as only your own tester accounts connect.
App Review is for letting strangers connect their Instagram.

### 2. The per-account webhook subscription is off

Setting the callback URL is not enough. Each connected account has its own
toggle, and it defaults to off.

**Fix:** Meta → **Instagram → API setup with Instagram login → Generate access
tokens**. For every account you connected, set **Webhook subscription** to
**On**.

If Meta will not let you flip the switch until you generate a token, generate
it, flip the switch, then ignore the token string. Do not paste it into
Cloudflare — Connect already stored the token this program uses.

### 3. `FACEBOOK_APP_SECRET` is not set

Meta signs live comment notifications with the **Facebook** App Secret, not the
Instagram one. Without it, every real webhook fails signature verification and
is rejected before anything else happens.

**Confirm:** the Home page shows a `Wrong secret` row under "Did Instagram reach
us?", or `npm run doctor` flags it.

**Fix:** Meta → **App settings → Basic → App secret → Show**.

```bash
npx wrangler secret put FACEBOOK_APP_SECRET
npx wrangler deploy
```

### 4. Instagram's Hidden Words filter hid the comment

If Instagram's own spam or keyword filter hides a comment, it never reaches the
API at all. Nothing on this side can see it. This is a limitation, not a bug.

**Fix:** on the creator account, Instagram app → Settings → Hidden Words. Turn
the filters off while testing.

### 5. The comment came from the account that owns the post

Meta notifies you about your own comments on your own posts. Acting on those
would try to DM yourself and burn the single private reply that comment gets, so
they are dropped deliberately.

**Fix:** comment from a different Instagram account. A friend's phone works.
The friend does **not** need to be an Instagram Tester — only the account that
*owns* the post does.

### 6. The comment is more than 7 days old

Instagram refuses a private reply to a comment older than seven days. Those are
logged as skipped with the reason.

### 7. No rule matched

**Confirm:** admin → **Test**, paste the exact comment text, and see which rule
lights up. This sends nothing to anyone.

Matching ignores case, emoji, and punctuation, and matches whole words —
`guide` matches `Guide!` and `guide 🙏` but not `guides`.

> [!NOTE]
> Keywords in Cyrillic, Arabic, Chinese, Japanese, and other non-Latin scripts
> **do not currently match**, and accented keywords only match if the accents
> are typed identically. This is a known bug, not a configuration mistake — see
> [the open issues](https://github.com/CharanMN7/ig-comment-dm/labels/area%3A%20matching).

### 8. The keyword is too short

Keywords under 3 characters are rejected when you save the rule, because they
match inside other words — `AI` would fire on "again" and "email".

---

## "Did Instagram reach us?" is empty

Meta has never POSTed to your Worker. The problem is upstream of this program
entirely, so nothing in the admin panel will help.

In order of likelihood: the app is in Development (see above), the per-account
webhook subscription is off (see above), or the webhook was never configured.

**Confirm the webhook itself works:** in the Meta dashboard, next to the
`comments` field, click **Test**, then **Send to My Server**. Clicking *Test*
alone only previews the sample payload — it sends nothing.

A row should appear under "Did Instagram reach us?" immediately. If it does, your
webhook plumbing is correct and the problem is delivery of *real* events, which
is almost always cause 1 or 2.

If no row appears from the Test button either, re-check the callback URL:

```
https://ig-comment-dm.YOURNAME.workers.dev/webhook
```

and confirm the field is subscribed to **comments** with **Include values** on.

---

## "Did Instagram reach us?" says Wrong secret

Meta reached you, and the request was rejected because the HMAC signature did
not match either app secret.

This is nearly always a missing `FACEBOOK_APP_SECRET` — see cause 3 above.

If it is already set, you have the wrong value. `META_APP_SECRET` and
`FACEBOOK_APP_SECRET` come from **two different screens** and are two different
values:

| Secret | Where |
|---|---|
| `META_APP_SECRET` | Instagram → API setup with Instagram login → Business login settings → **Instagram App Secret** |
| `FACEBOOK_APP_SECRET` | **App settings → Basic → App secret** |

---

## Invalid redirect_uri

Instagram rejected the Connect attempt before showing the permission screen.

**Cause A — the wrong App ID.** The number at the **top** of the Meta dashboard
is the Facebook App ID. You need the **Instagram App ID**, from Instagram → API
setup with Instagram login → Business login settings.

The Connect page prints the App ID this program is actually sending. Compare it
to the dashboard.

```bash
npx wrangler secret put META_APP_ID
npx wrangler deploy
```

**Cause B — the redirect URI is not registered.** Meta requires an exact match,
and its dashboard sometimes appends a trailing slash. Register **both**:

```
https://ig-comment-dm.YOURNAME.workers.dev/connect/callback
https://ig-comment-dm.YOURNAME.workers.dev/connect/callback/
```

Under **Instagram → API setup with Instagram login → Business login settings →
OAuth redirect URIs**. If the screen you are looking at says *Facebook Login →
Valid OAuth Redirect URIs*, that is the wrong product — stay on Instagram.

The exact two lines to paste are printed on the Connect page and on the admin
Accounts page.

---

## Insufficient developer role

The Instagram account you are trying to connect has not accepted a tester
invite. Being a Facebook **Admin** on the app is not enough, and an invite for
one account does not cover another.

For **each** Instagram account, both halves are required:

1. Meta app → **App roles → Roles → Add people → Instagram Tester**. Enter the
   Instagram **username**, select it, Add.
2. **On a browser or phone logged into that same Instagram account**, open
   [instagram.com/accounts/manage_access](https://www.instagram.com/accounts/manage_access/)
   → **Tester invites** → **Accept**.

Step 2 is the one people miss.

**Also check which account the browser is logged into.** When you click Connect,
Instagram uses whatever account that browser is signed in as. One profile working
and another failing is almost always this. Use a private window.

---

## Deploy fails on the free plan

If the error mentions CPU limits, `wrangler.toml` has a `[limits]` / `cpu_ms`
block. That setting is paid-plan only and deploy fails outright on Free. Remove
it.

If the error is about the account not having Workers enabled, open
[dash.cloudflare.com](https://dash.cloudflare.com) and click into Workers once
to activate it, then deploy again.

---

## The admin page shows 404

Every path that is not `/a/<ADMIN_URL_SECRET>` returns 404 by design, so the
panel cannot be found by crawling. A 404 means the secret in your URL does not
match the deployed one.

Usually: a typo, a missing character on paste, a trailing slash difference, or
the secret was rotated by a later `npm run setup -- --rotate`.

**Check what is deployed:**

```bash
npx wrangler secret list
```

That confirms `ADMIN_URL_SECRET` exists but not its value — Cloudflare never
shows a secret again after it is set. If you have lost it, set a new one:

```bash
npm run keys                              # copy the ADMIN_URL_SECRET line
npx wrangler secret put ADMIN_URL_SECRET
npx wrangler deploy
```

Your password and all your data are unaffected. Only the URL changes.

---

## Locked out of the admin page

### Too many wrong passwords

Five attempts are free. The sixth waits a minute, and each further attempt
doubles the wait up to an hour. Waiting it out is the intended fix.

To clear it immediately:

```bash
npx wrangler d1 execute ig-comment-dm --remote --command \
  "UPDATE system SET value = '0' WHERE key IN ('login_fail_count','login_locked_until');"
```

### Forgotten password

There is no password reset email. Anyone with Cloudflare access can clear it:

```bash
npx wrangler d1 execute ig-comment-dm --remote --command \
  "DELETE FROM system WHERE key IN ('admin_password_hash','admin_password_salt');"
```

Then open your admin URL. It will ask you to create a new password. Connected
accounts and rules are untouched.

---

## Creating the first password returns a 500

Two causes, and the error page names which.

**"A Worker secret is the wrong size."** `TOKEN_ENCRYPTION_KEY` and
`SESSION_SIGNING_KEY` must each decode to exactly 32 bytes. A truncated paste
looks fine and fails here.

```bash
npm run keys
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put SESSION_SIGNING_KEY
npx wrangler deploy
```

**"The database tables are missing."** The migrations never ran.

```bash
npm run db:migrate
```

---

## The DM failed but the public reply worked

They are separate API calls and either can fail on its own. The **Last 20 sends**
row shows the exact error from Meta for each.

Common DM failures:

| Error mentions | What it means |
|---|---|
| a closed messaging window | The comment is older than 7 days |
| the reply was already sent | Instagram allows one private reply per comment, ever |
| permissions or scope | The token predates a scope change — click **Reconnect** |
| rate limit | You are near Meta's cap of 750 private replies per hour |

If the DM says it succeeded but the recipient sees nothing, check their
**Message requests** folder. Instagram files DMs there when the recipient does
not follow you.

---

## Red banner: an account needs reconnecting

Instagram tokens last 60 days. A nightly job refreshes them, but a token that
went too long without a refresh dies permanently.

**Fix:** admin → **Accounts → Reconnect**. It takes about 20 seconds and nothing
is lost — rules and history stay.

If this keeps happening, the nightly job is not running. See the next section.

---

## Red banner: the daily check has not run

The nightly token refresh has not succeeded in over 3 days. Left alone, tokens
will eventually expire and every account will need a manual reconnect.

**Confirm the cron triggers are registered:**

```bash
npx wrangler deployments list
```

`wrangler.toml` should contain:

```toml
[triggers]
crons = ["0 3 * * *", "*/5 * * * *"]
```

If it does, redeploy — cron triggers are registered at deploy time, and a deploy
from an older config can drop them.

```bash
npx wrangler deploy
```

**Run it by hand right now** from the admin Home page ("Run the daily check"), or
watch for the next scheduled run.

---

## Home shows a table of secrets needing attention

The Worker checks the shape of all eight secrets on every visit to Home. The
table names the secret, what is wrong, and the command that fixes it. It catches:

- a secret that is not set at all
- a key that does not decode to 32 bytes
- `TOKEN_ENCRYPTION_KEY` and `SESSION_SIGNING_KEY` set to the same value, which
  turns one leak into two
- an `ADMIN_URL_SECRET` shorter than 24 characters
- a `PUBLIC_BASE_URL` with a trailing slash or no `https://`
- a missing `FACEBOOK_APP_SECRET`

Every one of these otherwise fails later and somewhere unrelated. Fix them, run
`npx wrangler deploy`, and reload.

---

## Reading the logs directly

**Live Worker logs:**

```bash
npx wrangler tail
```

Leave it running, reproduce the problem, and watch. Nothing secret is ever
logged — account ids appear, tokens and keys never do — so this output is safe
to paste into an issue.

**What Instagram actually sent:**

```bash
npx wrangler d1 execute ig-comment-dm --remote --command \
  "SELECT received_at, status, object, error FROM webhook_events ORDER BY received_at DESC LIMIT 20;"
```

**Why a specific comment was skipped:**

```bash
npx wrangler d1 execute ig-comment-dm --remote --command \
  "SELECT comment_id, dm_status, reply_status, error, sent_at FROM sent ORDER BY sent_at DESC LIMIT 20;"
```

---

## Still stuck

[Open an issue](https://github.com/CharanMN7/ig-comment-dm/issues/new/choose).
The bug template asks for the things that make a report solvable.

**Redact before you paste.** Replace your admin secret with `/a/REDACTED`, and
never include an access token, an app secret, or the contents of `.dev.vars`.
Worker log output and the SQL queries above are safe.

Found a security problem? Do not open a public issue — see
[SECURITY.md](../SECURITY.md).
