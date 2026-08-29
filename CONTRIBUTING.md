# Contributing

Thanks for being here. This project is small on purpose, and contributions that
keep it small are the most welcome kind.

## The shape of this project

One Cloudflare Worker. One D1 database. No build step, no bundler config, no
framework, no client-side JavaScript. Pages are server-rendered HTML from
[Hono](https://hono.dev). The entire app is about 3,700 lines of TypeScript.

That is a feature. A creator with no technical background should be able to have
this running on a free Cloudflare account in under an hour, and a maintainer should
be able to read the whole thing in an afternoon.

**Before you add a dependency, try not adding it.** The runtime dependency list is
one entry long (`hono`). Web Crypto covers hashing, HMAC, and AES-GCM. D1 covers
storage. `fetch` covers Meta.

## Getting set up

You need [Node.js 20+](https://nodejs.org) and a free
[Cloudflare](https://dash.cloudflare.com/sign-up) account.

```bash
git clone https://github.com/CharanMN7/ig-comment-dm.git
cd ig-comment-dm
npm install

cp .dev.vars.example .dev.vars      # then fill it in — see below
npm run db:migrate:local
npm run dev                          # http://localhost:8787
```

For local work you do **not** need a real Meta app. Fill `.dev.vars` with dummy
values of the right shape and most of the admin panel works:

```bash
npm run keys        # prints correctly-sized random values for the four generated secrets
```

You need a real Meta app only to test Connect (OAuth) or a live DM.

### Verifying your change

```bash
npm test            # unit tests — no network, no database
npm run typecheck   # tsc --noEmit
```

Both must pass. CI runs exactly these two commands plus a secret scan.

There is also a live end-to-end check that drives a running Worker:

```bash
ADMIN_URL_SECRET=... WEBHOOK_VERIFY_TOKEN=... META_APP_SECRET=... ADMIN_PASSWORD=... \
  npm run selftest -- http://localhost:8787
```

## Working on an issue

Issues labelled [`good first issue`](https://github.com/CharanMN7/ig-comment-dm/labels/good%20first%20issue)
are self-contained and have the approach sketched out in the description. Comment on
one to claim it.

Anything labelled [`roadmap`](https://github.com/CharanMN7/ig-comment-dm/labels/roadmap)
is a feature we want but have not built. Those are bigger. Say what you plan to do in
the issue before you write much code, so two people do not build the same thing twice.

## Pull requests

- **One change per PR.** A bug fix and a refactor in the same diff is two PRs.
- **Branch from `master`**, name it `feat/…`, `fix/…`, `docs/…`, or `chore/…`.
- **Write the commit subject as a sentence about behaviour**, in the imperative, ending
  with a period. Look at `git log` — every commit reads like
  `Accept Facebook webhook signatures and poll missed comments.` not `fix webhook`.
- **Explain the why in the body**, especially for anything involving Meta. Meta's
  documented behaviour and Meta's actual behaviour differ often enough that the
  reasoning is the valuable part.
- **Add a test** when you fix a bug. `scripts/test-unit.ts` uses the built-in
  `node:test` runner — no framework to learn.
- **Update the docs** when you change the operator-facing steps.

## House style

The code follows a few conventions that are not enforced by a linter, because there
is no linter:

- **Comments explain why, never what.** `src/guard.ts` is the model: it is 14 lines
  and 8 of them explain why the guard has to exist at all.
- **Errors that reach an operator are written for a human.** Not "500 Internal Server
  Error" — "The database tables are missing. Run the D1 migration, then try again."
  The person reading it may not be a developer. Technical detail goes in a `<pre>`
  underneath.
- **No `any`.** Meta's JSON is typed narrowly at the boundary and validated there.
- **Imports carry the `.ts` extension.** Node's type-stripping and Wrangler both want it.
- **Nothing secret is ever logged.** Log an account id, never a token, a password, or
  a key. If you are adding a log line, check what is in the object you are spreading.
- **No `nodejs_compat`.** Web Crypto only. This keeps the Worker startable on the free
  tier with a tiny bundle.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md) for
private reporting.

Never commit `.dev.vars`, a `database_id`, an access token, or a screenshot showing
your admin URL. CI scans every PR for these, but the scan is a backstop, not a
substitute for checking your own diff.

## Deciding what belongs here

**Yes:** anything that makes the comment-to-DM path more reliable, anything that makes
setup less painful, better error messages, more of Instagram's API surface, and the
features on the [roadmap](README.md#roadmap).

**Probably not:** a hosted multi-tenant version, a database other than D1, a JavaScript
framework in the admin panel, or a paid tier. This is a tool you run yourself, and
keeping it that way is the point.

If you are unsure, open an issue and ask before building.

## Code of conduct

Be decent. Assume good faith. Everyone here is doing this in their spare time.
Harassment gets you removed, and there is no appeals process.
