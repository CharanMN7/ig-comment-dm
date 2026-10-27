---
name: setup
description: Walk someone through deploying their own copy of ig-comment-dm, from a fresh clone to a first DM. Covers prerequisites, the Meta developer app (optionally clicked through with Claude in Chrome), npm run setup, connecting an Instagram account, a first rule, and checking /health and npm run doctor. Use when the user says "set this up", "deploy this", "install it for me", or asks for help with the Meta app or Cloudflare setup. Not for local development or code changes; AGENTS.md covers those.
---

# Set up ig-comment-dm

You're helping someone run their own copy of this Instagram comment-to-DM tool on their own
Cloudflare account. The manual guide is `site/content/docs/setup.mdx`, and
`site/content/docs/agent-setup.mdx` says who does what. Read both before you start. Follow
the guide; don't improvise steps it doesn't have.

## Rules that hold for the whole session

- **The human logs in.** Cloudflare, Facebook, Instagram, 2FA prompts and CAPTCHAs are
  theirs. When you reach one, stop and hand over.
- **No secret ever enters this chat.** That covers the Instagram App Secret, the Facebook App
  Secret, the webhook verify token, the admin URL (it contains `ADMIN_URL_SECRET`), the admin
  password, and any access token. Never ask for one, type one, repeat one or read one off a
  page. Never click **Show** next to a secret. If a secret is visible on screen, don't
  screenshot or read that page: ask the human to hide it first.
- **`npm run setup` runs in the human's own terminal**, outside Claude Code, and not through
  the `!` prefix either. It prompts for the Meta values, generates and stores the other
  secrets itself, and its last screen prints the admin URL and the verify token. Never
  generate secrets, run `npm run keys`, or run `wrangler secret put` yourself.
- **Ask before every grant.** Adding an Instagram Tester, flipping a Webhook subscription
  toggle, clicking Generate token, publishing the app: say what you're about to click and
  wait for a yes. **Publish**, Cloudflare's **Allow** and Instagram's **Allow** are the
  human's own clicks. Never submit the app for App Review. Testers don't need it, and if
  the human wants it anyway, it's theirs to submit.
- **Never create an account for them**: Cloudflare, Meta for Developers, Facebook, Instagram,
  or a Meta business portfolio if the create-app flow offers one.
- **When a Meta screen doesn't match the guide, stop and ask.** Meta renames screens often.
  Never substitute **Facebook Login → Valid OAuth Redirect URIs** for the Instagram settings:
  it's a different product.

If a secret does land in the chat, tell the human to rotate it. For an app secret, they
reset it in Meta's dashboard first. Then, in their own terminal, they run
`npx wrangler secret put <NAME>` and `npx wrangler deploy`. The docs page on
[rotating a secret](https://charanmn7.github.io/ig-comment-dm/docs/security/#rotating-a-secret)
has the details.

## Browser or words

With the Claude in Chrome tools (`mcp__claude-in-chrome__*`), you can click through Meta's
dashboard yourself in a tab of your own. Without them, describe each screen and let the
human click, or suggest they restart with `claude --chrome` and check `/chrome`. The site
approvals: developers.facebook.com can be allowed for the session, but approve actions on
instagram.com and dash.cloudflare.com one at a time, because they touch real accounts.

## 1. Check the starting point

- Confirm you're in the repo root (`package.json` has `"name": "ig-comment-dm"`). If not,
  clone `https://github.com/CharanMN7/ig-comment-dm.git` and work in it.
- Check `node --version` is 22.13 or newer. Anything older and `npm ci` stops with
  "Unsupported engine": the human upgrades Node.js first (22 or 24 LTS).
- Run `npm ci`.
- Ask the human to confirm they have an Instagram **professional** account (Creator or
  Business), a free Cloudflare account and a Meta for Developers account. If one is missing,
  they create it. Switching Instagram to professional is in the Instagram app:
  Settings → Account type and tools.
- Ask which Instagram usernames they'll connect. Usernames aren't secret.
- Ask how far they've got. Setup is safe to re-run, and if they've already deployed,
  `npm run doctor` shows what's left.

## 2. Create the Meta app (guide Part 1)

At [developers.facebook.com/apps](https://developers.facebook.com/apps/): **Create app**,
use case **Other**, app type **Business**, a name like `Comment to DM`. Then add the
**Instagram** product and open **Instagram → API setup with Instagram login**.

Show the human where the three values are, then wait. Don't reveal them:

- **Instagram App ID**: Business login settings on that page. Not the number at the top of
  the dashboard, which is the Facebook App ID and makes Connect fail with
  **Invalid redirect_uri**.
- **Instagram App Secret**: the same page.
- **Facebook App Secret**: **App settings → Basic → App secret**. A different value, and the
  one Meta signs live comment notifications with.

Leave the app in Development for now. It's published in step 6.

## 3. Add Instagram Testers (guide Part 2)

For each username: **App roles → Roles → Add people → Instagram Tester** (not Developer, not
Tester). Confirm before adding each one. Then the human accepts the invite at
[instagram.com/accounts/manage_access](https://www.instagram.com/accounts/manage_access/)
→ **Tester invites**, logged in as that account. Skip that and Connect fails with
**Insufficient developer role**.

## 4. Deploy (guide Part 3)

Tell the human to run these in their own terminal, from the repo folder:

```bash
npx wrangler login
npm run setup
```

Tell them what to expect before they start. The first deploy creates the D1 database from
the name in `wrangler.toml`, without asking. The script asks for the three Meta values from
step 2, pasted straight from Meta's page. At the end it prints the values to paste into Meta
and the admin URL, once. A password manager or private note should be open for those.

Ask them for the **Worker URL** only (`https://ig-comment-dm.<name>.workers.dev`). It's
public. If the script stops, ask what the last lines said, without secrets, and check them
against [Troubleshooting](https://charanmn7.github.io/ig-comment-dm/docs/troubleshooting/)
and the guide's "Deploying by hand" section.

Then the human opens the admin URL in their own browser and creates a password on the first
visit. There's no reset email. Don't open the admin URL yourself, and don't read it from a tab.

## 5. Point Meta at the Worker (guide Part 4)

With the Worker URL, under **Instagram → API setup with Instagram login**:

1. **3. Set up Instagram business login → Set up**. In the Redirect URL popup, enter
   `<worker-url>/connect/callback` and save.
2. **Business login settings → OAuth redirect URIs**: add both `<worker-url>/connect/callback`
   and `<worker-url>/connect/callback/`. Meta needs an exact match and sometimes adds the
   slash itself.
3. **Configure webhooks**: set the callback URL to `<worker-url>/webhook`. Leave **Verify
   token** empty. The human pastes the token that `npm run setup` printed and clicks save.
   If the token is still showing in the field afterwards, don't look at the page; talk them
   through the rest of this step instead.
4. Subscribe to the **comments** field with **Include values** on. The other fields can stay off.
5. **Generate access tokens**: for each account, the human adds it with **Add Instagram
   account** if it's missing (that's an Instagram login). Then turn **Webhook subscription**
   **On**, after confirming. Don't click **Generate token** unless Meta won't flip the switch
   without it, and never copy the token it shows: Connect stores its own.

If verification fails, either the Worker isn't deployed or the verify token doesn't match.

## 6. Publish (guide Part 5)

Open **Publish** in Meta's sidebar and fill in the three legal pages the Worker already
serves: `<worker-url>/privacy`, `<worker-url>/terms` and `<worker-url>/data-deletion`. Then
stop: the human clicks **Publish**. Until the app is Live, Meta delivers only the dashboard's
**Test** button, never real comments.

## 7. Connect an account and write a first rule (guide Part 6)

All of this happens in the human's own admin tab. Describe it; don't drive it.

1. **Accounts → Connect a new account**, then **Allow** on Instagram's screen. Connecting
   needs a logged-in admin session, so opening `/connect` on its own just says to start from
   the admin page. Instagram connects whichever account that browser is logged into. If the
   wrong one connects, use a private window.
2. **Rules → New rule**: a keyword such as `guide` and the DM to send. The
   [Using it](https://charanmn7.github.io/ig-comment-dm/docs/using/#write-a-rule) page
   explains every field.
3. **Test**: paste a sample comment and check the right rule lights up. It sends nothing.

## 8. Verify

Run these yourself. Neither touches a secret.

- `curl -sS <worker-url>/health`. `"ok": true` with `"database": "ok"` is healthy, and
  `accounts.active` should count the connected accounts. On a new deploy, `"cron"` and
  `"poll"` say `"starting"`, which is fine. On a 503, see
  [/health answers 503](https://charanmn7.github.io/ig-comment-dm/docs/troubleshooting/#health-answers-503).
- `npm run doctor`. It checks the Cloudflare login, which secrets exist (names, never values),
  the tables, connected accounts, active rules, rejected webhooks and the cron jobs. Explain
  each ✗ and `!` and its fix. It can't see whether the Meta app is Live, or whether Hidden
  Words is hiding comments.

Last, the live test. The human comments the keyword on their own post from a **different**
Instagram account, because their own comments are ignored on purpose. Hidden Words should be
off while testing. On the admin **Home** page, **Did Instagram reach us?** shows whether Meta
called the webhook (**Wrong secret** means `FACEBOOK_APP_SECRET` is wrong or missing), and
**Last 20 sends** shows the DM. The Worker also polls recent comments every 5 minutes. For
anything else, start from
[Troubleshooting](https://charanmn7.github.io/ig-comment-dm/docs/troubleshooting/).
