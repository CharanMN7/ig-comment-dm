import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CRON_STALE_SECONDS, POLL_STALE_SECONDS } from '../src/crypto.ts';
import { HEALTH_FIRST_SEEN_KEY, flagNeedsReconnect, systemSet } from '../src/db.ts';
import { ACCESS_TOKEN, DAY, FROZEN_NOW_MS, IG_USER, NOW, accountRow, seedAccount, seedRule, systemValue } from './support/seed.ts';
import { adminPath, countingDb, request, runScheduled, signedInAdmin } from './support/worker.ts';

const HOUR = 60 * 60;

type Health = {
  ok: boolean;
  database: string;
  accounts?: { active: number; needs_reconnect: number };
  cron?: string;
  poll?: string;
  last_cron_ok_at?: number | null;
  last_poll_ok_at?: number | null;
};

/** GET /health, checking on every call that the body never contradicts the status. */
async function health(init: Parameters<typeof request>[1] = {}) {
  const res = await request('/health', init);
  const body = JSON.parse(res.text) as Health;
  expect(body.ok, 'ok in the body must agree with the status code').toBe(res.status === 200);
  expect([200, 503]).toContain(res.status);
  return { ...res, body };
}

async function recordRuns(cronAgo: number | null, pollAgo: number | null): Promise<void> {
  if (cronAgo != null) await systemSet(env.DB, 'last_cron_ok_at', String(NOW - cronAgo));
  if (pollAgo != null) await systemSet(env.DB, 'last_poll_ok_at', String(NOW - pollAgo));
}

function at(secondsAfterNow: number): void {
  vi.setSystemTime(FROZEN_NOW_MS + secondsAfterNow * 1000);
}

/**
 * Stands in for a D1 binding that has stopped answering. Real D1 failures
 * surface as a rejected promise from the statement, so that is where this one
 * fails, with a message the response must not echo.
 */
function unreachableDb(): D1Database {
  const fail = () => Promise.reject(new Error('D1_ERROR: Network connection lost to db-internal-7f3a'));
  const statement = { bind: () => statement, first: fail, all: fail, run: fail, raw: fail };
  return { prepare: () => statement, batch: fail, exec: fail } as unknown as D1Database;
}

afterEach(() => vi.restoreAllMocks());

describe('GET /health', () => {
  it('answers 200 with account counts and job times when everything is running', async () => {
    await seedAccount({ igUserId: '17841400000000001', username: 'fine' });
    await seedAccount({ igUserId: '17841400000000002', username: 'flagged' });
    await flagNeedsReconnect(env.DB, '17841400000000002');
    await seedAccount({ igUserId: '17841400000000003', username: 'expired', expiresAt: NOW - DAY });
    await seedAccount({ igUserId: '17841400000000004', username: 'paused', active: false });
    await recordRuns(6 * HOUR, 120);

    const res = await health();
    // An account needing a reconnect is reported, not alerted on: the operator
    // fixes it in the panel, and a monitor cannot.
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.body).toEqual({
      ok: true,
      database: 'ok',
      accounts: { active: 3, needs_reconnect: 2 },
      cron: 'ok',
      poll: 'ok',
      last_cron_ok_at: NOW - 6 * HOUR,
      last_poll_ok_at: NOW - 120,
    });
  });

  it('is never cached or indexed, and carries the same security headers as the other public routes', async () => {
    const res = await health();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; manifest-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('reports the times the scheduled handlers actually record', async () => {
    // With no accounts neither job calls Meta, and both still record a run.
    await runScheduled('0 3 * * *');
    await runScheduled('*/5 * * * *');
    const res = await health();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cron: 'ok', poll: 'ok', last_cron_ok_at: NOW, last_poll_ok_at: NOW });
  });

  it.each([
    ['the daily job', CRON_STALE_SECONDS + 60, 120, { cron: 'stale', poll: 'ok' }],
    ['the 5-minute poll', 6 * HOUR, POLL_STALE_SECONDS + 60, { cron: 'ok', poll: 'stale' }],
  ])('answers 503 when %s has stopped running', async (_, cronAgo, pollAgo, states) => {
    await recordRuns(cronAgo, pollAgo);
    const res = await health();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ database: 'ok', ...states });
  });

  it('answers 200 right up to the staleness limits', async () => {
    await recordRuns(CRON_STALE_SECONDS, POLL_STALE_SECONDS);
    expect((await health()).status).toBe(200);
  });
});

describe('GET /health on a fresh deploy', () => {
  it('answers 200 as "starting" before either job has run, and starts the clock once', async () => {
    const first = await health();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ cron: 'starting', poll: 'starting', last_cron_ok_at: null, last_poll_ok_at: null });
    expect(await systemValue(HEALTH_FIRST_SEEN_KEY)).toBe(String(NOW));

    at(10 * 60);
    await health();
    expect(await systemValue(HEALTH_FIRST_SEEN_KEY)).toBe(String(NOW));
  });

  it('stays "starting" only until the first nightly run is overdue', async () => {
    await health();

    at(25 * HOUR);
    await systemSet(env.DB, 'last_poll_ok_at', String(NOW + 25 * HOUR - 60));
    const waiting = await health();
    expect(waiting.status).toBe(200);
    expect(waiting.body).toMatchObject({ cron: 'starting', poll: 'ok' });

    at(27 * HOUR);
    await systemSet(env.DB, 'last_poll_ok_at', String(NOW + 27 * HOUR - 60));
    const overdue = await health();
    expect(overdue.status).toBe(503);
    expect(overdue.body).toMatchObject({ cron: 'stale', poll: 'ok', last_cron_ok_at: null });
  });

  it('gives the 5-minute poll an hour to show up, not a day', async () => {
    await health();
    at(POLL_STALE_SECONDS + 60);
    const res = await health();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ cron: 'starting', poll: 'stale' });
  });
});

describe('GET /health when the database is in trouble', () => {
  it('answers 503 when the database does not answer, without echoing the error', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await health({ env: { DB: unreachableDb() } });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, database: 'error' });
    expect(res.text).not.toContain('D1_ERROR');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(logged).toHaveBeenCalled();
  });

  it('answers 503 when the tables are missing, which SELECT 1 alone would not notice', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await env.DB.exec('DROP TABLE system');
    const res = await health();
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, database: 'error' });
  });

  it('uses two statements on its first check and one after that', async () => {
    await recordRuns(6 * HOUR, 120);
    const { db, statements } = countingDb();
    await health({ env: { DB: db } });
    expect(statements).toHaveLength(2);
    await health({ env: { DB: db } });
    await health({ env: { DB: db } });
    expect(statements).toHaveLength(4);
  });
});

describe('GET /health exposure', () => {
  it('answers HEAD with the same status and no body', async () => {
    await recordRuns(6 * HOUR, 120);
    const ok = await request('/health', { method: 'HEAD' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('');
    expect(ok.headers.get('Cache-Control')).toBe('no-store');

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const down = await request('/health', { method: 'HEAD', env: { DB: unreachableDb() } });
    expect(down.status).toBe(503);
    expect(down.text).toBe('');
  });

  it('reveals no account, token, admin path or secret, even with plenty in the database to reveal', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await seedAccount({ username: 'creator_handle', expiresAt: NOW - DAY });
    await flagNeedsReconnect(env.DB, IG_USER);
    await seedRule({ keywords: ['guide'] });
    await signedInAdmin();
    await recordRuns(CRON_STALE_SECONDS + 60, 120);
    const account = await accountRow();

    const leaks = [
      env.ADMIN_URL_SECRET,
      '/a/',
      IG_USER,
      'creator_handle',
      ACCESS_TOKEN,
      account!.access_token_enc,
      account!.token_iv,
      String(account!.token_expires_at),
      env.META_APP_ID,
      env.META_APP_SECRET,
      env.FACEBOOK_APP_SECRET!,
      env.WEBHOOK_VERIFY_TOKEN,
      env.TOKEN_ENCRYPTION_KEY,
      env.SESSION_SIGNING_KEY,
      'guide',
      'token',
    ];
    for (const res of [await health(), await health({ env: { DB: unreachableDb() } })]) {
      for (const leak of leaks) expect(res.text).not.toContain(leak);
      expect(res.setCookies).toEqual([]);
      // An allowlist, so a field added later has to be added here on purpose.
      for (const key of Object.keys(res.body)) {
        expect(['ok', 'database', 'accounts', 'cron', 'poll', 'last_cron_ok_at', 'last_poll_ok_at']).toContain(key);
      }
      if (res.body.accounts) expect(Object.keys(res.body.accounts).sort()).toEqual(['active', 'needs_reconnect']);
    }
  });

  it('is not behind the admin login, its lockout, or any rate limit', async () => {
    // An admin login locked out for an hour, as after a password-guessing run.
    await systemSet(env.DB, 'login_fail_count', '12');
    await systemSet(env.DB, 'login_locked_until', String(NOW + HOUR));
    await recordRuns(6 * HOUR, 120);
    expect((await request(adminPath('/'))).status).toBe(302);

    for (let i = 0; i < 60; i++) {
      const res = await health();
      expect(res.status).toBe(200);
      expect(res.setCookies).toEqual([]);
    }
  });
});
