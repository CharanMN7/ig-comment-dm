/**
 * Brings a copy up to date with the official repository, then deploys it.
 *
 *   npm run update                 merge the latest version, install, migrate, deploy
 *   npm run update -- --dry-run    show what would change, and change nothing
 *   npm run update -- --push       push to GitHub instead, for copies Workers Builds deploys
 *
 * Meta renames dashboard screens, retires OAuth hosts and changes signing often
 * enough that a copy left alone eventually stops working. The fixes only help
 * if they reach every copy, and most people running one are not developers, so
 * "git pull, npm install, npm run deploy" has to be one command that cannot
 * lose their work: it refuses to start over unsaved edits, backs a clashing
 * merge out instead of leaving conflict markers behind, and says what to do
 * next whenever it stops.
 *
 * Copies come about in three ways, and each needs something different:
 * - a clone or fork deployed from this computer: merge, then npm run deploy;
 * - the Deploy to Cloudflare button: Cloudflare creates a new repository with
 *   fresh history and deploys every push to it, so the first update has to work
 *   out which version was copied (findStartingPoint), and deploying is a push;
 * - a downloaded ZIP: there is no history at all, so it explains the options.
 *
 * UPDATE_UPSTREAM_URL points it at another repository, and
 * UPDATE_SKIP_INSTALL_AND_DEPLOY=1 stops after the merge or push. The tests use both.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  OFFICIAL_REPO,
  UPSTREAM_BRANCH,
  blockedMessage,
  blockingFiles,
  changedPaths,
  conflictMessage,
  decideMode,
  describeHealth,
  dirtyMessage,
  identityMessage,
  looksLikeCloudflareImport,
  newMigrations,
  noGitMessage,
  numstatTotal,
  onlyDatabaseIdChange,
  parseArgs,
  parseLog,
  pickStartingPoint,
  restoreDatabaseId,
  sameRepo,
  workerName,
  workerUrlFrom,
} from './update-lib.ts';
import type { Candidate, Mode, Stop } from './update-lib.ts';

const color = stdout.isTTY === true && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UPSTREAM_URL = process.env.UPDATE_UPSTREAM_URL || OFFICIAL_REPO;
const UPSTREAM_REF = `upstream/${UPSTREAM_BRANCH}`;
const SKIP_INSTALL_AND_DEPLOY = process.env.UPDATE_SKIP_INSTALL_AND_DEPLOY === '1';
// npm and npx are .cmd shims on Windows, which spawn only runs through a shell.
// Every argument passed that way is a fixed string.
const SHELL = process.platform === 'win32';
const TOTAL = 5;

const USAGE = `Usage: npm run update [-- options]

  --dry-run   Show what would change. Changes nothing.
  --yes       Do not ask before updating.
  --push      Push to GitHub instead of deploying, for copies that Cloudflare
              deploys from your GitHub repository (the Deploy to Cloudflare button).
  --deploy    Deploy from this computer even if the copy looks like a Deploy button copy.`;

function say(msg = ''): void {
  console.log(msg);
}

function step(n: number, title: string): void {
  say(`\n${bold(cyan(`[${n}/${TOTAL}]`))} ${bold(title)}`);
}

function ok(msg: string): void {
  say(`  ${green('✓')} ${msg}`);
}

function warn(msg: string): void {
  say(`  ${yellow('!')} ${msg}`);
}

function note(msg: string): void {
  say(dim(msg.replace(/^/gm, '  ')));
}

function stop({ stop: msg, hint }: Stop): never {
  say(`\n${red(bold('Stopped.'))} ${msg}`);
  if (hint) say(`\n${hint}`);
  say('');
  process.exit(1);
}

function git(args: string[], opts: { prompt?: boolean } = {}): { code: number; out: string } {
  const res = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    // The output is parsed in English, and a fetch from a mistyped URL must fail
    // instead of sitting on a password prompt nobody expects.
    env: { ...process.env, LC_ALL: 'C', ...(opts.prompt ? {} : { GIT_TERMINAL_PROMPT: '0' }) },
    stdio: [opts.prompt ? 'inherit' : 'ignore', 'pipe', 'pipe'],
  });
  if (res.error) return { code: 127, out: res.error.message };
  return { code: res.status ?? 1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function gitOut(args: string[]): string {
  const res = git(args);
  if (res.code !== 0) {
    stop({
      stop: `git ${args[0]} failed unexpectedly.`,
      hint: `${res.out.trim()}\n\nNothing has been changed by this step. Run npm run update again, and open an issue if it keeps happening.`,
    });
  }
  return res.out.trim();
}

function lines(text: string): string[] {
  return text.split('\n').filter((l) => l.trim() !== '');
}

/** Runs a command with its output shown live, and returns the output too. */
function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    // stdin is closed so wrangler sees no terminal and applies migrations
    // without its own "continue?" prompt; the person already said yes above.
    const child = spawn(cmd, args, { cwd: ROOT, shell: SHELL, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      process.stdout.write(d);
      out += String(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      process.stderr.write(d);
      out += String(d);
    });
    child.on('error', (err) => resolve({ code: 127, out: err.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.on('close', () => resolve(''));
    rl.question(question).then(resolve, () => resolve(''));
  });
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function wranglerLoggedIn(): boolean | null {
  // Before the first npm install there is no wrangler to ask, and npx would
  // download one. The install step comes before the deploy anyway.
  if (!existsSync(`${ROOT}/node_modules/wrangler`)) return null;
  const res = spawnSync('npx', ['wrangler', 'whoami'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: SHELL,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return res.status === 0 && !/not authenticated|you are not logged in/i.test(out);
}

interface StartingPoint {
  sha: string;
  exact: boolean;
  differing: string[];
}

/**
 * A Deploy button copy (or a ZIP someone later committed) shares no history
 * with the official repository. Plain `git merge` refuses that, and with
 * --allow-unrelated-histories it treats every file changed upstream since as a
 * clash. So find the official commit whose files match the copy's first commit;
 * recording it as a parent once gives git the common ancestor it needs.
 * wrangler.toml is left out of the comparison because Cloudflare writes the new
 * database id and Worker name into it.
 */
function findStartingPoint(target: string): StartingPoint | null {
  const roots = lines(gitOut(['rev-list', '--max-parents=0', 'HEAD']));
  const root = roots[roots.length - 1];
  const copiedAt = Number(gitOut(['log', '-1', '--format=%ct', root]));
  const exclude = ':(exclude)wrangler.toml';
  const candidates: Candidate[] = lines(
    gitOut(['log', '--first-parent', '--format=%H%x09%ct', '-n', '500', target]),
  ).map((line) => {
    const [sha, time] = line.split('\t');
    const distance = numstatTotal(gitOut(['diff', '--numstat', sha, root, '--', '.', exclude]));
    return { sha, time: Number(time), distance };
  });
  const best = pickStartingPoint(candidates, copiedAt);
  if (!best) return null;
  const differing = best.distance ? lines(gitOut(['diff', '--name-only', best.sha, root, '--', '.', exclude])) : [];
  return { sha: best.sha, exact: best.distance === 0, differing };
}

type MergeResult =
  | { ok: true }
  | { ok: false; conflicted: string[] }
  | { ok: false; blocked: string[]; out: string };

function merge(startingPoint: StartingPoint | null): MergeResult {
  if (startingPoint) {
    const short = startingPoint.sha.slice(0, 7);
    const joined = git([
      'merge',
      '-s',
      'ours',
      '--allow-unrelated-histories',
      '--no-edit',
      '-m',
      `Connect this copy to the official ig-comment-dm history at ${short}.`,
      '-m',
      'Changes no files. It records which official version this copy started from, so updates merge only what changed since.',
      startingPoint.sha,
    ]);
    if (joined.code !== 0) return { ok: false, blocked: [], out: joined.out };
  }
  // --ff overrides a merge.ff setting in the person's git config, which could
  // otherwise forbid the fast-forward or force a merge commit nobody asked for.
  const merged = git(['merge', '--ff', '--no-edit', UPSTREAM_REF]);
  if (merged.code === 0) return { ok: true };
  if (git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).code === 0) {
    const conflicted = lines(git(['diff', '--name-only', '--diff-filter=U']).out);
    git(['merge', '--abort']);
    return { ok: false, conflicted };
  }
  return { ok: false, blocked: blockingFiles(merged.out), out: merged.out };
}

async function checkHealth(url: string): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(15_000) });
      const verdict = describeHealth(res.status, await res.text());
      if (verdict.ok) ok(verdict.message);
      else warn(verdict.message);
      return;
    } catch (err) {
      // A fresh deploy can take a few seconds to answer everywhere.
      if (attempt === 1) {
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }
      warn(`Could not reach ${url}/health (${err instanceof Error ? err.message : String(err)}).`);
      note('Open that address in a browser in a minute. If it still fails, run npm run doctor.');
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if ('error' in args) stop({ stop: args.error, hint: USAGE });
  if (args.help) {
    say(USAGE);
    return;
  }

  say(`\n${bold('Comment to DM — update')}`);
  say(dim(args.dryRun ? 'Dry run: shows what would happen and changes nothing.' : 'Brings your copy up to date with the official version.'));

  // ------------------------------------------------------------ 1. checks
  step(1, 'Checking your copy');
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.code === 127) stop(noGitMessage(false));
  // A ZIP unpacked inside some other repository would otherwise pass.
  if (top.code !== 0 || realpathSync(top.out.trim()) !== realpathSync(ROOT)) stop(noGitMessage(true));

  const branchRes = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branchRes.code !== 0) {
    stop({
      stop: 'This copy is not on a branch right now, so there is nothing to merge the update into.',
      hint: 'Switch back to your branch (usually master or main), then run npm run update again:\n  git checkout master',
    });
  }
  const branch = branchRes.out.trim();

  if (git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).code === 0) {
    stop({
      stop: 'An earlier merge is still unfinished.',
      hint: 'Finish it with git commit, or cancel it, then run npm run update again:\n  git merge --abort',
    });
  }

  let changed = changedPaths(git(['status', '--porcelain', '-z', '--untracked-files=no']).out);
  let databaseIdLine: string | null = null;
  if (changed.includes('wrangler.toml')) {
    databaseIdLine = onlyDatabaseIdChange(git(['diff', '-U0', 'HEAD', '--', 'wrangler.toml']).out);
    if (databaseIdLine) changed = changed.filter((p) => p !== 'wrangler.toml');
  }
  if (changed.length) stop(dirtyMessage(changed));
  ok(`No unsaved edits on ${bold(branch)}`);
  if (databaseIdLine) note('Your database id in wrangler.toml is kept as it is.');

  // ------------------------------------------------------------- 2. fetch
  step(2, 'Getting the latest version');
  const existing = git(['remote', 'get-url', 'upstream']);
  const hasUpstream = existing.code === 0;
  if (hasUpstream) {
    const current = existing.out.trim();
    if (!sameRepo(current, UPSTREAM_URL)) {
      stop({
        stop: `Your "upstream" remote points at ${current}, not the official repository.`,
        hint:
          'If that is a mistake, point it at the official one, then run npm run update again:\n' +
          `  git remote set-url upstream ${UPSTREAM_URL}\n` +
          'If you track a different copy on purpose, run it with UPDATE_UPSTREAM_URL set to that address.',
      });
    }
  } else if (!args.dryRun) {
    gitOut(['remote', 'add', 'upstream', UPSTREAM_URL]);
    ok(`Added a remote called upstream for ${UPSTREAM_URL}`);
  }

  // A dry run fetches by address, so it adds no remote and moves no ref.
  const fetched = hasUpstream || !args.dryRun
    ? git(['fetch', '--no-tags', 'upstream', `+refs/heads/${UPSTREAM_BRANCH}:refs/remotes/${UPSTREAM_REF}`])
    : git(['fetch', '--no-tags', UPSTREAM_URL, UPSTREAM_BRANCH]);
  if (fetched.code !== 0) {
    stop({
      stop: `Could not download the latest version from ${UPSTREAM_URL}.`,
      hint: `Check your internet connection and run npm run update again. Git said:\n${fetched.out.trim().replace(/^/gm, '  ')}`,
    });
  }
  const target = gitOut(['rev-parse', hasUpstream || !args.dryRun ? UPSTREAM_REF : 'FETCH_HEAD']);
  const head = gitOut(['rev-parse', 'HEAD']);

  const mergeBase = git(['merge-base', 'HEAD', target]);
  let startingPoint: StartingPoint | null = null;
  let base: string;
  if (mergeBase.code === 0) {
    base = mergeBase.out.trim();
  } else {
    startingPoint = findStartingPoint(target);
    if (!startingPoint) {
      stop({
        stop: 'Could not find any version of the official repository to compare your copy with.',
        hint: 'Open an issue at https://github.com/CharanMN7/ig-comment-dm/issues and paste this output.',
      });
    }
    base = startingPoint.sha;
  }

  if (base === target) {
    ok('Your copy already has everything. Nothing to update.');
    say('');
    return;
  }

  const count = Number(gitOut(['rev-list', '--count', '--no-merges', `${base}..${target}`]));
  const commits = parseLog(gitOut(['log', '--no-merges', '--format=%h%x09%s', '-n', '20', `${base}..${target}`]));
  ok(`${bold(String(count))} new change${count === 1 ? '' : 's'} since your copy:`);
  for (const c of commits) say(`    ${dim(c.sha)} ${c.subject}`);
  if (count > commits.length) say(dim(`    …and ${count - commits.length} more`));

  const migrations = newMigrations(gitOut(['diff', '--name-status', '--no-renames', base, target, '--', 'migrations']));
  if (migrations.length) {
    say('');
    warn(bold(`This update changes your database: ${migrations.length} new migration${migrations.length === 1 ? '' : 's'}`));
    for (const m of migrations) say(`    ${yellow(m)}`);
    note('npm run deploy applies them before the new code goes live. They only add tables and\ncolumns, so your rules, accounts and send history stay as they are.');
  }

  if (startingPoint) {
    say('');
    const short = startingPoint.sha.slice(0, 7);
    if (startingPoint.exact) {
      ok(`Your copy started from official version ${short}.`);
    } else {
      warn(`Your copy is closest to official version ${short}, but these files differ from it:`);
      for (const f of startingPoint.differing.slice(0, 15)) say(`    ${f}`);
      if (startingPoint.differing.length > 15) say(dim(`    …and ${startingPoint.differing.length - 15} more`));
      note('They count as your own edits: the update keeps them, and stops if it needs to change the same lines.');
    }
    note('Its history is separate from the official one (the Deploy button and ZIP downloads start fresh),\nso before merging, the update records which official version it started from. That changes no files.');
  }

  // ---------------------------------------------------------- mode
  const originRes = git(['remote', 'get-url', 'origin']);
  const origin = originRes.code === 0 ? originRes.out.trim() : null;
  const cloudflareImport = lines(gitOut(['rev-list', '--max-parents=0', 'HEAD'])).some((root) => {
    const [author = '', subject = ''] = gitOut(['log', '-1', '--format=%an%x00%s', root]).split('\0');
    return looksLikeCloudflareImport(author, subject);
  });
  const decision = decideMode({
    push: args.push,
    deploy: args.deploy,
    origin,
    originIsOfficial: origin !== null && sameRepo(origin, OFFICIAL_REPO),
    cloudflareImport,
    wranglerLoggedIn: args.push || SKIP_INSTALL_AND_DEPLOY ? null : wranglerLoggedIn(),
    branch,
  });
  if ('stop' in decision) stop(decision);
  const mode: Mode = decision.mode;

  const fastForward = !startingPoint && base === head;
  if (!fastForward && git(['var', 'GIT_COMMITTER_IDENT']).code !== 0) stop(identityMessage());

  if (mode === 'push') {
    // Pushing on top of commits made on GitHub would be refused after the merge,
    // leaving an update that is merged here but live nowhere. Catch it first.
    const remote = git(['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
      prompt: true,
    });
    if (remote.code === 0 && gitOut(['rev-list', '--count', `HEAD..origin/${branch}`]) !== '0') {
      stop({
        stop: `Your GitHub copy has changes on ${branch} that this folder does not have yet.`,
        hint: `Bring them in first, then run npm run update -- --push again:\n  git pull --no-rebase origin ${branch}`,
      });
    }
  }

  say('');
  say(bold('What happens next:'));
  if (!hasUpstream && args.dryRun) say(`  • Add a remote called upstream for ${UPSTREAM_URL}`);
  if (startingPoint) say(`  • Record official version ${startingPoint.sha.slice(0, 7)} as where your copy started`);
  say(`  • ${fastForward ? 'Move' : 'Merge'} ${branch} ${fastForward ? 'forward to' : 'with'} the latest version${fastForward ? '' : ' (a merge commit)'}`);
  say(`  • Install dependencies (npm install)`);
  if (mode === 'deploy') say('  • Deploy from this computer (npm run deploy: database migrations first, then the new code)');
  else say(`  • Push ${branch} to origin (${origin}), and Workers Builds deploys it`);

  if (args.dryRun) {
    say(`\n${green('Dry run finished.')} Nothing was changed. Run ${bold(`npm run update${mode === 'push' ? ' -- --push' : ''}`)} to do it.\n`);
    return;
  }

  if (!args.yes && !(await confirm(`\n${bold('Update now?')} [y/N] `))) {
    say('\nNothing changed.\n');
    return;
  }

  // ------------------------------------------------------------- 3. merge
  step(3, 'Merging in the latest version');
  const tomlBefore = databaseIdLine ? readFileSync(`${ROOT}/wrangler.toml`, 'utf8') : null;
  const tomlBlobBefore = git(['rev-parse', 'HEAD:wrangler.toml']).out.trim();
  if (databaseIdLine) gitOut(['checkout', 'HEAD', '--', 'wrangler.toml']);

  const result = merge(startingPoint);

  // Put the database id back whatever happened, before stopping for any reason.
  if (tomlBefore !== null && databaseIdLine !== null) {
    const tomlBlobAfter = git(['rev-parse', 'HEAD:wrangler.toml']).out.trim();
    if (tomlBlobAfter === tomlBlobBefore) {
      writeFileSync(`${ROOT}/wrangler.toml`, tomlBefore);
    } else {
      const restored = restoreDatabaseId(readFileSync(`${ROOT}/wrangler.toml`, 'utf8'), databaseIdLine);
      if (restored !== null) writeFileSync(`${ROOT}/wrangler.toml`, restored);
      else warn('Could not put your database_id line back into wrangler.toml. Wrangler finds the database by name, so deploys still work.');
    }
  }

  if (!result.ok) {
    if ('conflicted' in result) {
      const goneUpstream = result.conflicted.filter((f) => git(['cat-file', '-e', `${target}:${f}`]).code !== 0);
      if (startingPoint) note('The record of where your copy started is kept, so the commands below work. It changes no files.');
      stop(conflictMessage({ files: result.conflicted, goneUpstream, mode, branch }));
    }
    if (result.blocked.length) stop(blockedMessage(result.blocked));
    stop({
      stop: 'Git could not merge the update.',
      hint: `${result.out.trim()}\n\nYour files have not been changed. Fix what git says above, then run npm run update again.`,
    });
  }
  ok(fastForward ? 'Moved forward to the latest version.' : 'Merged the latest version into your copy.');

  // ----------------------------------------------------------- 4. install
  step(4, 'Installing dependencies');
  if (SKIP_INSTALL_AND_DEPLOY) {
    note('Skipped (UPDATE_SKIP_INSTALL_AND_DEPLOY is set).');
  } else {
    // --no-save installs what package-lock.json pins without rewriting it. A
    // different npm version can otherwise reformat the lockfile, and that edit
    // would block the next update as unsaved work.
    const installed = await run('npm', ['install', '--no-save']);
    if (installed.code !== 0) {
      stop({
        stop: 'Your copy is updated, but installing dependencies failed.',
        hint: `Fix what npm says above, then run:\n  npm install\n  ${mode === 'push' ? `git push origin ${branch}` : 'npm run deploy'}`,
      });
    }
    ok('Installed.');
  }

  // --------------------------------------------------- 5. deploy or push
  if (mode === 'push') {
    step(5, 'Pushing to GitHub');
    const pushed = spawnSync('git', ['push', 'origin', branch], { cwd: ROOT, stdio: 'inherit' });
    if (pushed.status !== 0) {
      stop({
        stop: 'Your copy is updated here, but pushing it to GitHub failed.',
        hint:
          'The message above says why; usually git needs you to sign in to GitHub. Once that works, run:\n' +
          `  git push origin ${branch}\n` +
          'See https://docs.github.com/en/get-started/git-basics/caching-your-github-credentials-in-git',
      });
    }
    ok(`Pushed ${branch} to ${origin}.`);
    const defaultBranch = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).out.trim();
    if (defaultBranch && defaultBranch !== `origin/${branch}`) {
      warn(`Your repository's main branch is ${defaultBranch.replace(/^origin\//, '')}, not ${branch}.`);
      note('Workers Builds deploys only the production branch. Other branches get a preview instead.');
    }
    const name = existsSync(`${ROOT}/wrangler.toml`) ? workerName(readFileSync(`${ROOT}/wrangler.toml`, 'utf8')) : null;
    say(`\n${green(bold('Pushed. Cloudflare is building it now.'))}`);
    say(`Watch the build: ${cyan('https://dash.cloudflare.com/?to=/:account/workers-and-pages')}`);
    say(dim(`  → ${name ?? 'your Worker'} → Deployments → View build history. It takes a minute or two.`));
    if (migrations.length) {
      say(dim('  The build runs your deploy command, npm run deploy unless you changed it, which applies'));
      say(dim('  the new migrations first. Check it under Settings → Build → Deploy command.'));
    }
    say(dim('  When the build shows Success, open https://<your Worker address>/health to check it.\n'));
    return;
  }

  step(5, 'Deploying');
  if (SKIP_INSTALL_AND_DEPLOY) {
    note('Skipped (UPDATE_SKIP_INSTALL_AND_DEPLOY is set).');
    say(`\n${green(bold('Updated.'))}\n`);
    return;
  }
  const deployed = await run('npm', ['run', 'deploy']);
  if (deployed.code !== 0) {
    stop({
      stop: 'Your copy is updated here, but the deploy failed, so the old version is still live.',
      hint: 'The output above says why. Fix it, then run this again (it is safe to re-run):\n  npm run deploy',
    });
  }
  ok('Deployed.');
  const url = workerUrlFrom(deployed.out);
  if (url) await checkHealth(url);
  else note('Open https://<your Worker address>/health to check it.');
  say(`\n${green(bold('Done. Your copy is up to date and live.'))}\n`);
}

main().catch((err: unknown) => {
  say(`\n${red('Update crashed.')} ${err instanceof Error ? err.message : String(err)}`);
  say('Your files are as git left them. Run git status to see, and open an issue with this output.');
  process.exit(1);
});
