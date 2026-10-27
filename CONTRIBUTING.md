# Contributing

Thanks for wanting to help. These rules keep the project manageable for the people who review your work.

## Claim before you code

1. Comment on the issue you want to work on.
2. Wait for a maintainer to assign it to you.
3. Open your PR and link the issue with `Closes #123`.

PRs that aren't linked to an issue assigned to their author are closed automatically, however good the code is. If you're assigned and go quiet for 7 days, the issue may be reassigned.

## Good first issues are for first-timers

Issues labelled [`good first issue`](https://github.com/CharanMN7/ig-comment-dm/labels/good%20first%20issue) are for people making their first contribution here, one per person. After your first merged PR, pick something else so newcomers get a turn.

## Limits

You can have at most 2 open PRs here at a time.

## AI-assisted contributions

You can use AI tools, but you can't hand us unreviewed AI output.

- Say in your PR whether and how you used AI.
- Understand every line you submit, and be ready to explain it in your own words during review.
- Run your change and the tests locally before opening the PR.
- Write your own replies to review comments.

PRs that look mass-generated, skip this process, or hide AI use may be closed without review. Repeated violations lead to a block.

## What we value

A small change you understand beats a big one you don't. We'd rather have one contributor who sticks around than ten drive-by PRs.

## Before you open the PR

```bash
npm test            # unit tests, plus integration tests running the Worker in workerd
npm run typecheck
```

Both must pass. One change per PR, branched from `master`, with a commit subject
written as a sentence about behaviour, ending with a period.

Never commit `.dev.vars`, a `database_id`, an access token, or a screenshot showing
your admin URL. For a vulnerability, don't open an issue: see [SECURITY.md](SECURITY.md).

Local setup, the test suite, house style and adding a migration are covered in the
full **[contributor guide](https://charanmn7.github.io/ig-comment-dm/docs/contributing/)**.
Using a coding agent? It should read [AGENTS.md](AGENTS.md) first.
