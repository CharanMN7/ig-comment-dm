/**
 * Checks a deployed copy and says what is wrong in the operator's words.
 *
 *   npm run doctor
 *
 * Most "I set it up and nothing happens" reports come down to one of six
 * things, and none of them produce an error anywhere the operator would look:
 * the Meta app is still in Development, the webhook subscription toggle is off,
 * FACEBOOK_APP_SECRET was never set so every signature check fails silently,
 * the migrations never ran, the app is DMing itself, or Hidden Words is eating
 * the comment before Meta ever sees it.
 *
 * This checks the four of those that are visible from outside, so the bug
 * report starts from a real answer instead of a guess.
 */
import { spawnSync } from 'node:child_process';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

type Level = 'ok' | 'warn' | 'fail';

const results: Array<{ level: Level; title: string; detail?: string; fix?: string }> = [];

function record(level: Level, title: string, detail?: string, fix?: string): void {
  results.push({ level, title, detail, fix });
}

function wrangler(args: string[]): { code: number; out: string } {
  const res = spawnSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: res.status ?? 1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

const REQUIRED = [
  'META_APP_ID',
  'META_APP_SECRET',
  'WEBHOOK_VERIFY_TOKEN',
  'TOKEN_ENCRYPTION_KEY',
  'SESSION_SIGNING_KEY',
  'ADMIN_URL_SECRET',
  'PUBLIC_BASE_URL',
];

function checkLogin(): boolean {
  const who = wrangler(['whoami']);
  if (who.code !== 0 || /not authenticated|you are not logged in/i.test(who.out)) {
    record('fail', 'Not logged in to Cloudflare', undefined, 'npx wrangler login');
    return false;
  }
  record('ok', 'Logged in to Cloudflare');
  return true;
}

function checkSecrets(): void {
  const res = wrangler(['secret', 'list']);
  if (res.code !== 0) {
    record(
      'fail',
      'Could not read the Worker’s secret list',
      'The Worker may not be deployed yet.',
      'npm run setup',
    );
    return;
  }
  let names: string[] = [];
  try {
    const parsed: unknown = JSON.parse(res.out.slice(res.out.indexOf('[')));
    names = Array.isArray(parsed)
      ? parsed
          .map((r) => (r as { name?: unknown }).name)
          .filter((n): n is string => typeof n === 'string')
      : [];
  } catch {
    record('warn', 'Could not parse the secret list', 'Skipping the secret checks.');
    return;
  }

  const missing = REQUIRED.filter((n) => !names.includes(n));
  if (missing.length) {
    record(
      'fail',
      `${missing.length} required secret${missing.length === 1 ? '' : 's'} not set`,
      missing.join(', '),
      `npx wrangler secret put ${missing[0]}   ${DIM}(and the rest)${RESET}`,
    );
  } else {
    record('ok', `All ${REQUIRED.length} required secrets are set`);
  }

  if (!names.includes('FACEBOOK_APP_SECRET')) {
    record(
      'fail',
      'FACEBOOK_APP_SECRET is not set',
      'Meta signs live comment notifications with the Facebook App Secret, not the Instagram one. ' +
        'Without it every real webhook is rejected as an invalid signature and no DM is ever sent. ' +
        'This is the single most common cause of a setup that looks correct and does nothing.',
      'App settings → Basic → App secret → Show, then npx wrangler secret put FACEBOOK_APP_SECRET',
    );
  } else {
    record('ok', 'FACEBOOK_APP_SECRET is set');
  }
}

function d1Query(sql: string): string | null {
  const res = wrangler(['d1', 'execute', 'ig-comment-dm', '--remote', '--json', `--command=${sql}`]);
  return res.code === 0 ? res.out : null;
}

function checkDatabase(): void {
  const out = d1Query("SELECT name FROM sqlite_master WHERE type='table'");
  if (out == null) {
    record(
      'fail',
      'Could not query the D1 database',
      'It may not exist yet, or the tables were never created.',
      'npm run db:migrate',
    );
    return;
  }
  const expected = ['accounts', 'rules', 'sent', 'system', 'webhook_events'];
  const missing = expected.filter((t) => !out.includes(`"${t}"`));
  if (missing.length) {
    record('fail', `Database tables missing: ${missing.join(', ')}`, undefined, 'npm run db:migrate');
    return;
  }
  record('ok', 'All five database tables exist');

  const accounts = d1Query('SELECT COUNT(*) AS n FROM accounts WHERE active = 1');
  if (accounts && /"n":\s*0\b/.test(accounts)) {
    record(
      'warn',
      'No Instagram account is connected',
      'Nothing can send until you connect one.',
      'Open your admin page → Accounts → Connect a new account',
    );
  } else if (accounts) {
    record('ok', 'At least one Instagram account is connected');
  }

  const rules = d1Query('SELECT COUNT(*) AS n FROM rules WHERE active = 1');
  if (rules && /"n":\s*0\b/.test(rules)) {
    record(
      'warn',
      'No active rules',
      'Comments will arrive and match nothing.',
      'Open your admin page → Rules → New rule',
    );
  } else if (rules) {
    record('ok', 'At least one active rule exists');
  }

  const badSig = d1Query(
    "SELECT COUNT(*) AS n FROM webhook_events WHERE status = 'bad_sig' AND received_at > strftime('%s','now') - 86400",
  );
  if (badSig && !/"n":\s*0\b/.test(badSig)) {
    record(
      'fail',
      'Instagram reached this Worker in the last 24h but the signature did not match',
      'The request was rejected, so no DM was sent for it.',
      'Set FACEBOOK_APP_SECRET from App settings → Basic, then npx wrangler deploy',
    );
  }

  const anyEvent = d1Query('SELECT COUNT(*) AS n FROM webhook_events');
  if (anyEvent && /"n":\s*0\b/.test(anyEvent)) {
    record(
      'warn',
      'Instagram has never reached this Worker',
      'No webhook has ever arrived, valid or not. Almost always this means the Meta app is still in ' +
        'Development mode, or the per-account "Webhook subscription" toggle is off.',
      'Meta → Publish (make the app Live), and Generate access tokens → Webhook subscription → On',
    );
  }
}

function checkCron(): void {
  const out = d1Query("SELECT key, value FROM system WHERE key IN ('last_cron_ok_at','last_poll_ok_at')");
  if (out == null) return;
  const now = Math.floor(Date.now() / 1000);
  for (const [key, label, staleAfter] of [
    ['last_cron_ok_at', 'The nightly token refresh', 72 * 3600],
    ['last_poll_ok_at', 'The 5-minute comment poll', 3600],
  ] as const) {
    const m = out.match(new RegExp(`"${key}"[^}]*?"value":\\s*"(\\d+)"`));
    if (!m) {
      record('warn', `${label} has never run`, 'Expected if you only just deployed.');
      continue;
    }
    const age = now - Number.parseInt(m[1], 10);
    if (age > staleAfter) {
      record(
        'fail',
        `${label} last ran ${Math.floor(age / 3600)} hours ago`,
        'Cron triggers may not be registered on this Worker.',
        'npx wrangler deploy',
      );
    } else {
      record('ok', `${label} ran ${Math.floor(age / 60)} minutes ago`);
    }
  }
}

function report(): void {
  console.log(`\n${BOLD}Comment to DM — doctor${RESET}\n`);

  for (const r of results) {
    const mark =
      r.level === 'ok' ? `${GREEN}✓${RESET}` : r.level === 'warn' ? `${YELLOW}!${RESET}` : `${RED}✗${RESET}`;
    console.log(`  ${mark} ${r.title}`);
    if (r.detail) console.log(`    ${DIM}${r.detail}${RESET}`);
    if (r.fix) console.log(`    ${DIM}Fix:${RESET} ${r.fix}`);
  }

  const fails = results.filter((r) => r.level === 'fail').length;
  const warns = results.filter((r) => r.level === 'warn').length;

  console.log('');
  if (fails > 0) {
    console.log(
      `${RED}${BOLD}${fails} problem${fails === 1 ? '' : 's'} to fix.${RESET}` +
        (warns ? ` ${DIM}${warns} thing${warns === 1 ? '' : 's'} to look at.${RESET}` : ''),
    );
    console.log(
      `${DIM}Two things this cannot see from out here: whether the Meta app is Live, and whether`,
    );
    console.log(`Instagram's Hidden Words filter is eating the comment before Meta sees it.${RESET}\n`);
    process.exit(1);
  }
  if (warns > 0) {
    console.log(`${YELLOW}Deployment looks healthy. ${warns} thing${warns === 1 ? '' : 's'} to look at.${RESET}\n`);
    return;
  }
  console.log(`${GREEN}${BOLD}Everything checks out.${RESET}\n`);
}

if (checkLogin()) {
  checkSecrets();
  checkDatabase();
  checkCron();
}
report();
