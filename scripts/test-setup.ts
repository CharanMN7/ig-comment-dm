import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  WRANGLER_MISSING,
  runWrangler,
  runWranglerWithInput,
  wranglerBin,
  wranglerSpawnArgs,
} from './wrangler.ts';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

// Stands in for Wrangler: answers the commands setup and doctor run from a
// JSON state file, records every argv it was given, and keeps secrets put on
// stdin so a test can see what reached Cloudflare.
const FAKE_WRANGLER = `
const fs = require('node:fs');
const file = process.env.FAKE_WRANGLER_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args);
const [a, b] = args;
let code = 0;
if (a === 'whoami') {
  console.log('You are logged in with an OAuth Token, associated with the email someone@example.com.');
} else if (a === 'deploy') {
  state.deploys += 1;
  if (state.failDeploy === state.deploys) {
    console.error('X [ERROR] A request to the Cloudflare API failed.');
    code = 1;
  } else {
    console.log('Uploaded ig-comment-dm\\nDeployed ig-comment-dm triggers\\n  https://ig-comment-dm.someone.workers.dev');
  }
} else if (a === 'd1' && b === 'migrations') {
  console.log('001_init.sql ✅');
} else if (a === 'secret' && b === 'list') {
  console.log(JSON.stringify(Object.keys(state.secrets).map((name) => ({ name, type: 'secret_text' }))));
} else if (a === 'secret' && b === 'put') {
  state.secrets[args[2]] = fs.readFileSync(0, 'utf8');
  console.log('Success! Uploaded secret ' + args[2]);
} else if (a === 'd1' && b === 'execute') {
  const sql = args.find((x) => x.startsWith('--command=')).slice('--command='.length);
  const now = String(Math.floor(Date.now() / 1000));
  const results = sql.includes('sqlite_master')
    ? ['accounts', 'rules', 'sent', 'sent_extra_replies', 'system', 'webhook_events'].map((name) => ({ name }))
    : sql.includes('FROM system')
      ? [{ key: 'last_cron_ok_at', value: now }, { key: 'last_poll_ok_at', value: now }]
      : [{ n: sql.includes("status = 'bad_sig'") ? 0 : 1 }];
  console.log(JSON.stringify([{ results, success: true }]));
} else {
  console.error('fake wrangler: nothing set up for ' + args.join(' '));
  code = 2;
}
fs.writeFileSync(file, JSON.stringify(state));
process.exit(code);
`;

interface FakeState {
  calls: string[][];
  deploys: number;
  failDeploy: number;
  secrets: Record<string, string>;
}

const ALL_SECRETS = [
  'META_APP_ID',
  'META_APP_SECRET',
  'FACEBOOK_APP_SECRET',
  'WEBHOOK_VERIFY_TOKEN',
  'TOKEN_ENCRYPTION_KEY',
  'SESSION_SIGNING_KEY',
  'ADMIN_URL_SECRET',
  'PUBLIC_BASE_URL',
];

const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

describe('wranglerBin', () => {
  let dir = '';
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ig-wrangler-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const fakePackage = (root: string, bin: unknown, files: string[]): string => {
    const pkg = join(root, 'node_modules', 'wrangler');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'wrangler', bin }));
    for (const f of files) writeFileSync(join(pkg, f), '');
    return pathToFileURL(join(root, 'scripts', 'setup.ts')).href;
  };

  it("finds this repository's own Wrangler through its package.json", () => {
    const bin = wranglerBin();
    assert.ok(bin, 'wrangler is a devDependency, so npm ci installed it');
    assert.ok(bin.endsWith(`${sep}node_modules${sep}wrangler${sep}bin${sep}wrangler.js`), bin);
    assert.ok(existsSync(bin));
  });

  it('reads the bin field in either of the shapes npm allows', () => {
    const asObject = fakePackage(join(dir, 'object'), { wrangler: './bin/wrangler.js' }, ['bin/wrangler.js']);
    assert.equal(wranglerBin(asObject), join(dir, 'object', 'node_modules', 'wrangler', 'bin', 'wrangler.js'));
    const asString = fakePackage(join(dir, 'string'), 'bin/cli.js', ['bin/cli.js']);
    assert.equal(wranglerBin(asString), join(dir, 'string', 'node_modules', 'wrangler', 'bin', 'cli.js'));
  });

  it('is null before npm install, or when the install is broken', () => {
    assert.equal(wranglerBin(pathToFileURL(join(dir, 'empty', 'scripts', 'setup.ts'))), null);
    assert.equal(wranglerBin(fakePackage(join(dir, 'no-entry'), { wrangler: './bin/wrangler.js' }, [])), null);
    assert.equal(wranglerBin(fakePackage(join(dir, 'no-bin'), undefined, [])), null);
  });
});

describe('wranglerSpawnArgs', () => {
  it('runs the entry script with this Node, so neither npx nor a shell is involved', () => {
    const sql = "--command=SELECT name FROM sqlite_master WHERE type='table'";
    assert.deepEqual(wranglerSpawnArgs('/x/wrangler.js', ['d1', 'execute', 'ig-comment-dm', sql]), {
      command: process.execPath,
      args: ['/x/wrangler.js', 'd1', 'execute', 'ig-comment-dm', sql],
    });
  });

  it('says how to fix a missing install instead of running anything', async () => {
    assert.deepEqual(runWrangler(null, ['whoami']), { code: 127, out: WRANGLER_MISSING });
    assert.deepEqual(await runWranglerWithInput(null, ['secret', 'put', 'X'], 'v'), { code: 127, out: WRANGLER_MISSING });
  });
});

describe('npm run setup and npm run doctor, with a fake Wrangler and no npx on PATH', () => {
  let dir = '';
  let stateFile = '';

  const state = (): FakeState => JSON.parse(readFileSync(stateFile, 'utf8')) as FakeState;
  const reset = (secrets: string[]): void => {
    const values = Object.fromEntries(secrets.map((name) => [name, `existing-${name}`]));
    writeFileSync(stateFile, JSON.stringify({ calls: [], deploys: 0, failDeploy: 0, secrets: values }));
  };

  const run = (root: string, script: string, args: string[] = []): { code: number; out: string } => {
    const inherited = Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && !/^path$/i.test(entry[0]),
    );
    const res = spawnSync(process.execPath, ['--experimental-strip-types', join(root, 'scripts', script), ...args], {
      cwd: root,
      // The bug this guards against: on Windows npx can't be spawned without a
      // shell. A PATH with nothing on it fails the same way on any platform.
      env: { ...Object.fromEntries(inherited), PATH: join(dir, 'nothing-here'), FAKE_WRANGLER_STATE: stateFile },
      encoding: 'utf8',
      input: '',
    });
    return { code: res.status ?? 1, out: plain(`${res.stdout}${res.stderr}`) };
  };

  const copy = (root: string, withWrangler: boolean): void => {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    for (const name of ['setup.ts', 'doctor.ts', 'wrangler.ts']) copyFileSync(join(SCRIPTS, name), join(root, 'scripts', name));
    writeFileSync(join(root, 'package.json'), '{ "name": "fixture", "private": true, "type": "module" }\n');
    if (!withWrangler) return;
    const pkg = join(root, 'node_modules', 'wrangler');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'wrangler', bin: { wrangler: './bin/wrangler.js' } }));
    writeFileSync(join(pkg, 'bin', 'wrangler.js'), FAKE_WRANGLER);
  };

  let root = '';
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ig-setup-'));
    stateFile = join(dir, 'wrangler-state.json');
    root = join(dir, 'copy');
    copy(root, true);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('doctor gets past the login check and passes its SQL through untouched', () => {
    reset(ALL_SECRETS);
    const res = run(root, 'doctor.ts');
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /✓ Logged in to Cloudflare/);
    assert.match(res.out, /Everything checks out/);
    assert.ok(
      state().calls.some((argv) => argv.at(-1) === "--command=SELECT name FROM sqlite_master WHERE type='table'"),
      JSON.stringify(state().calls),
    );
  });

  it('setup runs to the end and saves secrets through stdin', () => {
    reset(ALL_SECRETS);
    const res = run(root, 'setup.ts');
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /Logged in as someone@example\.com/);
    assert.match(res.out, /Done\. Your copy is live\./);
    assert.equal(state().secrets.PUBLIC_BASE_URL, 'https://ig-comment-dm.someone.workers.dev');
    assert.ok(!state().calls.some((argv) => argv.includes('https://ig-comment-dm.someone.workers.dev')));
  });

  it('both say Wrangler is missing, not that the login is', () => {
    const bare = join(dir, 'before-npm-install');
    copy(bare, false);
    const doctor = run(bare, 'doctor.ts');
    assert.equal(doctor.code, 1);
    assert.match(doctor.out, /Wrangler is not installed in this folder/);
    assert.doesNotMatch(doctor.out, /Not logged in/);
    const setup = run(bare, 'setup.ts');
    assert.equal(setup.code, 1);
    assert.match(setup.out, /Wrangler is not installed in this folder yet\.\s+Run {2}npm install {2}here/);
  });
});
