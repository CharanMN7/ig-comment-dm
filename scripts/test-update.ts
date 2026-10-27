import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  OFFICIAL_REPO,
  abortFailedMessage,
  blockingFiles,
  changedPaths,
  conflictMessage,
  databaseIdLineIn,
  decideMode,
  describeHealth,
  dirtyMessage,
  inProgressMessage,
  isExactMatch,
  looksLikeCloudflareImport,
  mergeStoppedMessage,
  missingPaths,
  newMigrations,
  onlyDatabaseIdChange,
  parseArgs,
  parseLog,
  pickStartingPoint,
  repoKey,
  restoreDatabaseId,
  sameRepo,
  treeDifference,
  workerName,
  workerUrlFrom,
} from './update-lib.ts';
import type { Candidate, ModeFacts } from './update-lib.ts';

describe('parseArgs', () => {
  it('reads every flag', () => {
    assert.deepEqual(parseArgs(['--yes', '--dry-run', '--push']), {
      yes: true,
      dryRun: true,
      push: true,
      deploy: false,
      help: false,
    });
  });

  it('refuses an unknown flag and --push with --deploy', () => {
    assert.deepEqual(parseArgs(['--force']), { error: 'Unknown option: --force' });
    assert.ok('error' in parseArgs(['--push', '--deploy']));
  });
});

describe('sameRepo', () => {
  it('treats the HTTPS and SSH spellings of one repository as the same', () => {
    assert.equal(sameRepo('https://github.com/CharanMN7/ig-comment-dm.git', OFFICIAL_REPO), true);
    assert.equal(sameRepo('https://github.com/charanmn7/ig-comment-dm', OFFICIAL_REPO), true);
    assert.equal(sameRepo('git@github.com:CharanMN7/ig-comment-dm.git', OFFICIAL_REPO), true);
    assert.equal(sameRepo('ssh://git@github.com/CharanMN7/ig-comment-dm.git/', OFFICIAL_REPO), true);
  });

  it('tells a fork or a Deploy button copy apart from the official repository', () => {
    assert.equal(sameRepo('https://github.com/someone/ig-comment-dm.git', OFFICIAL_REPO), false);
    assert.equal(sameRepo('git@github.com:someone/my-dm-bot.git', OFFICIAL_REPO), false);
    assert.equal(repoKey('git@github.com:someone/my-dm-bot.git'), 'github.com/someone/my-dm-bot');
  });
});

describe('changedPaths', () => {
  it('lists modified, staged and renamed files, skipping the name a rename came from', () => {
    const porcelain = ' M README.md\0A  src/new.ts\0R  src/after.ts\0src/before.ts\0MM a file.ts\0';
    assert.deepEqual(changedPaths(porcelain), ['README.md', 'src/new.ts', 'src/after.ts', 'a file.ts']);
  });

  it('is empty for a clean tree', () => {
    assert.deepEqual(changedPaths(''), []);
  });
});

const DIFF_HEADER = 'diff --git a/wrangler.toml b/wrangler.toml\nindex 1111111..2222222 100644\n--- a/wrangler.toml\n+++ b/wrangler.toml\n';

describe('onlyDatabaseIdChange', () => {
  it('returns the database_id line when it is the only change', () => {
    const diff = `${DIFF_HEADER}@@ -11,0 +12 @@ database_name = "ig-comment-dm"\n+database_id = "0b1c2d3e-aaaa-bbbb-cccc-1234567890ab"\n`;
    assert.equal(onlyDatabaseIdChange(diff), 'database_id = "0b1c2d3e-aaaa-bbbb-cccc-1234567890ab"');
  });

  it('accepts a placeholder replaced by a real id', () => {
    const diff = `${DIFF_HEADER}@@ -12 +12 @@\n-database_id = "REPLACE_ME"\n+database_id = "0b1c2d3e"\n`;
    assert.equal(onlyDatabaseIdChange(diff), 'database_id = "0b1c2d3e"');
  });

  it('returns null when anything else changed too', () => {
    const diff = `${DIFF_HEADER}@@ -1 +1 @@\n-name = "ig-comment-dm"\n+name = "mine"\n@@ -11,0 +12 @@\n+database_id = "0b1c2d3e"\n`;
    assert.equal(onlyDatabaseIdChange(diff), null);
    assert.equal(onlyDatabaseIdChange(''), null);
  });
});

describe('restoreDatabaseId', () => {
  const toml = 'name = "x"\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "ig-comment-dm"\nmigrations_dir = "migrations"\n';

  it('puts the line back under database_name', () => {
    assert.equal(
      restoreDatabaseId(toml, 'database_id = "abc"'),
      'name = "x"\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "ig-comment-dm"\ndatabase_id = "abc"\nmigrations_dir = "migrations"\n',
    );
  });

  it('finds the line, or says there is none', () => {
    assert.equal(databaseIdLineIn(toml), null);
    assert.equal(databaseIdLineIn(toml.replace('binding', 'database_id = "abc"\nbinding')), 'database_id = "abc"');
  });

  it('leaves a file alone that already has an id, or has nowhere to put one', () => {
    assert.equal(restoreDatabaseId(toml.replace('binding', 'database_id = "other"\nbinding'), 'database_id = "abc"'), null);
    assert.equal(restoreDatabaseId('name = "x"\n', 'database_id = "abc"'), null);
  });
});

describe('reading git output', () => {
  it('parses log lines, keeping tabs inside a subject', () => {
    assert.deepEqual(parseLog('abc1234\tFix the thing.\ndef5678\tA\ttabbed subject.\n'), [
      { sha: 'abc1234', subject: 'Fix the thing.' },
      { sha: 'def5678', subject: 'A\ttabbed subject.' },
    ]);
  });

  it('finds only migration files the update adds', () => {
    const nameStatus = 'A\tmigrations/005_rule_exclude_keywords.sql\nM\tmigrations/001_init.sql\nA\tmigrations/README.md\nA\tsrc/migrations/x.sql\nA\tmigrations/006_match_all.sql';
    assert.deepEqual(newMigrations(nameStatus), ['migrations/005_rule_exclude_keywords.sql', 'migrations/006_match_all.sql']);
    assert.deepEqual(newMigrations(''), []);
  });

  it('totals differing lines, keeping wrangler.toml apart, and counts each missing file or directory once', () => {
    const copy = ['src/a.ts', 'src/mine.ts', 'logo.png', 'README.md', 'wrangler.toml', 'migrations/001_init.sql'];
    const out =
      '3\t1\tsrc/a.ts\n-\t-\tlogo.png\n0\t10\tREADME.md\n2\t0\twrangler.toml\n' +
      '0\t1\tmigrations/002_note.sql\n0\t40\tsite/a.md\n0\t60\tsite/deep/b.md\n0\t5\tsrc/gone.ts\n' +
      ' delete mode 100644 migrations/002_note.sql\n delete mode 100644 site/a.md\n delete mode 100644 site/deep/b.md\n' +
      ' delete mode 100644 src/gone.ts\n create mode 100644 src/mine.ts\n';
    assert.deepEqual(treeDifference(out, copy), {
      distance: 4 + 1 + 10 + 3,
      wranglerDistance: 2,
      missing: ['migrations/002_note.sql', 'site/', 'src/gone.ts'],
      missingMigrations: ['migrations/002_note.sql'],
    });
    assert.deepEqual(treeDifference('', copy), { distance: 0, wranglerDistance: 0, missing: [], missingMigrations: [] });
  });

  it('groups missing files under the highest directory the copy has nothing in', () => {
    const copy = ['src/index.ts', '.github/ISSUE_TEMPLATE/bug.md'];
    assert.deepEqual(missingPaths(['site/a.md', 'site/b/c.md', 'src/gone.ts', '.github/workflows/ci.yml', 'LICENSE'], copy), [
      'site/',
      'src/gone.ts',
      '.github/workflows/',
      'LICENSE',
    ]);
  });

  it('reads the files git refuses to overwrite', () => {
    const out =
      'Updating 1111111..2222222\n' +
      'error: The following untracked working tree files would be overwritten by merge:\n' +
      '\tmigrations/002_add_column.sql\n' +
      '\tsrc/new.ts\n' +
      'Please move or remove them before you merge.\nAborting\n';
    assert.deepEqual(blockingFiles(out), ['migrations/002_add_column.sql', 'src/new.ts']);
    assert.deepEqual(blockingFiles('fatal: something else\n'), []);
  });
});

describe('pickStartingPoint', () => {
  const c = (sha: string, distance: number, wranglerDistance = 0, missing: string[] = []): Candidate => ({
    sha,
    distance,
    wranglerDistance,
    missing,
    missingMigrations: missing.filter((f) => f.startsWith('migrations/')),
  });

  it('picks the closest official commit', () => {
    assert.equal(pickStartingPoint([c('c3', 40), c('c2', 0), c('c1', 12)])?.sha, 'c2');
    assert.equal(pickStartingPoint([]), null);
  });

  it('breaks a tie toward the oldest, since guessing too new drops changes silently', () => {
    assert.equal(pickStartingPoint([c('c3', 0), c('c2', 0), c('c1', 0)])?.sha, 'c1');
  });

  it('uses wrangler.toml to tell apart commits that differ only there', () => {
    // c2 added a cron trigger to wrangler.toml; a copy of c1 does not have it.
    assert.equal(pickStartingPoint([c('c3', 4, 3), c('c2', 0, 3), c('c1', 0, 0)])?.sha, 'c1');
    // A Deploy button copy of c2: Cloudflare's database_id line is one more line.
    assert.equal(pickStartingPoint([c('c2', 0, 1), c('c1', 0, 4)])?.sha, 'c2');
  });

  it('rules out a commit with a migration the copy lacks, even when it is closer', () => {
    // The copy has a fix copied by hand from c3, but not c2's migration.
    const picked = pickStartingPoint([
      c('c4', 4, 0, ['migrations/002_note.sql']),
      c('c3', 2, 0, ['migrations/002_note.sql']),
      c('c2', 23, 0, ['migrations/002_note.sql']),
      c('c1', 21),
    ]);
    assert.equal(picked?.sha, 'c1');
    assert.equal(isExactMatch(picked as Candidate), false);
  });

  it('does not rule out a commit for any other missing folder, which the person may have deleted', () => {
    // A download of c3 with site/ (added in c2) deleted, or a Deploy button copy
    // without .github/workflows/: going back to c1 would be too old.
    const picked = pickStartingPoint([c('c4', 3, 0, ['site/']), c('c3', 1, 0, ['site/']), c('c2', 3, 0, ['site/']), c('c1', 2)]);
    assert.equal(picked?.sha, 'c3');
    assert.equal(isExactMatch(picked as Candidate), false);
    assert.equal(isExactMatch(c('c1', 0)), true);
  });
});

describe('looksLikeCloudflareImport', () => {
  it('recognises the commit the Deploy to Cloudflare button makes', () => {
    assert.equal(looksLikeCloudflareImport('cloudflare[bot]', 'source repo import'), true);
    assert.equal(looksLikeCloudflareImport('cloudflare-workers-and-pages[bot]', 'Initial commit'), true);
    assert.equal(looksLikeCloudflareImport('Someone', 'Source repo import'), true);
  });

  it('does not flag an ordinary first commit', () => {
    assert.equal(looksLikeCloudflareImport('Charan', 'Stand up a single-tenant Cloudflare Worker.'), false);
    assert.equal(looksLikeCloudflareImport('Someone', 'My copy'), false);
  });
});

describe('decideMode', () => {
  const facts = (over: Partial<ModeFacts>): ModeFacts => ({
    push: false,
    deploy: false,
    origin: OFFICIAL_REPO,
    originIsOfficial: true,
    cloudflareImport: false,
    wranglerLoggedIn: true,
    branch: 'master',
    ...over,
  });
  const fork = { origin: 'git@github.com:me/copy.git', originIsOfficial: false };

  it('deploys a clone from this computer', () => {
    assert.deepEqual(decideMode(facts({})), { mode: 'deploy' });
    assert.deepEqual(decideMode(facts({ origin: null, originIsOfficial: false })), { mode: 'deploy' });
  });

  it('pushes when asked, but only to a repository of your own', () => {
    assert.deepEqual(decideMode(facts({ push: true, ...fork })), { mode: 'push' });
    const official = decideMode(facts({ push: true }));
    assert.ok('stop' in official && /cannot push/.test(official.stop));
    const none = decideMode(facts({ push: true, origin: null, originIsOfficial: false }));
    assert.ok('stop' in none && /nowhere to push/.test(none.stop));
  });

  it('stops and suggests --push for a Deploy button copy, without guessing', () => {
    const decision = decideMode(facts({ ...fork, cloudflareImport: true }));
    assert.ok('stop' in decision);
    assert.match(decision.hint, /npm run update -- --push/);
    assert.doesNotMatch(decision.hint, /--deploy/);
    assert.match(decision.hint, /put the old version back/);
    assert.deepEqual(decideMode(facts({ ...fork, cloudflareImport: true, deploy: true })), { mode: 'deploy' });
  });

  it('suggests --push when there is no Cloudflare login but a GitHub copy exists', () => {
    const decision = decideMode(facts({ ...fork, wranglerLoggedIn: false }));
    assert.ok('stop' in decision);
    assert.match(decision.hint, /--push/);
    assert.match(decision.hint, /npx wrangler login/);
  });

  it('only asks a clone with no login to log in', () => {
    const decision = decideMode(facts({ wranglerLoggedIn: false }));
    assert.ok('stop' in decision);
    assert.doesNotMatch(decision.hint, /--push/);
    assert.match(decision.hint, /npx wrangler login/);
  });

  it('does not block on a login it could not check', () => {
    assert.deepEqual(decideMode(facts({ wranglerLoggedIn: null })), { mode: 'deploy' });
  });
});

describe('conflictMessage', () => {
  it('names the files, blames the edits and gives both ways out', () => {
    const { stop, hint } = conflictMessage({
      files: ['src/index.ts', 'README.md'],
      goneUpstream: [],
      mode: 'deploy',
      branch: 'master',
      stashFirst: false,
    });
    assert.match(stop, /changes lines you have also changed/);
    assert.match(hint, /  src\/index.ts\n  README.md/);
    assert.match(hint, /Your edits to them are the cause/);
    assert.match(hint, /git checkout upstream\/master -- src\/index.ts README.md/);
    assert.match(hint, /git merge upstream\/master/);
    assert.match(hint, /npm ci\n  npm run deploy$/);
    assert.doesNotMatch(hint, /git stash/);
  });

  it('removes files the new version deleted instead of checking them out', () => {
    const { hint } = conflictMessage({ files: ['a.ts', 'old.ts'], goneUpstream: ['old.ts'], mode: 'deploy', branch: 'master', stashFirst: false });
    assert.match(hint, /git checkout upstream\/master -- a.ts\n/);
    assert.match(hint, /git rm old.ts/);
  });

  it('never offers to replace wrangler.toml wholesale, and finishes a push copy with a push', () => {
    const { hint } = conflictMessage({ files: ['wrangler.toml'], goneUpstream: [], mode: 'push', branch: 'main', stashFirst: false });
    assert.match(hint, /keep your own name and database_id lines/);
    assert.doesNotMatch(hint, /git checkout upstream/);
    assert.match(hint, /git push origin main$/);
    const pushCopy = conflictMessage({ files: ['src/a.ts'], goneUpstream: [], mode: 'push', branch: 'my branch', stashFirst: false });
    assert.match(pushCopy.hint, /clashed"\n  npm run update -- --push\n/);
    assert.match(pushCopy.hint, /git push origin 'my branch'$/);
  });

  it('does not blame the person for a clash an inexact guess may have caused, and records it in a merge by hand', () => {
    const { hint } = conflictMessage({
      files: ['src/index.ts'],
      goneUpstream: [],
      mode: 'deploy',
      branch: 'master',
      stashFirst: false,
      recordFirst: 'abc1234',
    });
    assert.doesNotMatch(hint, /Your edits to them are the cause/);
    assert.match(hint, /did not exactly match an official version/);
    assert.match(hint, /git merge -s ours --allow-unrelated-histories -m "Record where this copy started" abc1234\n  git merge upstream\/master/);
  });

  it('sets an uncommitted database_id aside around a merge by hand', () => {
    const { hint } = conflictMessage({ files: ['src/a.ts'], goneUpstream: [], mode: 'deploy', branch: 'master', stashFirst: true });
    assert.match(hint, /  git stash\n  git merge upstream\/master\n[\s\S]*git commit --no-edit\n  git stash pop\n  npm ci\n  npm run deploy$/);
  });
});

describe('messages and readings', () => {
  it('says how to finish or cancel what git is in the middle of, not to switch branches', () => {
    assert.match(inProgressMessage('rebase').hint, /git rebase --abort/);
    assert.match(inProgressMessage('bisect').hint, /git bisect reset/);
    assert.doesNotMatch(inProgressMessage('rebase').hint, /checkout/);
  });

  it('does not blame the person for a merge a hook stopped, or promise anything when abort fails', () => {
    const stopped = mergeStoppedMessage('error: gpg failed to sign the data\n');
    assert.match(stopped.hint, /Nothing clashed/);
    assert.match(stopped.hint, /gpg failed/);
    const failed = abortFailedMessage('fatal: could not reset index\n');
    assert.doesNotMatch(failed.hint, /exactly as they were/);
    assert.match(failed.hint, /git merge --abort\n  git status/);
  });

  it('quotes a path with spaces in the command to throw edits away', () => {
    assert.match(dirtyMessage(['my notes.md', 'src/a.ts']).hint, /git checkout -- 'my notes.md' src\/a.ts/);
  });

  it('reads the Worker URL from deploy output the way setup does', () => {
    assert.equal(
      workerUrlFrom('Uploaded ig-comment-dm\nDeployed ig-comment-dm triggers\n  https://ig-comment-dm.someone.workers.dev\n'),
      'https://ig-comment-dm.someone.workers.dev',
    );
    assert.equal(workerUrlFrom('nothing here'), null);
  });

  it('reads the top-level Worker name, not a name inside a table', () => {
    assert.equal(workerName('main = "src/index.ts"\nname = "my-dm"\n[[workflows]]\nname = "other"\n'), 'my-dm');
    assert.equal(workerName('[[workflows]]\nname = "other"\n'), null);
  });

  it('turns /health answers into plain words', () => {
    assert.equal(describeHealth(200, '{"ok":true,"cron":"ok","poll":"ok"}').ok, true);
    assert.match(describeHealth(200, '{"ok":true,"cron":"starting","poll":"ok"}').message, /not run yet/);
    const stale = describeHealth(503, '{"ok":false,"database":"ok","cron":"stale","poll":"ok"}');
    assert.equal(stale.ok, false);
    assert.match(stale.message, /nightly token refresh has stalled/);
    assert.match(describeHealth(503, '{"ok":false,"database":"error"}').message, /database did not answer/);
    assert.match(describeHealth(404, 'Not Found').message, /HTTP 404/);
  });
});

// ---------------------------------------------------------------------------
// End to end: the real script against throwaway repositories. "upstream.git"
// stands in for GitHub, install and deploy are skipped, and nothing touches the
// network or the person's own git config.

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

const WRANGLER_V1 = `name = "ig-comment-dm"
main = "src/index.ts"
compatibility_date = "2026-08-14"

[[d1_databases]]
binding = "DB"
database_name = "ig-comment-dm"
migrations_dir = "migrations"
`;

const INDEX_V1 = 'export const greeting = "hello";\n\nexport const a = 1;\nexport const b = 2;\nexport const c = 3;\n';

const DB_NAME = 'database_name = "ig-comment-dm"\n';
const withDatabaseId = (toml: string, id: string): string => toml.replace(DB_NAME, `${DB_NAME}database_id = "${id}"\n`);
const BACKUP = join('.git', 'ig-comment-dm-update-wrangler.toml');

describe('npm run update, end to end', () => {
  let dir = '';
  let env: Record<string, string> = {};
  let v1 = '';
  let v2 = '';

  const sh = (cwd: string, args: string[]): string => {
    const res = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(res.status, 0, `git ${args.join(' ')} failed:\n${res.stdout}${res.stderr}`);
    return res.stdout.trim();
  };

  const updateWith = (
    opts: { env?: Record<string, string>; input?: string },
    cwd: string,
    ...args: string[]
  ): { code: number; out: string } => {
    const res = spawnSync(process.execPath, ['--experimental-strip-types', join(cwd, 'scripts/update.ts'), ...args], {
      cwd,
      env: { ...env, ...opts.env },
      encoding: 'utf8',
      input: opts.input ?? '',
    });
    return { code: res.status ?? 1, out: `${res.stdout}${res.stderr}` };
  };
  const update = (cwd: string, ...args: string[]) => updateWith({}, cwd, ...args);

  const write = (path: string, text: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };

  const head = (cwd: string): string => sh(cwd, ['rev-parse', 'HEAD']);

  // What the button leaves in someone's GitHub: the first version's files in a
  // single commit by Cloudflare's bot, with history of its own and the new
  // database id written into wrangler.toml. Returns a clone of it.
  const buttonCopy = (): { local: string; github: string } => {
    const made = join(dir, `button-${n}`);
    mkdirSync(made);
    sh(made, ['init', '-q', '-b', 'main']);
    sh(made, ['fetch', '-q', join(dir, 'v1.git'), 'master']);
    sh(made, ['read-tree', '--reset', '-u', 'FETCH_HEAD']);
    write(join(made, 'wrangler.toml'), withDatabaseId(WRANGLER_V1, 'c0ffee00'));
    sh(made, ['add', '.']);
    sh(made, ['commit', '-q', '--author', 'cloudflare[bot] <bot@cloudflare.com>', '-m', 'source repo import']);
    const github = join(dir, `button-${n}.git`);
    sh(dir, ['clone', '-q', '--bare', made, github]);
    const local = join(dir, `button-clone-${n}`);
    sh(dir, ['clone', '-q', github, local]);
    return { local, github };
  };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ig-update-'));
    write(join(dir, 'gitconfig'), '');
    const inherited = Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && !/^(GIT_|UPDATE_)/.test(entry[0]),
    );
    env = {
      ...Object.fromEntries(inherited),
      HOME: dir,
      GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      NO_COLOR: '1',
      UPDATE_UPSTREAM_URL: join(dir, 'upstream.git'),
      UPDATE_SKIP_INSTALL_AND_DEPLOY: '1',
    };

    // The official repository: a first version, then two changes made after
    // everyone below copied it.
    const work = join(dir, 'work');
    mkdirSync(work);
    sh(work, ['init', '-q', '-b', 'master']);
    for (const name of ['update.ts', 'update-lib.ts', 'wrangler.ts']) {
      mkdirSync(join(work, 'scripts'), { recursive: true });
      copyFileSync(join(SCRIPTS, name), join(work, 'scripts', name));
    }
    write(join(work, 'package.json'), '{ "name": "fixture", "private": true, "type": "module" }\n');
    write(join(work, 'wrangler.toml'), WRANGLER_V1);
    write(join(work, 'migrations/001_init.sql'), 'CREATE TABLE IF NOT EXISTS rules (id INTEGER PRIMARY KEY);\n');
    write(join(work, 'src/index.ts'), INDEX_V1);
    write(join(work, 'README.md'), '# Fixture\n');
    sh(work, ['add', '.']);
    sh(work, ['commit', '-q', '-m', 'First version.']);
    v1 = head(work);
    sh(dir, ['clone', '-q', '--bare', work, 'v1.git']);

    write(join(work, 'migrations/002_add_column.sql'), 'ALTER TABLE rules ADD COLUMN note TEXT;\n');
    sh(work, ['add', '.']);
    sh(work, ['commit', '-q', '-m', 'Add a migration.']);
    write(join(work, 'src/index.ts'), INDEX_V1.replace('"hello"', '"HELLO"'));
    write(join(work, 'wrangler.toml'), WRANGLER_V1.replace('2026-08-14', '2026-10-01'));
    sh(work, ['commit', '-q', '-am', 'Say hello louder.']);
    v2 = head(work);
    sh(dir, ['clone', '-q', '--bare', work, 'upstream.git']);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // A clone of the first version, as someone who ran npm run setup has.
  let copy = '';
  let n = 0;
  beforeEach(() => {
    copy = join(dir, `copy-${++n}`);
    sh(dir, ['clone', '-q', join(dir, 'v1.git'), copy]);
  });

  it('shows what is new on a dry run and changes nothing', () => {
    const { code, out } = update(copy, '--dry-run');
    assert.equal(code, 0, out);
    assert.match(out, /2 new changes since your copy/);
    assert.match(out, /Add a migration\./);
    assert.match(out, /Say hello louder\./);
    assert.match(out, /This update changes your database: 1 new migration\n\s+migrations\/002_add_column\.sql/);
    assert.match(out, /Dry run finished/);
    assert.equal(head(copy), v1);
    assert.equal(sh(copy, ['remote']), 'origin');
    assert.equal(existsSync(join(copy, 'migrations/002_add_column.sql')), false);
  });

  it('fast-forwards with --yes, adds the upstream remote, and then has nothing to do', () => {
    const first = update(copy, '--yes');
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /Moved forward to the latest version/);
    assert.equal(head(copy), v2);
    assert.equal(sh(copy, ['remote', 'get-url', 'upstream']), join(dir, 'upstream.git'));
    assert.equal(sh(copy, ['remote', 'get-url', 'origin']), join(dir, 'v1.git'));
    assert.equal(existsSync(join(copy, 'migrations/002_add_column.sql')), true);

    const again = update(copy, '--yes');
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /already has everything/);
  });

  it('merges alongside a commit of your own', () => {
    write(join(copy, 'README.md'), '# My fixture\n');
    sh(copy, ['commit', '-q', '-am', 'Name it.']);
    const mine = head(copy);

    const { code, out } = update(copy, '--yes');
    assert.equal(code, 0, out);
    assert.match(out, /Merged the latest version/);
    assert.equal(sh(copy, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').length, 3);
    sh(copy, ['merge-base', '--is-ancestor', v2, 'HEAD']);
    sh(copy, ['merge-base', '--is-ancestor', mine, 'HEAD']);
    assert.equal(readFileSync(join(copy, 'README.md'), 'utf8'), '# My fixture\n');
    assert.match(readFileSync(join(copy, 'src/index.ts'), 'utf8'), /"HELLO"/);
  });

  it('refuses to start over unsaved edits', () => {
    write(join(copy, 'README.md'), '# Half-finished edit\n');
    const { code, out } = update(copy, '--yes');
    assert.equal(code, 1, out);
    assert.match(out, /not saved in git yet/);
    assert.match(out, /  README\.md/);
    assert.match(out, /git commit -am/);
    assert.equal(head(copy), v1);
    assert.equal(readFileSync(join(copy, 'README.md'), 'utf8'), '# Half-finished edit\n');
  });

  it('backs out a clashing merge, leaves the files alone and names the file', () => {
    write(join(copy, 'src/index.ts'), INDEX_V1.replace('"hello"', '"hi there"'));
    sh(copy, ['commit', '-q', '-am', 'Say hi.']);
    const mine = head(copy);

    const { code, out } = update(copy, '--yes');
    assert.equal(code, 1, out);
    assert.match(out, /changes lines you have also changed/);
    assert.match(out, /  src\/index\.ts\n/);
    assert.match(out, /Your edits to them are the cause/);
    assert.match(out, /git checkout upstream\/master -- src\/index\.ts/);
    assert.equal(head(copy), mine);
    assert.equal(sh(copy, ['status', '--porcelain']), '');
    assert.equal(existsSync(join(copy, '.git/MERGE_HEAD')), false);
    assert.match(readFileSync(join(copy, 'src/index.ts'), 'utf8'), /"hi there"/);
  });

  it('keeps an uncommitted database_id in wrangler.toml across an update that changes the file', () => {
    const toml = WRANGLER_V1.replace('database_name = "ig-comment-dm"\n', 'database_name = "ig-comment-dm"\ndatabase_id = "0b1c2d3e"\n');
    write(join(copy, 'wrangler.toml'), toml);

    const { code, out } = update(copy, '--yes');
    assert.equal(code, 0, out);
    assert.equal(head(copy), v2);
    const after = readFileSync(join(copy, 'wrangler.toml'), 'utf8');
    assert.match(after, /compatibility_date = "2026-10-01"/);
    assert.match(after, /database_name = "ig-comment-dm"\ndatabase_id = "0b1c2d3e"\n/);
    assert.equal(sh(copy, ['status', '--porcelain']), 'M wrangler.toml');
  });

  it('stops instead of overwriting an unsaved file the update adds', () => {
    write(join(copy, 'migrations/002_add_column.sql'), '-- mine\n');
    const { code, out } = update(copy, '--yes');
    assert.equal(code, 1, out);
    assert.match(out, /already exist in this folder/);
    assert.match(out, /  migrations\/002_add_column\.sql/);
    assert.equal(head(copy), v1);
    assert.equal(readFileSync(join(copy, 'migrations/002_add_column.sql'), 'utf8'), '-- mine\n');
  });

  it('updates a Deploy to Cloudflare copy with --push, after working out which version it started from', () => {
    const { local, github } = buttonCopy();
    const imported = head(local);

    const guessed = update(local, '--yes');
    assert.equal(guessed.code, 1, guessed.out);
    assert.match(guessed.out, /came from the Deploy to Cloudflare button/);
    assert.match(guessed.out, /npm run update -- --push/);
    assert.equal(head(local), imported);

    const dry = update(local, '--dry-run', '--push');
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, new RegExp(`started from official version ${v1.slice(0, 7)}`));
    assert.match(dry.out, /2 new changes since your copy/);
    assert.equal(head(local), imported);

    const pushed = update(local, '--yes', '--push');
    assert.equal(pushed.code, 0, pushed.out);
    assert.match(pushed.out, /Pushed main/);
    assert.match(pushed.out, /Deployments → View build history/);
    sh(local, ['merge-base', '--is-ancestor', v2, 'HEAD']);
    assert.equal(sh(github, ['rev-parse', 'main']), head(local));
    const toml = readFileSync(join(local, 'wrangler.toml'), 'utf8');
    assert.match(toml, /database_id = "c0ffee00"/);
    assert.match(toml, /compatibility_date = "2026-10-01"/);
    assert.match(readFileSync(join(local, 'src/index.ts'), 'utf8'), /"HELLO"/);
    assert.equal(existsSync(join(local, 'migrations/002_add_column.sql')), true);

    const again = update(local, '--yes', '--push');
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /already has everything/);
  });

  it('puts back a database_id line that an interrupted update had set aside', () => {
    write(join(copy, BACKUP), withDatabaseId(WRANGLER_V1, 'feedf00d'));
    const { code, out } = update(copy, '--yes');
    assert.equal(code, 0, out);
    assert.match(out, /Put back the database_id line an interrupted update had set aside/);
    assert.equal(head(copy), v2);
    assert.match(readFileSync(join(copy, 'wrangler.toml'), 'utf8'), /database_name = "ig-comment-dm"\ndatabase_id = "feedf00d"\n/);
    assert.equal(existsSync(join(copy, BACKUP)), false);
  });

  it('leaves a stale backup alone when wrangler.toml changed after the interrupted run', () => {
    write(join(copy, BACKUP), withDatabaseId(WRANGLER_V1, 'feedf00d'));
    const anHourAgo = Date.now() / 1000 - 3600;
    utimesSync(join(copy, BACKUP), anHourAgo, anHourAgo);

    const { code, out } = update(copy, '--yes');
    assert.equal(code, 0, out);
    assert.match(out, /wrangler\.toml has changed since: database_id = "feedf00d"/);
    assert.match(out, /Left wrangler\.toml as it is/);
    assert.match(out, /delete \.git\/ig-comment-dm-update-wrangler\.toml/);
    assert.doesNotMatch(readFileSync(join(copy, 'wrangler.toml'), 'utf8'), /database_id/);
    assert.equal(head(copy), v2);
  });

  it('keeps the database_id line safe when the update deletes wrangler.toml', () => {
    const moved = join(dir, `moved-${n}`);
    sh(dir, ['clone', '-q', join(dir, 'v1.git'), moved]);
    sh(moved, ['rm', '-q', 'wrangler.toml']);
    write(join(moved, 'wrangler.jsonc'), '{ "name": "ig-comment-dm" }\n');
    sh(moved, ['add', '.']);
    sh(moved, ['commit', '-q', '-m', 'Move to wrangler.jsonc.']);
    sh(dir, ['clone', '-q', '--bare', moved, `moved-${n}.git`]);
    write(join(copy, 'wrangler.toml'), withDatabaseId(WRANGLER_V1, 'c0ffee00'));

    const { code, out } = updateWith({ env: { UPDATE_UPSTREAM_URL: join(dir, `moved-${n}.git`) } }, copy, '--yes');
    assert.equal(code, 0, out);
    assert.match(out, /has no wrangler\.toml/);
    assert.match(out, /database_id = "c0ffee00"/);
    assert.equal(existsSync(join(copy, 'wrangler.toml')), false);
    assert.match(readFileSync(join(copy, BACKUP), 'utf8'), /database_id = "c0ffee00"/);
    assert.match(out, /delete that file to stop this message/);

    const again = updateWith({ env: { UPDATE_UPSTREAM_URL: join(dir, `moved-${n}.git`) } }, copy, '--yes');
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /no wrangler\.toml to put it back in: database_id = "c0ffee00"/);
    assert.match(again.out, /To stop this message, delete \.git\/ig-comment-dm-update-wrangler\.toml/);
  });

  it('offers to push again after a push that failed, instead of saying there is nothing to do', () => {
    const { local, github } = buttonCopy();
    const before = sh(github, ['rev-parse', 'main']);
    const hook = join(github, 'hooks', 'pre-receive');
    write(hook, '#!/bin/sh\necho "rejected for the test" >&2\nexit 1\n');
    chmodSync(hook, 0o755);

    const failed = update(local, '--yes', '--push');
    assert.equal(failed.code, 1, failed.out);
    assert.match(failed.out, /pushing it to GitHub failed/);
    assert.match(failed.out, /npm run update -- --push again, which offers to push/);
    sh(local, ['merge-base', '--is-ancestor', v2, 'HEAD']);
    assert.equal(sh(github, ['rev-parse', 'main']), before);
    rmSync(hook);

    const dry = update(local, '--dry-run', '--push');
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /GitHub does not have it yet/);
    assert.equal(sh(github, ['rev-parse', 'main']), before);

    const again = update(local, '--yes', '--push');
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /GitHub does not have it yet/);
    assert.match(again.out, /Pushed main/);
    assert.equal(sh(github, ['rev-parse', 'main']), head(local));
  });

  describe('a copy with no history in common, such as a ZIP committed later', () => {
    const FIX_V1 = 'export const x = 1;\n';
    const FIX_V2 = Array.from({ length: 20 }, (_, i) => `export const f${i + 1} = 1;\n`).join('');
    const index = (a: number, note: boolean): string =>
      `export const a = ${a};\nexport const b = 2;\n${note ? 'export const note = "note";\n' : ''}`;
    let graft = '';
    const tags: Record<string, string> = {};

    // An official history where the dangerous guesses are available: a change
    // made only in wrangler.toml, a folder people may delete, and a migration
    // that comes before a fix someone might copy across by hand.
    before(() => {
      graft = join(dir, 'graft-work');
      mkdirSync(join(graft, 'scripts'), { recursive: true });
      sh(graft, ['init', '-q', '-b', 'master']);
      for (const name of ['update.ts', 'update-lib.ts', 'wrangler.ts']) copyFileSync(join(SCRIPTS, name), join(graft, 'scripts', name));
      write(join(graft, 'package.json'), '{ "name": "fixture", "private": true, "type": "module" }\n');
      write(join(graft, 'wrangler.toml'), WRANGLER_V1);
      write(join(graft, 'migrations/001_init.sql'), 'CREATE TABLE IF NOT EXISTS rules (id INTEGER PRIMARY KEY);\n');
      write(join(graft, 'src/index.ts'), index(1, false));
      write(join(graft, 'src/fix.ts'), FIX_V1);
      const commit = (tag: string, message: string): void => {
        sh(graft, ['add', '.']);
        sh(graft, ['commit', '-q', '-m', message]);
        sh(graft, ['tag', tag]);
        tags[tag] = head(graft);
      };
      commit('g1', 'First version.');
      write(join(graft, 'wrangler.toml'), `${WRANGLER_V1}\n[triggers]\ncrons = ["*/5 * * * *"]\n`);
      commit('g2', 'Add the 5-minute poll cron.');
      for (const page of ['a', 'b', 'c']) write(join(graft, `site/${page}.md`), `# Page ${page}\n\n${'Words.\n'.repeat(30)}`);
      commit('g2s', 'Add a docs site.');
      write(join(graft, 'migrations/002_note.sql'), 'ALTER TABLE rules ADD COLUMN note TEXT;\n');
      write(join(graft, 'src/index.ts'), index(1, true));
      commit('g3', 'Add a note column.');
      write(join(graft, 'src/fix.ts'), FIX_V2);
      commit('g4', 'Fix the bug in fix.ts.');
      write(join(graft, 'src/index.ts'), index(2, true));
      commit('g5', 'Later change.');
      sh(dir, ['clone', '-q', '--bare', graft, 'graft.git']);
    });

    const opts = (input = ''): { env: Record<string, string>; input: string } => ({
      env: { UPDATE_UPSTREAM_URL: join(dir, 'graft.git') },
      input,
    });

    // The files of one official version, committed fresh with `git init`.
    const zipCopy = (tag: string, edit?: (path: string) => void): string => {
      const zip = join(dir, `zip-${tag}-${n}`);
      mkdirSync(zip);
      sh(zip, ['init', '-q', '-b', 'master']);
      sh(zip, ['fetch', '-q', graft, `refs/tags/${tag}`]);
      sh(zip, ['read-tree', '--reset', '-u', 'FETCH_HEAD']);
      edit?.(zip);
      sh(zip, ['add', '.']);
      sh(zip, ['commit', '-q', '-m', 'My copy']);
      return zip;
    };

    it('picks the oldest exact match, so a change made only in wrangler.toml still arrives', () => {
      const zip = zipCopy('g1');
      const { code, out } = updateWith(opts(), zip, '--yes');
      assert.equal(code, 0, out);
      assert.match(out, new RegExp(`started from official version ${tags.g1.slice(0, 7)}`));
      assert.match(out, /5 new changes since your copy/);
      assert.match(out, /Add the 5-minute poll cron\./);
      assert.match(readFileSync(join(zip, 'wrangler.toml'), 'utf8'), /\[triggers\]\ncrons = /);
      assert.equal(readFileSync(join(zip, 'src/index.ts'), 'utf8'), index(2, true));
    });

    it('does not go back too far for a copy whose docs folder was deleted', () => {
      // A download taken after the migration, without the docs site.
      const zip = zipCopy('g3', (path) => rmSync(join(path, 'site'), { recursive: true }));
      const mine = head(zip);

      const declined = updateWith(opts(), zip, '--yes');
      assert.match(declined.out, new RegExp(`closest to official version ${tags.g3.slice(0, 7)}`));
      assert.match(declined.out, /Not in your copy:\n    site\/\n/);
      assert.doesNotMatch(declined.out, /This update changes your database/);
      assert.equal(head(zip), mine);

      const accepted = updateWith(opts('y\n'), zip, '--yes');
      assert.equal(accepted.code, 0, accepted.out);
      assert.match(accepted.out, /2 new changes since your copy/);
      assert.equal(readFileSync(join(zip, 'src/index.ts'), 'utf8'), index(2, true));
      assert.equal(readFileSync(join(zip, 'src/fix.ts'), 'utf8'), FIX_V2);
      assert.equal(existsSync(join(zip, 'site')), false);
    });

    it('asks before trusting an inexact match, and never treats a missing migration as applied', () => {
      // Someone copied the fix from g4 by hand into a download of g2.
      const zip = zipCopy('g2', (path) => write(join(path, 'src/fix.ts'), FIX_V2));
      const mine = head(zip);

      const declined = updateWith(opts(), zip, '--yes');
      assert.equal(declined.code, 0, declined.out);
      assert.match(declined.out, new RegExp(`closest to official version ${tags.g2.slice(0, 7)}`));
      assert.match(declined.out, /Files that differ from it:\n    src\/fix\.ts\n/);
      assert.match(declined.out, /count as already in your copy:\n\s+\w+ Add the 5-minute poll cron\.\n\s+\w+ First version\./);
      assert.match(declined.out, /This update changes your database: 1 new migration\n\s+migrations\/002_note\.sql/);
      assert.match(declined.out, /Asking even with --yes/);
      assert.match(declined.out, /Nothing changed/);
      assert.equal(head(zip), mine);

      const accepted = updateWith(opts('y\n'), zip, '--yes');
      assert.equal(accepted.code, 0, accepted.out);
      assert.equal(existsSync(join(zip, 'migrations/002_note.sql')), true);
      assert.equal(readFileSync(join(zip, 'src/fix.ts'), 'utf8'), FIX_V2);
      assert.equal(readFileSync(join(zip, 'src/index.ts'), 'utf8'), index(2, true));
    });
  });

  it('explains the options in a folder that is not a git repository', () => {
    const zip = join(dir, `zip-${n}`);
    mkdirSync(join(zip, 'scripts'), { recursive: true });
    for (const name of ['update.ts', 'update-lib.ts', 'wrangler.ts']) copyFileSync(join(SCRIPTS, name), join(zip, 'scripts', name));

    const { code, out } = update(zip, '--yes');
    assert.equal(code, 1, out);
    assert.match(out, /not a git repository/);
    assert.match(out, /ZIP/);
    assert.match(out, /archive\/refs\/heads\/master\.zip/);
    assert.match(out, /git init/);
  });
});
