# Comment to DM

Self-hosted Instagram comment-to-DM automation. One Cloudflare Worker and one D1 database on your own account, on the free plan.

[![CI](https://img.shields.io/github/actions/workflow/status/CharanMN7/ig-comment-dm/ci.yml?branch=master&label=CI)](https://github.com/CharanMN7/ig-comment-dm/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/github/license/CharanMN7/ig-comment-dm)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/CharanMN7/ig-comment-dm)](https://github.com/CharanMN7/ig-comment-dm/stargazers)
[![Docs: Inkform](https://img.shields.io/badge/docs-Inkform-5851db)](https://github.com/inkform-dev/framework)

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
       one private DM, now or from the queue (12 a minute)
                                │
                                ▼
                    an optional public reply
```

There are two ways in because Instagram silently drops webhooks for collapsed and low-signal comments. Every five minutes the Worker reads the last 72 hours of comments on up to 3 posts per account, taking turns when rules cover more, and answers up to 10 per run that the webhook missed. Both paths claim the comment with `INSERT … ON CONFLICT DO NOTHING` before sending, so a duplicate delivery can't produce a second DM. Each DM call gets one attempt: one whose answer is lost is logged as "may have been delivered" and sent again only if you press **Send again** after checking. A DM Instagram turns down for now (rate limits, its own temporary errors) is tried again after 1, 5 and 20 minutes.

The Worker is about 7,000 lines of TypeScript, with one runtime dependency (`hono`) and no client-side JavaScript. Instagram tokens are encrypted with AES-256-GCM under a key that exists only in your Cloudflare account.

## Who it's for

Creators and small businesses who run "comment X for the link" posts and would rather not pay $180 to $1,188 a year, or give a third party a token to their account. Setup is five terminal commands and a screen-by-screen guide through Meta's dashboard.

## What can go wrong

- **Professional accounts only.** Instagram's API doesn't work with personal accounts. Switching to Creator or Business takes a minute in the app.
- **Your Meta app has to be Live.** In Development mode Meta sends no real comment webhooks, so only the five-minute poll works. Publishing needs no App Review while only your own accounts connect as Instagram Testers. Letting strangers connect theirs would need App Review; this is built for one person and their own accounts.
- **One private reply per comment, ever, within 7 days.** No follow-up unless they reply to you. Older comments are skipped.
- **About 750 private replies per hour per account**, Meta's cap. The Worker sends at most 12 a minute per account, which keeps every hour under it, and queues the rest, sending the oldest first every minute. One cron run a minute sends for every account, so a backlog of 5,000 on one account takes about 7 hours, and two accounts with backlogs get about 7 a minute each. A comment still queued an hour before Instagram's 7-day limit is skipped.
- **Meta changes things.** It renames dashboard screens, retires OAuth hosts and changes which secret signs webhooks. The code pins Graph API v23.0, which Meta will eventually retire.
- **Blind spots.** Comments hidden by Instagram's Hidden Words filter never reach the API. DMs to non-followers land in Message requests. For a rule on all posts, the poll reads only your 3 newest, so comments on older posts rely on the webhook alone.
- **60-day tokens.** A nightly job refreshes them. If it stops, `/health` turns 503 before they expire; a lapsed account needs a 20-second reconnect.

## What it costs

$0. Meta doesn't charge for the API, and it fits Cloudflare's free plan:

| Free-plan limit | What uses it |
|---|---|
| 100,000 Worker requests a day | One per webhook, plus admin pages, `/health` checks and, at most, 1,441 cron runs |
| 10 ms CPU per request | Why passwords use PBKDF2 at 12,000 iterations, not 600,000 |
| 50 subrequests per run | Every fetch and D1 query counts, so a cron run sends at most 12 queued DMs per account, fewer each when several have a backlog, and a webhook queues what it can't afford to send |
| 5 cron triggers per account | This uses 2: the minute job (sends the queue, polls every fifth minute) and the 03:00 UTC token refresh |
| D1: 100,000 rows written a day | The real ceiling: about 13 per DM (16 if it was queued) and 3 per comment no rule matches, so roughly 6,000 to 7,500 DMs a day. Past it, D1 refuses everything until 00:00 UTC |
| D1: 5 million rows read a day | Each Home load reads the last 30 days of the send log, never all of it: 80+ loads a day at 1,000 comments a day, however old the log |
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

To update, run `npm run update`: it pulls the latest version, applies any database migrations and redeploys, and your secrets and data stay in Cloudflare. See [Updating your copy](https://charanmn7.github.io/ig-comment-dm/docs/updating/), including for Deploy button copies. The [changelog](https://charanmn7.github.io/ig-comment-dm/docs/changelog/) says what each version changed and what to do before upgrading.

## How you know it's working

- **Test page:** paste a sample comment to see which rule fires. Nothing is sent.
- **Home:** recent webhooks from Meta (including ones rejected for a wrong signature), what's queued or retrying, the last 20 sends with Meta's exact errors, and totals for today, 7 days, 30 days and all time. Red banners flag an account that needs reconnecting, a stalled nightly job or a misconfigured secret.
- **Logs:** every send, paginated and filterable by status, account, rule and date, with **Send again** on any DM marked "may have been delivered".
- **`/health`:** `200` while the database answers and both scheduled jobs run, `503` when one stalls. No login, no usernames or IDs. Give it to an uptime monitor.
- **`npm run doctor`:** checks the live deployment's secrets, tables, accounts, rules, rejected webhooks and cron jobs, and names the fix.
- **`npx wrangler tail`:** live logs, with tokens and keys never written.
- **CI:** every pull request runs typecheck, unit tests, and integration tests that boot the real Worker in workerd on a fresh D1 with all migrations applied and every Meta call faked.

Stuck? [Troubleshooting](https://charanmn7.github.io/ig-comment-dm/docs/troubleshooting/) starts from the symptom.

## Contributing

Read **[CONTRIBUTING.md](CONTRIBUTING.md)** before you start. In short: comment on an issue to claim it, wait until a maintainer assigns you, then open a PR with `Closes #<issue>`. PRs that skip this are closed automatically, and you can have two open at once.
AI tools are fine if you say how you used them and understand every line you submit.
For coding agents there's [AGENTS.md](AGENTS.md), and local setup is in the [contributor guide](https://charanmn7.github.io/ig-comment-dm/docs/contributing/). Planned work is on the [roadmap](https://charanmn7.github.io/ig-comment-dm/docs/roadmap/). [Good first issues](https://github.com/CharanMN7/ig-comment-dm/labels/good%20first%20issue) are for first-time contributors, one each.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## License

[MIT](LICENSE). Not affiliated with, endorsed by, or sponsored by Meta or Instagram. Instagram is a trademark of Meta Platforms, Inc.
