/**
 * One command that takes a fresh clone to a working deployment.
 *
 *   npm run setup
 *
 * The README used to ask an operator to run fourteen commands in order, paste
 * eight secrets one prompt at a time, and hand-edit a database id into
 * wrangler.toml. Every one of those steps is a place to stop. This does the
 * whole sequence, in the order that works, and ends by printing the exact
 * strings that have to be pasted back into Meta's dashboard — which is the only
 * part a script genuinely cannot do.
 *
 * It is safe to re-run. Deploys are idempotent, migrations the database has
 * already recorded are skipped, and existing secrets are left alone unless
 * --rotate is passed, or an earlier run stopped before it finished (see
 * UNFINISHED below).
 */
import { webcrypto } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { runWrangler, runWranglerWithInput, wranglerBin } from './wrangler.ts';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

const rotate = process.argv.includes('--rotate');
const WRANGLER = wranglerBin();

// The two generated values the operator has to copy somewhere, and that
// Cloudflare will never show again. A run writes their names here before it
// saves them and deletes the file once it has printed its final summary, so a
// re-run that finds the file knows an earlier run saved them and then stopped,
// perhaps before the operator ever saw them, and makes a new pair. The file is
// local and .wrangler/ is git-ignored, so a copy set up somewhere else, or
// before this file existed, keeps its values as before.
const SHOWN_ONCE = ['ADMIN_URL_SECRET', 'WEBHOOK_VERIFY_TOKEN'];
const UNFINISHED = resolve(fileURLToPath(new URL('..', import.meta.url)), '.wrangler', 'setup-unfinished');

function say(msg = ''): void {
  console.log(msg);
}

function step(n: number, total: number, title: string): void {
  say(`\n${BOLD}${CYAN}[${n}/${total}]${RESET} ${BOLD}${title}${RESET}`);
}

function ok(msg: string): void {
  say(`  ${GREEN}✓${RESET} ${msg}`);
}

function warn(msg: string): void {
  say(`  ${YELLOW}!${RESET} ${msg}`);
}

function die(msg: string, hint?: string): never {
  say(`\n${RED}${BOLD}Stopped.${RESET} ${msg}`);
  if (hint) say(`${DIM}${hint}${RESET}`);
  process.exit(1);
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function random(n: number): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(n));
}

/** Runs wrangler and returns its combined output. Never echoes stdin. */
function wrangler(args: string[], opts: { quiet?: boolean } = {}): { code: number; out: string } {
  const res = runWrangler(WRANGLER, args, { stdin: opts.quiet ? 'ignore' : 'inherit' });
  if (!opts.quiet) process.stdout.write(dim(indent(res.out)));
  return res;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() ? `  ${DIM}${line}${RESET}` : line))
    .join('\n');
}

function dim(text: string): string {
  return text;
}

/**
 * `wrangler secret put` reads the value from stdin when stdin is not a TTY,
 * which keeps the secret out of the process list — an argv-passed secret is
 * readable by any other process on the machine via `ps`.
 */
async function putSecret(name: string, value: string): Promise<boolean> {
  const res = await runWranglerWithInput(WRANGLER, ['secret', 'put', name], value);
  if (res.code !== 0) say(indent(res.out));
  return res.code === 0;
}

function existingSecretNames(): Set<string> {
  const res = wrangler(['secret', 'list'], { quiet: true });
  if (res.code !== 0) return new Set();
  try {
    const parsed: unknown = JSON.parse(res.out.slice(res.out.indexOf('[')));
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .map((row) => (row as { name?: unknown }).name)
        .filter((n): n is string => typeof n === 'string'),
    );
  } catch {
    return new Set();
  }
}

function unfinishedNames(): Set<string> {
  try {
    const lines = readFileSync(UNFINISHED, 'utf8').split('\n').map((line) => line.trim());
    return new Set(lines.filter((line) => SHOWN_ONCE.includes(line)));
  } catch {
    return new Set();
  }
}

function markUnfinished(names: string[]): void {
  mkdirSync(dirname(UNFINISHED), { recursive: true });
  writeFileSync(
    UNFINISHED,
    '# npm run setup writes this before saving the values below, and deletes it when it finishes.\n' +
      '# If it is here, a run stopped early, and the next one replaces these values and shows them.\n' +
      `${names.join('\n')}\n`,
  );
}

function workerUrlFrom(deployOutput: string): string | null {
  // Wrangler prints the live URL as a bare https://…workers.dev line, sometimes
  // with a custom domain instead. Take the last one it printed.
  const matches = deployOutput.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/gi);
  if (matches?.length) return matches[matches.length - 1];
  const custom = deployOutput.match(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?=\s|$)/gi);
  return custom?.length ? custom[custom.length - 1] : null;
}

async function main(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (q: string): Promise<string> => (await rl.question(q)).trim();

  say(`\n${BOLD}Comment to DM — setup${RESET}`);
  say(`${DIM}This deploys your own private copy to your own Cloudflare account.`);
  say(`Nothing is sent anywhere else. Safe to re-run.${RESET}`);

  const TOTAL = 6;

  // ---------------------------------------------------------------- 1. login
  step(1, TOTAL, 'Checking your Cloudflare login');
  if (!WRANGLER) {
    rl.close();
    die('Wrangler is not installed in this folder yet.', 'Run  npm install  here, then npm run setup again.');
  }
  const who = wrangler(['whoami'], { quiet: true });
  if (who.code !== 0 || /not authenticated|you are not logged in/i.test(who.out)) {
    rl.close();
    die(
      'You are not logged in to Cloudflare.',
      'Run  npx wrangler login  in this terminal, then run npm run setup again.',
    );
  }
  const account = who.out.match(/associated with the email ([^\s.]+@[^\s.]+\.\S+)/i);
  ok(account ? `Logged in as ${account[1]}` : 'Logged in.');

  // ------------------------------------------------------- 2. first deploy
  step(2, TOTAL, 'Creating the database and deploying');
  // The database's name is in wrangler.toml, so Wrangler creates it without
  // asking, and the steps below find it by that name. Nothing relies on Wrangler
  // writing the id back into wrangler.toml, which it skips for a commented TOML.
  say(`${DIM}  Wrangler creates the D1 database named in wrangler.toml on this first`);
  say(`  deploy, or reuses it if your account already has one by that name.${RESET}\n`);
  const first = wrangler(['deploy']);
  if (first.code !== 0) {
    rl.close();
    die(
      'The first deploy failed. The output above says why.',
      'The two usual causes: no Workers plan enabled on the account yet (open dash.cloudflare.com\n' +
        'and click Workers once), or a name collision with an existing Worker.',
    );
  }
  const url = workerUrlFrom(first.out);
  if (!url) {
    rl.close();
    die(
      'The deploy succeeded but no Worker URL could be read from the output.',
      'Copy the https://…workers.dev URL printed above, then carry on from "Create the tables" in\n' +
        'https://charanmn7.github.io/ig-comment-dm/docs/setup/#deploying-by-hand',
    );
  }
  ok(`Deployed to ${BOLD}${url}${RESET}`);

  // ----------------------------------------------------------- 3. migrations
  step(3, TOTAL, 'Creating the database tables');
  // Wrangler asks "continue?" before applying, and has no flag to skip it. With
  // stdin closed (quiet) it sees no terminal and answers yes itself, so an
  // unattended run cannot hang here.
  const migrated = wrangler(['d1', 'migrations', 'apply', 'DB', '--remote'], { quiet: true });
  if (migrated.code !== 0) {
    rl.close();
    say(indent(migrated.out));
    die('Could not create the database tables.', 'Fix what the output above says, then run npm run setup again.');
  }
  const applied = [...new Set(migrated.out.match(/\b\d+_[\w-]+\.sql\b/g) ?? [])];
  ok(applied.length ? `Applied ${applied.join(', ')}` : 'Already up to date.');

  // -------------------------------------------------------- 4. Meta secrets
  step(4, TOTAL, 'Your three values from the Meta dashboard');
  const existing = existingSecretNames();
  const metaSecrets: Array<{ name: string; prompt: string; where: string }> = [
    {
      name: 'META_APP_ID',
      prompt: 'Instagram App ID',
      where:
        'Instagram → API setup with Instagram login → Business login settings.\n    NOT the number at the top of the dashboard — that one fails with "Invalid redirect_uri".',
    },
    {
      name: 'META_APP_SECRET',
      prompt: 'Instagram App Secret',
      where: 'Same page, click Show next to Instagram App Secret.',
    },
    {
      name: 'FACEBOOK_APP_SECRET',
      prompt: 'Facebook App Secret',
      where:
        'App settings → Basic → App secret → Show. A DIFFERENT value to the one above.\n    Skipping this is the most common reason a finished setup never sends anything.',
    },
  ];

  for (const secret of metaSecrets) {
    if (existing.has(secret.name) && !rotate) {
      ok(`${secret.name} is already set — leaving it alone. (npm run setup -- --rotate to replace)`);
      continue;
    }
    say(`\n  ${BOLD}${secret.prompt}${RESET}`);
    say(`  ${DIM}${secret.where}${RESET}`);
    let value = '';
    while (value === '') {
      value = await ask(`  ${secret.name}: `);
      if (value === '') warn('That cannot be empty.');
    }
    if (!(await putSecret(secret.name, value))) {
      rl.close();
      die(`Could not save ${secret.name} to Cloudflare.`);
    }
    ok(`${secret.name} saved to Cloudflare`);
  }

  // --------------------------------------------------- 5. generated secrets
  step(5, TOTAL, 'Generating the rest');
  const generated: Record<string, string> = {
    TOKEN_ENCRYPTION_KEY: b64(random(32)),
    SESSION_SIGNING_KEY: b64(random(32)),
    ADMIN_URL_SECRET: hex(random(16)),
    WEBHOOK_VERIFY_TOKEN: hex(random(16)),
  };

  // The admin URL and the verify token both have to be shown to the operator
  // later, so a re-run must reuse whatever is already deployed rather than
  // silently rotating it and printing a URL that no longer works. The exception
  // is a pair an unfinished run saved: nothing depends on them until the
  // operator pastes them in, and they may never have seen them.
  const unfinished = unfinishedNames();
  const reused: string[] = [];
  for (const name of Object.keys(generated)) {
    if (existing.has(name) && !rotate && !unfinished.has(name)) {
      reused.push(name);
      delete generated[name];
    }
  }

  const shown = SHOWN_ONCE.filter((name) => name in generated);
  const replaced = shown.filter((name) => unfinished.has(name));
  if (replaced.length) {
    warn(`Your last setup stopped before the end, so this run replaces its ${replaced.join(' and ')}.`);
    say(`    ${DIM}Anything it printed for ${replaced.length === 1 ? 'that' : 'those'} no longer works.${RESET}`);
  }
  if (shown.length) markUnfinished(shown);

  for (const [name, value] of Object.entries(generated)) {
    if (!(await putSecret(name, value))) {
      rl.close();
      die(`Could not save ${name} to Cloudflare.`);
    }
    ok(`${name} generated and saved`);
  }

  // Printed now rather than only at the end, so a later step failing, or
  // Ctrl-C, can't leave the operator without them.
  if (shown.length) {
    const one = shown.length === 1;
    say(`\n  ${BOLD}${YELLOW}Save ${one ? 'this' : 'these'} now.${RESET} Cloudflare keeps secrets hidden, so ${one ? 'it' : 'they'} can't be read back later.`);
    if (generated.ADMIN_URL_SECRET) say(`    Admin link     ${GREEN}${url}/a/${generated.ADMIN_URL_SECRET}${RESET}`);
    if (generated.WEBHOOK_VERIFY_TOKEN) say(`    Verify token   ${CYAN}${generated.WEBHOOK_VERIFY_TOKEN}${RESET}`);
    say(`  ${DIM}If setup stops before the end, run it again: it replaces ${one ? 'it' : 'both'} and shows the new ${one ? 'one' : 'ones'}.${RESET}\n`);
  }
  if (!(await putSecret('PUBLIC_BASE_URL', url))) {
    rl.close();
    die('Could not save PUBLIC_BASE_URL to Cloudflare.');
  }
  ok(`PUBLIC_BASE_URL set to ${url}`);

  if (reused.length) {
    warn(`Kept the existing ${reused.join(', ')}.`);
  }

  // ------------------------------------------------------- 6. final deploy
  step(6, TOTAL, 'Deploying again so the secrets take effect');
  const second = wrangler(['deploy'], { quiet: true });
  if (second.code !== 0) {
    rl.close();
    say(indent(second.out));
    die('The final deploy failed.');
  }
  ok('Deployed.');

  rl.close();

  // ------------------------------------------------------------- next steps
  const adminSecret = generated.ADMIN_URL_SECRET;
  const verifyToken = generated.WEBHOOK_VERIFY_TOKEN;

  say(`\n${GREEN}${BOLD}Done. Your copy is live.${RESET}\n`);
  say(`${BOLD}Paste these into the Meta dashboard.${RESET} Nothing works until you do.\n`);

  say(`${BOLD}1. OAuth redirect URIs${RESET}`);
  say(`${DIM}   Instagram → API setup with Instagram login → Business login settings.`);
  say(`   Add both lines — Meta sometimes appends the trailing slash itself.${RESET}`);
  say(`   ${CYAN}${url}/connect/callback${RESET}`);
  say(`   ${CYAN}${url}/connect/callback/${RESET}\n`);

  say(`${BOLD}2. Webhook callback URL${RESET}`);
  say(`${DIM}   Instagram → API setup with Instagram login → Configure webhooks.`);
  say(`   Subscribe to "comments" with Include values on.${RESET}`);
  say(`   ${CYAN}${url}/webhook${RESET}`);
  if (verifyToken) {
    say(`   ${DIM}Verify token:${RESET} ${CYAN}${verifyToken}${RESET}`);
  } else {
    say(`   ${DIM}Verify token: unchanged — use the one from your first setup.${RESET}`);
  }
  say('');

  say(`${BOLD}3. Publish the app${RESET}`);
  say(`${DIM}   Meta → Publish. Paste these three, then click Publish.`);
  say(`   Until the app is Live, Meta only delivers the dashboard Test button.${RESET}`);
  say(`   ${CYAN}${url}/privacy${RESET}`);
  say(`   ${CYAN}${url}/terms${RESET}`);
  say(`   ${CYAN}${url}/data-deletion${RESET}\n`);

  say(`${BOLD}Then open your admin page and create a password:${RESET}`);
  if (adminSecret) {
    say(`   ${GREEN}${url}/a/${adminSecret}${RESET}`);
    say(`   ${DIM}Bookmark it. Cloudflare keeps it hidden, so it can't be shown again from here.`);
    say(`   Anyone with it still needs your password, but do not paste it anywhere.${RESET}\n`);
  } else {
    say(`   ${DIM}Unchanged — use the admin link from your first setup.${RESET}\n`);
  }

  say(`${DIM}Stuck? Run  npm run doctor  to check what is missing.${RESET}\n`);
  rmSync(UNFINISHED, { force: true });
}

main().catch((err: unknown) => {
  say(`\n${RED}Setup crashed.${RESET} ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
