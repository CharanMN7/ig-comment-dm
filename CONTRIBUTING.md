# Contributing

Thanks for being here. This project is small on purpose, and contributions that
keep it small are the most welcome kind.

The full contributor guide (local setup, tests, house style, adding a migration,
and what belongs here) is in the docs:
**[Contributing](https://charanmn7.github.io/ig-comment-dm/docs/contributing/)**.
This file keeps the rules that decide whether a pull request gets reviewed.

## Working on an issue

Every pull request starts as an issue with your name on it.

1. **Find an issue, or open one.** For a bug, a typo or a broken link too: it takes
   ten seconds and saves a wasted PR.
2. **Comment to claim it**, with a line or two on how you plan to do it.
3. **Wait until a maintainer assigns it to you.** Then start building.
4. **Open the PR with `Closes #<issue>` in the description.**

A pull request from someone who is not assigned to the issue it closes is closed
automatically, however good the code is. We may still build the idea ourselves. It is
nothing personal: writing a PR now takes seconds, reviewing one still takes an hour,
and assignment is how two people avoid building the same thing twice.

You can have at most **two open pull requests** here at a time.

Issues labelled [`good first issue`](https://github.com/CharanMN7/ig-comment-dm/labels/good%20first%20issue)
are self-contained and have the approach sketched out in the description.

## Before you open it

```bash
npm test            # unit tests, plus integration tests running the Worker in workerd
npm run typecheck
```

Both must pass. One change per PR, branched from `master`, with a commit subject
written as a sentence about behaviour, ending with a period.

Never commit `.dev.vars`, a `database_id`, an access token, or a screenshot showing
your admin URL. For a vulnerability, don't open an issue: see [SECURITY.md](SECURITY.md).
