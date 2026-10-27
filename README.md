# Comment to DM

Self-hosted Instagram comment-to-DM automation. One Cloudflare Worker and one D1 database on your own account, on the free plan.

[![CI](https://img.shields.io/github/actions/workflow/status/CharanMN7/ig-comment-dm/ci.yml?branch=master&label=CI)](https://github.com/CharanMN7/ig-comment-dm/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/github/license/CharanMN7/ig-comment-dm)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/CharanMN7/ig-comment-dm)](https://github.com/CharanMN7/ig-comment-dm/stargazers)

**[Docs](https://charanmn7.github.io/ig-comment-dm/docs/) · [Quick start](#quick-start) · [Contributing](CONTRIBUTING.md)**

## What it does

Your reel says "comment GUIDE for the link". Someone comments `guide`, and about two seconds later your link is in their DMs, sent from your account, with an optional public reply under the comment. You set it up as keyword rules in an admin panel on your Worker.

- Rules cover one post or all of them, and match whole words or anywhere in the comment, for hashtags like `#launch2026`.
- Exclusions per rule, so "how much is the guide?" doesn't use up that comment's one DM.
- Reply to every comment on one post, no keyword needed, for giveaways and waitlists.
- `{username}` in the DM or public reply, and several public replies picked at random so the thread doesn't look automated.
- Any script works. Case, emoji, punctuation and Latin accents are ignored: `preco` matches `PREÇO`.
- Eight templates (free guide, price list, giveaway entry and five more) fill in a rule's keywords, DM and public replies. A template won't save until your own link replaces its placeholder.
- Several Instagram accounts per deployment, and an admin panel you can install on your phone.

## How it's done today

Hosted tools charge $15 to $99 a month. They hold an access token to your Instagram account on their servers next to every other customer's, your followers' messages pass through them, and the automation lasts as long as the company does. The alternative is replying by hand, which stops working the day a reel takes off.

## What's different

The same automation runs in your Cloudflare account instead, on Meta's official Instagram API through Instagram Login. There's no scraping and no browser automation, and the Worker never sees your password.

```
someone comments "guide"
          │
          ▼
Meta webhook (signed) ───▶ your Worker ◀─── poll every 5 minutes
                                │
                 claim the comment in D1, match your rules
                                │
                                ▼
          one private DM, then an optional public reply
```

There are two ways in because Instagram silently drops webhooks for collapsed and low-signal comments. Every five minutes the Worker reads the last 72 hours of comments on up to 3 posts per account and answers up to 10 per run that the webhook missed. Both paths claim the comment with `INSERT … ON CONFLICT DO NOTHING` before sending, so a duplicate delivery can't produce a second DM.

The whole thing is about 5,000 lines of TypeScript, with one runtime dependency (`hono`) and no client-side JavaScript. Instagram tokens are encrypted with AES-256-GCM under a key that exists only in your Cloudflare account.

## Who it's for

Creators and small businesses who run "comment X for the link" posts and would rather not pay $180 to $1,188 a year, or give a third party a token to their account. Setup is five terminal commands and a screen-by-screen guide through Meta's dashboard.

## What can go wrong

- **Professional accounts only.** Instagram's API doesn't work with personal accounts. Switching to Creator or Business takes a minute in the app.
- **Your Meta app has to be Live.** In Development mode Meta sends no real comment webhooks, so only the five-minute poll works. Publishing needs no App Review while only your own accounts connect as Instagram Testers. Letting strangers connect theirs would need App Review; this is built for one person and their own accounts.
- **One private reply per comment, ever, within 7 days.** No follow-up unless they reply to you. Older comments are skipped.
- **About 750 private replies per hour per account**, Meta's cap. Nothing queues sends past it yet ([#35](https://github.com/CharanMN7/ig-comment-dm/issues/35)), so on a viral reel the overflow fails, is logged and isn't retried.
- **Meta changes things.** It renames dashboard screens, retires OAuth hosts and changes which secret signs webhooks. The code pins Graph API v23.0, which Meta will eventually retire.
- **Blind spots.** Comments hidden by Instagram's Hidden Words filter never reach the API. DMs to non-followers land in Message requests. Posts outside the poll's 3 rely on the webhook alone.
- **60-day tokens.** A nightly job refreshes them. If it stops, `/health` turns 503 before they expire; a lapsed account needs a 20-second reconnect.

## What it costs

$0. Meta doesn't charge for the API, and it fits Cloudflare's free plan:

| Free-plan limit | What uses it |
|---|---|
| 100,000 Worker requests a day | One per webhook, plus admin pages and `/health` checks |
| 10 ms CPU per request | Why passwords use PBKDF2 at 12,000 iterations, not 600,000 |
| 5 cron triggers per account | This uses 2: the 5-minute poll and the 03:00 UTC token refresh |
| D1: 100,000 rows written a day | A few per comment |
| D1: 5 million rows read a day | Home's all-time totals scan the send log on every load: 100 loads a day at 50,000 comments |
| D1: 500 MB per database | The send log grows a row per comment; webhook logs are pruned after 7 days |

## Quick start

About 15 minutes, mostly in Meta's dashboard. You need Node.js 22.13+, free [Cloudflare](https://dash.cloudflare.com/sign-up) and [Meta for Developers](https://developers.facebook.com/) accounts, and an Instagram Creator or Business account.

1. Create a Meta app and copy its three values ([Part 1](https://charanmn7.github.io/ig-comment-dm/docs/setup/#1-create-the-meta-app) of the setup guide).
2. Deploy:

   ```bash
   git clone https://github.com/CharanMN7/ig-comment-dm.git
   cd ig-comment-dm
   npm install
   npx wrangler login
   npm run setup
   ```

   `setup` creates the database and tables, asks for the three Meta values, generates the other secrets, deploys, and prints your admin URL plus the exact strings to paste into Meta. It's safe to re-run.
3. Finish in Meta and connect your account ([Parts 2 and 4–6](https://charanmn7.github.io/ig-comment-dm/docs/setup/#2-invite-each-instagram-account-as-a-tester)).

Or open the cloned repo in Claude Code and say "set this up". A bundled skill runs the terminal side and, with Claude in Chrome, clicks through Meta while you keep the logins and secrets. See the [agent setup guide](https://charanmn7.github.io/ig-comment-dm/docs/agent-setup/).

Updating is a pull and a redeploy; your secrets and data stay in Cloudflare. See [Updating your copy](https://charanmn7.github.io/ig-comment-dm/docs/updating/).

## How you know it's working

- **Test page:** paste a sample comment to see which rule fires. Nothing is sent.
- **Home:** recent webhooks from Meta (including ones rejected for a wrong signature), the last 20 sends with Meta's exact errors, and totals for today, 7 days, 30 days and all time. Red banners flag an account that needs reconnecting, a stalled nightly job or a misconfigured secret.
- **`/health`:** `200` while the database answers and both scheduled jobs run, `503` when one stalls. No login, no usernames or IDs. Give it to an uptime monitor.
- **`npm run doctor`:** checks the live deployment's secrets, tables, accounts, rules, rejected webhooks and cron jobs, and names the fix.
- **`npx wrangler tail`:** live logs, with tokens and keys never written.
- **CI:** every pull request runs typecheck, unit tests, and integration tests that boot the real Worker in workerd on a fresh D1 with all migrations applied and every Meta call faked.

Stuck? [Troubleshooting](https://charanmn7.github.io/ig-comment-dm/docs/troubleshooting/) starts from the symptom.

## Contributing

Comment on an issue to claim it, wait until you're assigned, then open a PR with `Closes #<issue>`.
PRs from anyone not assigned are closed automatically, and you can have two open at once.
Details are in [CONTRIBUTING.md](CONTRIBUTING.md), the [contributor guide](https://charanmn7.github.io/ig-comment-dm/docs/contributing/) and, for coding agents, [AGENTS.md](AGENTS.md). Planned work is on the [roadmap](https://charanmn7.github.io/ig-comment-dm/docs/roadmap/), and [good first issues](https://github.com/CharanMN7/ig-comment-dm/labels/good%20first%20issue) are the place to start.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## License

[MIT](LICENSE). Not affiliated with, endorsed by, or sponsored by Meta or Instagram. Instagram is a trademark of Meta Platforms, Inc.
