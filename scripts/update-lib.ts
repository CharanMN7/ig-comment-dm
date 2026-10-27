/**
 * The parts of `npm run update` that decide things, kept free of git and the
 * network so scripts/test-update.ts can check them directly. scripts/update.ts
 * runs the commands and prints what these return.
 */

export const OFFICIAL_REPO = 'https://github.com/CharanMN7/ig-comment-dm.git';
export const UPSTREAM_BRANCH = 'master';
export const LATEST_ZIP = 'https://github.com/CharanMN7/ig-comment-dm/archive/refs/heads/master.zip';

/** Why the command stopped, and what the person should do about it. */
export interface Stop {
  stop: string;
  hint: string;
}

export interface Args {
  yes: boolean;
  dryRun: boolean;
  push: boolean;
  deploy: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args | { error: string } {
  const args: Args = { yes: false, dryRun: false, push: false, deploy: false, help: false };
  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') args.yes = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--push') args.push = true;
    else if (arg === '--deploy') args.deploy = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else return { error: `Unknown option: ${arg}` };
  }
  if (args.push && args.deploy) return { error: 'Pick one of --push and --deploy, not both.' };
  return args;
}

/**
 * Reduces a remote URL to host/owner/repo, so the HTTPS and SSH spellings of
 * the same GitHub repository compare equal and a fork does not.
 */
export function repoKey(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\/)/, '$1/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}

export function sameRepo(a: string, b: string): boolean {
  return repoKey(a) === repoKey(b);
}

/** Paths with changes to tracked files, from `git status --porcelain -z`. */
export function changedPaths(porcelainZ: string): string[] {
  const entries = porcelainZ.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // A rename or copy is followed by the path it came from, as its own entry.
    if (entry[0] === 'R' || entry[0] === 'C') i++;
  }
  return paths;
}

const DATABASE_ID_LINE = /^\s*database_id\s*=\s*"[^"]*"\s*(#.*)?$/;

/**
 * The README of older versions had the D1 database id pasted into
 * wrangler.toml, and the comment there says not to commit it. Wrangler itself
 * finds the database by name and doesn't write the id back into a TOML with
 * comments, but every copy set up the old way carries that one uncommitted
 * line, and refusing to update over it would refuse all of them. Returns the
 * line when it is the only change in `git diff -U0 HEAD -- wrangler.toml`.
 */
export function onlyDatabaseIdChange(diff: string): string | null {
  let added: string | null = null;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk || !(line.startsWith('+') || line.startsWith('-'))) continue;
    const body = line.slice(1);
    if (body.trim() === '') continue;
    if (!DATABASE_ID_LINE.test(body)) return null;
    if (line.startsWith('+')) {
      if (added !== null) return null;
      added = body;
    }
  }
  return added;
}

/** The database_id line in a wrangler.toml, if it has one. */
export function databaseIdLineIn(toml: string): string | null {
  return toml.split('\n').find((l) => DATABASE_ID_LINE.test(l)) ?? null;
}

/**
 * Puts a set-aside database_id line back after the merge, under database_name.
 * Null when there is nowhere sensible to put it or the file already has one.
 */
export function restoreDatabaseId(toml: string, line: string): string | null {
  const lines = toml.split('\n');
  if (databaseIdLineIn(toml) !== null) return null;
  const at = lines.findIndex((l) => /^\s*database_name\s*=/.test(l));
  if (at === -1) return null;
  lines.splice(at + 1, 0, line);
  return lines.join('\n');
}

export interface Commit {
  sha: string;
  subject: string;
}

/** Parses `git log --format=%h%x09%s`. */
export function parseLog(text: string): Commit[] {
  return text
    .split('\n')
    .filter((line) => line.includes('\t'))
    .map((line) => {
      const tab = line.indexOf('\t');
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
}

/** Files the update adds under migrations/, from `git diff --name-status --no-renames`. */
export function newMigrations(nameStatus: string): string[] {
  return nameStatus
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([status, path]) => status === 'A' && path?.startsWith('migrations/') && path.endsWith('.sql'))
    .map(([, path]) => path);
}

export interface TreeDifference {
  /**
   * Lines that differ, leaving out wrangler.toml, plus one for each file or
   * whole directory the copy does not have.
   */
  distance: number;
  /** Lines that differ in wrangler.toml, which Cloudflare edits in a Deploy button copy. */
  wranglerDistance: number;
  /** What the official commit has and the copy does not: a file, or a directory ending in "/". */
  missing: string[];
  /** Migration files the official commit has and the copy does not. */
  missingMigrations: string[];
}

const MIGRATION_FILE = /^migrations\/[^/]+\.sql$/;

/**
 * Reads `git diff --numstat --summary --text --no-renames <official> <copy>`.
 * --text matters: package-lock.json is marked -diff, and numstat would
 * otherwise count a whole lockfile change as one line.
 *
 * A missing file or directory counts once, however long it is. Someone who
 * deleted the docs site from a download should not look further from the
 * version they downloaded than from one before the site existed.
 */
export function treeDifference(output: string, copyFiles: string[]): TreeDifference {
  const rows = output.split('\n');
  const lacking = rows.flatMap((line) => line.match(/^ delete mode \d+ (.+)$/)?.[1] ?? []);
  const gone = new Set(lacking);
  const diff: TreeDifference = {
    distance: 0,
    wranglerDistance: 0,
    missing: missingPaths(lacking, copyFiles),
    missingMigrations: lacking.filter((f) => MIGRATION_FILE.test(f)),
  };
  for (const line of rows) {
    const [added, removed, path] = line.split('\t');
    if (path === undefined || gone.has(path)) continue;
    const lines = added === '-' ? 1 : Number(added) + Number(removed);
    if (path === 'wrangler.toml') diff.wranglerDistance += lines;
    else diff.distance += lines;
  }
  diff.distance += diff.missing.length;
  return diff;
}

/** Groups missing files under the highest directory the copy has nothing in. */
export function missingPaths(lacking: string[], copyFiles: string[]): string[] {
  const copyDirs = new Set<string>();
  for (const file of copyFiles) {
    for (let i = file.indexOf('/'); i !== -1; i = file.indexOf('/', i + 1)) copyDirs.add(file.slice(0, i + 1));
  }
  const units = new Set<string>();
  for (const file of lacking) {
    let unit = file;
    for (let i = file.indexOf('/'); i !== -1; i = file.indexOf('/', i + 1)) {
      const dir = file.slice(0, i + 1);
      if (!copyDirs.has(dir)) {
        unit = dir;
        break;
      }
    }
    units.add(unit);
  }
  return [...units];
}

export interface Candidate extends TreeDifference {
  sha: string;
}

/**
 * Picks the official commit a copy most likely started from. Guessing too new
 * is the dangerous direction: every official change up to the guess counts as
 * already in the copy, so a change the copy never had is dropped without a
 * word. Guessing too old is safer but not free: changes the copy already has
 * get compared again and can clash with lines the person never touched. So:
 *
 * - A commit with a migration the copy lacks is out: the copy predates it, and
 *   counting it as applied would leave the database without it. Other missing
 *   files prove much less, since people delete folders they do not need and
 *   Cloudflare's import may leave some out, so they only add to the distance.
 * - Then the smallest distance, then the closest wrangler.toml, and on a tie
 *   the oldest.
 *
 * `candidates` is newest first.
 */
export function pickStartingPoint(candidates: Candidate[]): Candidate | null {
  if (candidates.length === 0) return null;
  const plausible = candidates.filter((c) => c.missingMigrations.length === 0);
  const pool = plausible.length ? plausible : candidates;
  let best = pool[0];
  for (const c of pool.slice(1)) {
    // Later in the list is older, so a tie moves on to it.
    if (
      c.distance < best.distance ||
      (c.distance === best.distance && c.wranglerDistance <= best.wranglerDistance)
    ) {
      best = c;
    }
  }
  return best;
}

export function isExactMatch(c: Candidate): boolean {
  return c.distance === 0 && c.missing.length === 0;
}

/**
 * The Deploy to Cloudflare button creates the person's repository with one
 * commit, "source repo import", made by Cloudflare's bot.
 */
export function looksLikeCloudflareImport(author: string, subject: string): boolean {
  return /^cloudflare[\w-]*\[bot\]$/i.test(author.trim()) || /^source repo import$/i.test(subject.trim());
}

export type Mode = 'deploy' | 'push';

export interface ModeFacts {
  push: boolean;
  deploy: boolean;
  origin: string | null;
  originIsOfficial: boolean;
  cloudflareImport: boolean;
  /** Null when it was not checked. */
  wranglerLoggedIn: boolean | null;
  branch: string;
}

/**
 * Deploying from this computer and pushing for Workers Builds both put new code
 * live, but doing the wrong one either fails or leaves the GitHub copy behind
 * what is running. When the signs point to the other mode, stop and name the
 * flag rather than guess.
 */
export function decideMode(f: ModeFacts): { mode: Mode } | Stop {
  const ownOrigin = f.origin !== null && !f.originIsOfficial;
  if (f.push) {
    if (f.origin === null) {
      return {
        stop: 'There is nowhere to push: this copy has no "origin" remote.',
        hint:
          '--push is for copies that Cloudflare deploys from your own GitHub repository.\n' +
          'Run this inside a clone of that repository, or connect this folder to it once:\n' +
          '  git remote add origin https://github.com/YOUR-NAME/YOUR-REPO.git',
      };
    }
    if (f.originIsOfficial) {
      return {
        stop: 'Your "origin" is the official repository, which you cannot push to.',
        hint:
          'You cloned the official repository, so you deploy from this computer. Run:\n' +
          '  npm run update',
      };
    }
    return { mode: 'push' };
  }
  if (f.deploy) {
    if (f.wranglerLoggedIn === false) return notLoggedIn(false);
    return { mode: 'deploy' };
  }
  if (f.cloudflareImport && ownOrigin) {
    return {
      stop: 'This copy came from the Deploy to Cloudflare button, so Cloudflare deploys it from GitHub.',
      hint:
        'Update it by pushing to GitHub, and Workers Builds deploys it:\n' +
        '  npm run update -- --push\n' +
        'Deploying from this computer instead would leave GitHub behind, and the next build\n' +
        'Cloudflare runs from GitHub would put the old version back.',
    };
  }
  if (f.wranglerLoggedIn === false) return notLoggedIn(ownOrigin);
  return { mode: 'deploy' };
}

function notLoggedIn(ownOrigin: boolean): Stop {
  if (ownOrigin) {
    return {
      stop: 'You are not logged in to Cloudflare on this computer.',
      hint:
        'If Cloudflare deploys your copy from GitHub (the Deploy button or Workers Builds), push instead:\n' +
        '  npm run update -- --push\n' +
        'If you deploy from this computer, log in first, then run npm run update again:\n' +
        '  npx wrangler login',
    };
  }
  return {
    stop: 'You are not logged in to Cloudflare, which the deploy needs.',
    hint: 'Log in, then run npm run update again:\n  npx wrangler login',
  };
}

/** Quotes a path for a command the person will copy, only when it needs it. */
export function shellQuote(path: string): string {
  return /^[\w./@+-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

function bullet(paths: string[]): string {
  return paths.map((p) => `  ${p}`).join('\n');
}

export function dirtyMessage(paths: string[]): Stop {
  return {
    stop: 'You have edits that are not saved in git yet, so nothing was updated.',
    hint:
      `${bullet(paths)}\n\n` +
      'Save them, then run npm run update again:\n' +
      '  git commit -am "My changes"\n' +
      'Or, if you do not need them, throw them away:\n' +
      `  git checkout -- ${paths.map(shellQuote).join(' ')}`,
  };
}

export interface ConflictInput {
  files: string[];
  /** Conflicted files the new version deletes. */
  goneUpstream: string[];
  mode: Mode;
  branch: string;
  /** The person has an uncommitted database_id line, which a plain git merge refuses to work around. */
  stashFirst: boolean;
  /**
   * The official commit the copy was only a close match for, which was not
   * kept. A merge by hand has to record it first, and the clash may come from
   * the guess rather than from the person's edits.
   */
  recordFirst?: string | null;
}

/**
 * The merge was backed out, so the person's files are untouched. The message
 * has to say which of their edits clashed and give both ways out, because
 * conflict markers are not something a creator should meet unannounced.
 */
export function conflictMessage({ files, goneUpstream, mode, branch, stashFirst, recordFirst }: ConflictInput): Stop {
  const takeable = files.filter((f) => f !== 'wrangler.toml');
  const checkout = takeable.filter((f) => !goneUpstream.includes(f));
  const remove = takeable.filter((f) => goneUpstream.includes(f));
  const finish =
    mode === 'push' ? `  git push origin ${shellQuote(branch)}` : '  npm ci\n  npm run deploy';
  const again = mode === 'push' ? '  npm run update -- --push' : '  npm run update';

  const parts = recordFirst
    ? [
        'These files clash with the new version:',
        bullet(files),
        'Your copy did not exactly match an official version, so a clash can come from an official',
        'change your copy already had, as well as from your own edits. Nothing was merged: your',
        'files are exactly as they were.',
      ]
    : [
        'These files have edits of your own that clash with the new version:',
        bullet(files),
        'Your edits to them are the cause. Nothing was merged: your files are exactly as they were.',
      ];
  if (files.includes('wrangler.toml')) {
    parts.push(
      '',
      'wrangler.toml holds your Worker name and database id, so fix it by hand (the second way below):',
      'keep your own name and database_id lines and take everything else from the new version.',
    );
  }
  if (takeable.length) {
    parts.push('', 'To use the new version of these files and drop your edits to them:');
    if (checkout.length) parts.push(`  git checkout upstream/${UPSTREAM_BRANCH} -- ${checkout.map(shellQuote).join(' ')}`);
    if (remove.length) parts.push(`  git rm ${remove.map(shellQuote).join(' ')}`);
    parts.push('  git commit -m "Use the new version of the files that clashed"', again);
  }
  parts.push('', 'To keep your edits, merge by hand:');
  // The set-aside database_id line is back in wrangler.toml now, and git
  // will not merge over an uncommitted change to a file the update touches.
  if (stashFirst) parts.push('  git stash');
  if (recordFirst) {
    parts.push(`  git merge -s ours --allow-unrelated-histories -m "Record where this copy started" ${recordFirst}`);
  }
  parts.push(
    `  git merge upstream/${UPSTREAM_BRANCH}`,
    '  In each file above, keep the lines you want and delete the <<<<<<<, ======= and >>>>>>> lines.',
    '  git add <each file>',
    '  git commit --no-edit',
  );
  if (stashFirst) parts.push('  git stash pop');
  parts.push(finish);
  return {
    stop: 'The new version changes lines you have also changed.',
    hint: parts.join('\n'),
  };
}

/**
 * Files git refused to overwrite before the merge started, from its "would be
 * overwritten by merge" error. Untracked files are the usual case: something
 * the person created that the new version now adds too.
 */
export function blockingFiles(gitOutput: string): string[] {
  const files: string[] = [];
  let listing = false;
  for (const line of gitOutput.split('\n')) {
    if (/would be overwritten by merge/.test(line)) {
      listing = true;
      continue;
    }
    if (listing && line.startsWith('\t')) files.push(line.trim());
    else if (listing) listing = false;
  }
  return files;
}

export type InProgress = 'rebase' | 'bisect' | 'merge' | 'cherry-pick' | 'revert';

/** Something git is in the middle of, which has to be finished or cancelled first. */
export function inProgressMessage(kind: InProgress): Stop {
  const ways: Record<InProgress, [string, string]> = {
    rebase: ['A rebase is still in progress.', 'Finish it with git rebase --continue, or cancel it with git rebase --abort.'],
    bisect: ['A git bisect is still in progress.', 'End it with git bisect reset.'],
    merge: ['An earlier merge is still unfinished.', 'Finish it with git commit, or cancel it with git merge --abort.'],
    'cherry-pick': ['A cherry-pick is still in progress.', 'Finish it with git cherry-pick --continue, or cancel it with git cherry-pick --abort.'],
    revert: ['A revert is still in progress.', 'Finish it with git revert --continue, or cancel it with git revert --abort.'],
  };
  const [stop, how] = ways[kind];
  return { stop, hint: `${how}\nThen run npm run update again.` };
}

/** The merge stopped without a clash, usually a commit hook or signing failing, and was backed out. */
export function mergeStoppedMessage(gitOutput: string): Stop {
  return {
    stop: 'Git stopped before it finished the merge, so the update was backed out.',
    hint:
      'Nothing clashed. This usually means a git hook or commit signing failed. Git said:\n' +
      `${gitOutput.trim().replace(/^/gm, '  ')}\n\n` +
      'Your files are as they were. Fix what git says, then run npm run update again.',
  };
}

/** `git merge --abort` itself failed, so nothing can be promised about the files. */
export function abortFailedMessage(gitOutput: string): Stop {
  return {
    stop: 'The merge stopped, and git could not back it out cleanly.',
    hint:
      'Git said:\n' +
      `${gitOutput.trim().replace(/^/gm, '  ')}\n\n` +
      'Run these to put your copy back and see where it stands, then run npm run update again:\n' +
      '  git merge --abort\n' +
      '  git status',
  };
}

export function blockedMessage(files: string[]): Stop {
  return {
    stop: 'The new version adds files that already exist in this folder, so nothing was updated.',
    hint:
      `${bullet(files)}\n\n` +
      'They are not saved in git, so git will not overwrite them. Move them out of this folder\n' +
      '(or delete them if you do not need them), then run npm run update again.',
  };
}

export function identityMessage(): Stop {
  return {
    stop: 'Git does not know your name and email yet, and it needs them to record the update.',
    hint:
      'Tell it once, then run npm run update again:\n' +
      '  git config --global user.name "Your Name"\n' +
      '  git config --global user.email "you@example.com"\n' +
      'They label the commits made on this computer.',
  };
}

/** For a copy that is not a git repository, which almost always means a ZIP download. */
export function noGitMessage(gitInstalled: boolean): Stop {
  const fresh =
    'Start from a fresh copy (simplest). Download the latest version:\n' +
    `     ${LATEST_ZIP}\n` +
    '   Unzip it into a new folder, and in that folder run:\n' +
    '     npm install\n' +
    '     npm run deploy\n' +
    '   Your secrets and your database live in Cloudflare, so nothing is lost.\n' +
    '   If you changed any files here, copy them across first.';
  if (!gitInstalled) {
    return {
      stop: 'Git is not installed on this computer, and npm run update uses it to fetch the new version.',
      hint:
        'Either:\n\n' +
        '1. Install git from https://git-scm.com/downloads, then follow the steps this command prints next.\n\n' +
        `2. ${fresh}`,
    };
  }
  return {
    stop: 'This folder is not a git repository, so there is no history to update. It probably came from a ZIP download.',
    hint:
      'Two ways to update:\n\n' +
      `1. ${fresh}\n\n` +
      '2. Let npm run update handle this and every later update. Make this folder a git repository once:\n' +
      '     git init\n' +
      '     git add .\n' +
      '     git commit -m "My copy"\n' +
      '   then run npm run update again. It works out which version you downloaded.',
  };
}

/** The same reading of `wrangler deploy` output that setup.ts uses. */
export function workerUrlFrom(deployOutput: string): string | null {
  const matches = deployOutput.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/gi);
  if (matches?.length) return matches[matches.length - 1];
  const custom = deployOutput.match(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?=\s|$)/gi);
  return custom?.length ? custom[custom.length - 1] : null;
}

/** The top-level Worker name in wrangler.toml, before the first [table]. */
export function workerName(toml: string): string | null {
  for (const line of toml.split('\n')) {
    if (/^\s*\[/.test(line)) break;
    const m = line.match(/^\s*name\s*=\s*"([^"]+)"/);
    if (m) return m[1];
  }
  return null;
}

/** Turns a /health response into one line for the person, and whether it is good news. */
export function describeHealth(status: number, body: string): { ok: boolean; message: string } {
  let parsed: { database?: unknown; cron?: unknown; poll?: unknown } = {};
  try {
    const value: unknown = JSON.parse(body);
    if (value && typeof value === 'object') parsed = value as typeof parsed;
  } catch {
    // Not JSON: fall through to the status code alone.
  }
  if (status === 200) {
    const starting = parsed.cron === 'starting' || parsed.poll === 'starting';
    return {
      ok: true,
      message: starting
        ? 'Health check passed. The scheduled jobs have not run yet, which is normal right after a first deploy.'
        : 'Health check passed: the database answers and both scheduled jobs are running.',
    };
  }
  if (status === 503) {
    const problems: string[] = [];
    if (parsed.database === 'error') problems.push('the database did not answer');
    if (parsed.cron === 'stale') problems.push('the nightly token refresh has stalled');
    if (parsed.poll === 'stale') problems.push('the 5-minute comment poll has stalled');
    const what = problems.length ? problems.join(', and ') : 'something has stalled';
    return {
      ok: false,
      message:
        `Your copy is live, but /health says ${what}. ` +
        'See docs/troubleshooting.md, "/health answers 503".',
    };
  }
  return { ok: false, message: `/health answered with HTTP ${status}. Run npm run doctor to see what is wrong.` };
}
