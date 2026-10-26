import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  OFFICIAL_REPO,
  blockingFiles,
  changedPaths,
  conflictMessage,
  decideMode,
  describeHealth,
  dirtyMessage,
  looksLikeCloudflareImport,
  newMigrations,
  numstatTotal,
  onlyDatabaseIdChange,
  parseArgs,
  parseLog,
  pickStartingPoint,
  repoKey,
  restoreDatabaseId,
  sameRepo,
  workerName,
  workerUrlFrom,
} from './update-lib.ts';
import type { ModeFacts } from './update-lib.ts';

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

  it('totals numstat lines, counting a binary file as one', () => {
    assert.equal(numstatTotal('3\t1\tsrc/a.ts\n-\t-\tlogo.png\n0\t10\tREADME.md\n'), 15);
    assert.equal(numstatTotal(''), 0);
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
  it('picks the closest official commit', () => {
    const picked = pickStartingPoint(
      [
        { sha: 'c3', time: 300, distance: 40 },
        { sha: 'c2', time: 200, distance: 0 },
        { sha: 'c1', time: 100, distance: 12 },
      ],
      250,
    );
    assert.equal(picked?.sha, 'c2');
  });

  it('breaks a tie with the newest commit that existed when the copy was made', () => {
    const tied = [
      { sha: 'c3', time: 300, distance: 0 },
      { sha: 'c2', time: 200, distance: 0 },
      { sha: 'c1', time: 100, distance: 0 },
    ];
    assert.equal(pickStartingPoint(tied, 250)?.sha, 'c2');
    assert.equal(pickStartingPoint(tied, 50)?.sha, 'c1');
    assert.equal(pickStartingPoint([], 50), null);
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
    assert.match(decision.hint, /npm run update -- --deploy/);
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
    });
    assert.match(stop, /changes lines you have also changed/);
    assert.match(hint, /  src\/index.ts\n  README.md/);
    assert.match(hint, /Your edits to them are the cause/);
    assert.match(hint, /git checkout upstream\/master -- src\/index.ts README.md/);
    assert.match(hint, /git merge upstream\/master/);
    assert.match(hint, /npm run deploy$/);
  });

  it('removes files the new version deleted instead of checking them out', () => {
    const { hint } = conflictMessage({ files: ['a.ts', 'old.ts'], goneUpstream: ['old.ts'], mode: 'deploy', branch: 'master' });
    assert.match(hint, /git checkout upstream\/master -- a.ts\n/);
    assert.match(hint, /git rm old.ts/);
  });

  it('never offers to replace wrangler.toml wholesale, and finishes a push copy with a push', () => {
    const { hint } = conflictMessage({ files: ['wrangler.toml'], goneUpstream: [], mode: 'push', branch: 'main' });
    assert.match(hint, /keep your own name and database_id lines/);
    assert.doesNotMatch(hint, /git checkout upstream/);
    assert.match(hint, /git push origin main$/);
    const pushCopy = conflictMessage({ files: ['src/a.ts'], goneUpstream: [], mode: 'push', branch: 'main' });
    assert.match(pushCopy.hint, /clashed"\n  npm run update -- --push\n/);
  });
});

describe('messages and readings', () => {
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

  const update = (cwd: string, ...args: string[]): { code: number; out: string } => {
    const res = spawnSync(process.execPath, ['--experimental-strip-types', join(cwd, 'scripts/update.ts'), ...args], {
      cwd,
      env,
      encoding: 'utf8',
      input: '',
    });
    return { code: res.status ?? 1, out: `${res.stdout}${res.stderr}` };
  };

  const write = (path: string, text: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };

  const head = (cwd: string): string => sh(cwd, ['rev-parse', 'HEAD']);

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
    for (const name of ['update.ts', 'update-lib.ts']) {
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
    // What the button leaves in someone's GitHub: the first version's files in
    // a single commit by Cloudflare's bot, with history of its own and the new
    // database id written into wrangler.toml.
    const made = join(dir, `button-${n}`);
    mkdirSync(made);
    sh(made, ['init', '-q', '-b', 'main']);
    sh(made, ['fetch', '-q', join(dir, 'v1.git'), 'master']);
    sh(made, ['read-tree', '--reset', '-u', 'FETCH_HEAD']);
    write(
      join(made, 'wrangler.toml'),
      WRANGLER_V1.replace('database_name = "ig-comment-dm"\n', 'database_name = "ig-comment-dm"\ndatabase_id = "c0ffee00"\n'),
    );
    sh(made, ['add', '.']);
    sh(made, ['-c', 'user.name=x', 'commit', '-q', '--author', 'cloudflare[bot] <bot@cloudflare.com>', '-m', 'source repo import']);
    const github = join(dir, `button-${n}.git`);
    sh(dir, ['clone', '-q', '--bare', made, github]);
    const local = join(dir, `button-clone-${n}`);
    sh(dir, ['clone', '-q', github, local]);
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

  it('explains the options in a folder that is not a git repository', () => {
    const zip = join(dir, `zip-${n}`);
    mkdirSync(join(zip, 'scripts'), { recursive: true });
    for (const name of ['update.ts', 'update-lib.ts']) copyFileSync(join(SCRIPTS, name), join(zip, 'scripts', name));

    const { code, out } = update(zip, '--yes');
    assert.equal(code, 1, out);
    assert.match(out, /not a git repository/);
    assert.match(out, /ZIP/);
    assert.match(out, /archive\/refs\/heads\/master\.zip/);
    assert.match(out, /git init/);
  });
});
