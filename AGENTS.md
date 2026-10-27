# AGENTS.md

For coding agents (Claude Code, Codex, Cursor and the rest) working in this repository. The
full contributor guide is [CONTRIBUTING.md](CONTRIBUTING.md) and the
[docs site](https://charanmn7.github.io/ig-comment-dm/docs/contributing/). This file is the
short version, plus the one rule agents keep missing.

Setting up your own copy rather than changing the code? Follow the
[self-setup guide](https://charanmn7.github.io/ig-comment-dm/docs/setup/). In Claude Code,
say "set this up" and the project skill in `.claude/skills/setup/` walks you through it.

## Before you write code for a pull request

A pull request from someone who isn't assigned to the issue it closes is **closed
automatically** by `.github/workflows/pr-policy.yml`, however good the code is. So before
writing anything meant for a PR:

1. **Ask your human which issue it's for.** No issue means no PR yet. They open one, comment
   to claim it, and wait for a maintainer to assign them.
2. **Check the assignment:**

   ```bash
   gh issue view <n> --json assignees --jq '.assignees[].login'
   gh api user --jq .login        # your human's login, to compare
   ```

3. **If they aren't assigned, stop and tell them.** Don't build the change "so it's ready":
   it will be closed unread.
4. **Put `Closes #<n>` in the PR description.** The policy reads the issues a PR closes, so
   without that line the PR is closed even when your human is assigned.

Also:

- **One change per PR.** A bug fix and a refactor are two PRs.
- **At most two open PRs per person.** Check with `gh pr list --author "@me"` before opening
  another.
- **Fill in the PR template's AI-use field truthfully.** Your human has to understand every
  line, run the change and the tests locally, and write their own replies to review. PRs
  that look mass-generated or hide AI use are closed without review.
- **`good first issue` is for first-time contributors**, one per person.

## What this project is

A self-hosted Instagram comment-to-DM tool. A comment webhook arrives, a keyword rule
matches, and the Worker sends a private-reply DM. It's small on purpose, and these limits are
the design, not gaps to fill:

- **One Cloudflare Worker, one D1 database** (binding `DB`). [Hono](https://hono.dev) routes,
  HTML rendered on the server. No build step, no bundler config.
- **No client-side JavaScript.** The CSP is `default-src 'none'` with no `script-src`, so an
  inline `<script>` or `onclick=` silently does nothing. Use forms and links.
- **No new runtime dependencies.** The list is `hono` and nothing else.
- **Web Crypto only.** Never enable `nodejs_compat`.

Where things live: `src/routes/` (admin panel, Connect, webhook, `/health`, legal pages),
`src/html.ts` (shared layout and styles: reuse them), `src/db.ts` (D1 queries), `src/meta.ts`
(every Graph API call), `src/queue.ts` (the send queue and retries), `src/cron.ts` (scheduled
jobs), `migrations/`, `test/`, `scripts/`
(setup, doctor, unit tests), and `site/` (the docs, a separate package). The
[architecture page](https://charanmn7.github.io/ig-comment-dm/docs/architecture/) has the
whole map.

## Commands

Node.js 22.13 or newer. `.npmrc` sets `engine-strict`, so `npm ci` refuses anything older.

```bash
npm ci
npm run typecheck          # tsc over src/ and test/
npm run test:unit          # pure functions, node:test, scripts/test-unit.ts
npm run test:integration   # the real Worker in workerd with a fresh D1 per test; Meta is faked
npm test                   # both suites
npm run dev                # wrangler dev on http://localhost:8787
```

`npm test` and `npm run typecheck` must pass before a PR. Neither needs a Meta app or a
`.dev.vars`. A Meta call with no fake in `test/support/meta.ts` fails the test, so add a
route there if your change makes a new one. A bug fix comes with a test that fails without
it. Docs edits go in `site/content/docs/`; build them with
`cd site && npm ci && npm run build && npm run check-links`.

**Adding a migration:** a new file in `migrations/` with the next free number on `master`.
Never edit one that has shipped, since databases that recorded it never read it again. Keep
changes additive, and give new columns a default that leaves existing rows behaving as
before.

**Commits:** the subject is an imperative sentence about behaviour, ending with a period,
like `Skip a rule when its comment also matches one of the rule's exclusions.` The body
explains why, especially for anything involving Meta.

## House style

There's no linter, so these are kept by hand:

- Comments explain why, never what. `src/guard.ts` is the model.
- No `any`. Type Meta's JSON narrowly at the boundary.
- Imports carry the `.ts` extension.
- Never log a secret. Log an account ID, never a token, password or key.
- Errors an operator sees are written for a non-developer, with technical detail in a
  `<pre>` underneath.
- Admin pages work at 375px wide, with tap targets of at least 44px.

## Never commit

`.dev.vars`, any `.env` file, a token, a screenshot of an admin URL, or a real
`database_id`. `wrangler.toml` has none on purpose: Wrangler finds the database by its
name and doesn't write the ID back. If one gets added locally, leave that line out of every
commit. Add files by path, never with `git add -A`.
