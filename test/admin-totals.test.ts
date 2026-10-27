import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { snapshotTotals } from '../src/cron.ts';
import {
  type SendTotals,
  TOTALS_SNAPSHOT_KEY,
  readTotalsSnapshot,
  sendTotals,
  sendTotalsByAccount,
  updateSent,
} from '../src/db.ts';
import { DAY, FROZEN_NOW_MS, IG_USER, NOW, seedAccount, seedSent, sentRow, systemValue } from './support/seed.ts';
import { type DbCall, adminPath, countingDb, request, runScheduled, signedInAdmin } from './support/worker.ts';

// The frozen clock is 2026-10-01 12:00 UTC. These are written out as dates
// rather than derived from NOW the way the Worker derives them, so an
// off-by-one-day in the Worker can't agree with itself here.
const TODAY = Date.UTC(2026, 9, 1) / 1000;
const WEEK = Date.UTC(2026, 8, 25) / 1000; // today and the six days before it
const MONTH = Date.UTC(2026, 8, 2) / 1000; // today and the 29 days before it
const STARTS = [TODAY, WEEK, MONTH, 0];
const SPANS = STARTS.map((from) => ({ from }));
const LABELS = ['Today (UTC)', 'Last 7 days', 'Last 30 days', 'All time'];

const ALICE = '9100000000000001';
const BOB = '9100000000000002';
const CAROL = '9100000000000003';

/** The same numbers, one plain query per window and status, as someone checking D1 by hand would write them. */
async function byHand(since: number, igUserId?: string, before?: number): Promise<SendTotals> {
  const account = igUserId ? ' AND ig_user_id = ?' : '';
  const until = before != null ? ' AND sent_at < ?' : '';
  const one = async (select: string, status: string) => {
    const binds: unknown[] = [status, since, ...(igUserId ? [igUserId] : []), ...(before != null ? [before] : [])];
    const row = await env.DB.prepare(`SELECT ${select} AS n FROM sent WHERE dm_status = ? AND sent_at >= ?${account}${until}`)
      .bind(...binds)
      .first<{ n: number }>();
    return row!.n;
  };
  return {
    sent: await one('COUNT(*)', 'ok'),
    skipped: await one('COUNT(*)', 'skipped'),
    failed: await one('COUNT(*)', 'failed'),
    reached: await one('COUNT(DISTINCT commenter_id)', 'ok'),
  };
}

/** Reads the four tiles that follow `from` in the page's text, in window order. */
function tilesAfter(page: string, from: string): SendTotals[] {
  const text = page.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const start = text.indexOf(from);
  if (start < 0) throw new Error(`"${from}" is not on the page`);
  const tile = /(Today \(UTC\)|Last 7 days|Last 30 days|All time) ([\d,]+) (person|people) reached ([\d,]+) (DMs?) sent ([\d,]+) skipped ([\d,]+) failed/g;
  tile.lastIndex = start;
  const out: SendTotals[] = [];
  for (const label of LABELS) {
    const m = tile.exec(text);
    if (!m || m[1] !== label) throw new Error(`expected the ${label} tile after "${from}"`);
    const n = (s: string) => Number(s.replace(/,/g, ''));
    const totals = { reached: n(m[2]!), sent: n(m[4]!), skipped: n(m[6]!), failed: n(m[7]!) };
    const words = `${m[2]} ${m[3]} reached, ${m[4]} ${m[5]} sent`;
    const right = `${m[2]} ${totals.reached === 1 ? 'person' : 'people'} reached, ${m[4]} ${totals.sent === 1 ? 'DM' : 'DMs'} sent`;
    if (words !== right) throw new Error(`the ${label} tile says "${words}", not "${right}"`);
    out.push(totals);
  }
  return out;
}

async function home(db?: D1Database): Promise<string> {
  return homeAs(await signedInAdmin(), db);
}

async function homeAs(admin: Awaited<ReturnType<typeof signedInAdmin>>, db?: D1Database): Promise<string> {
  const res = await request(adminPath('/'), { headers: { Cookie: admin.cookieHeader }, env: db ? { DB: db } : undefined });
  expect(res.status).toBe(200);
  return res.text;
}

const DAILY = '0 3 * * *';

// The daily job snapshots rows claimed more than 15 minutes before it runs.
// Written out for the same reason as the window starts above.
const CUTOFF = Date.UTC(2026, 9, 1, 11, 45) / 1000;

const zero = { sent: 0, skipped: 0, failed: 0, reached: 0 };

async function fullRecount(starts: number[] = STARTS, igUserId?: string): Promise<SendTotals[]> {
  return Promise.all(starts.map((since) => byHand(since, igUserId)));
}

/**
 * A year-old history of `count` rows, through the same write helper as the
 * rest. Alice is in it, so she was reached long before today.
 */
async function seedHistory(count: number, igUserIds: string[] = [IG_USER]): Promise<void> {
  const statuses = ['ok', 'ok', 'ok', 'skipped', 'failed'] as const;
  const rows = Array.from({ length: count }, (_, i) => ({
    commentId: `history-${i}`,
    status: statuses[i % statuses.length]!,
    at: TODAY - 400 * DAY + i,
    commenterId: i === 0 ? ALICE : `92${String(i % 700).padStart(14, '0')}`,
    igUserId: igUserIds[i % igUserIds.length]!,
  }));
  for (let i = 0; i < rows.length; i += 100) await Promise.all(rows.slice(i, i + 100).map((row) => seedSent(row)));
}

function rowsRead(calls: DbCall[]): number {
  return calls.reduce((sum, call) => sum + call.rowsRead, 0);
}

// Rows on both sides of every window edge, in every status. Alice is DMed in
// several windows, Bob is skipped today but was DMed yesterday, Carol only
// ever fails, and one old DM has no commenter id at all.
async function seedOneAccount(): Promise<void> {
  const rows: Array<[string, 'ok' | 'skipped' | 'failed' | 'pending', number, string | null]> = [
    ['today-edge', 'ok', TODAY, ALICE],
    ['today-again', 'ok', NOW - 60, ALICE],
    ['today-skip', 'skipped', NOW - 120, BOB],
    ['today-fail', 'failed', NOW - 180, CAROL],
    ['today-pending', 'pending', NOW, '9100000000000004'],
    ['yesterday-late', 'ok', TODAY - 1, '9100000000000005'],
    ['yesterday-bob', 'ok', TODAY - 1, BOB],
    ['week-edge', 'ok', WEEK, '9100000000000006'],
    ['week-before', 'ok', WEEK - 1, '9100000000000007'],
    ['week-before-fail', 'failed', WEEK - 1, CAROL],
    ['month-edge', 'skipped', MONTH, '9100000000000008'],
    ['month-before', 'ok', MONTH - 1, ALICE],
    ['month-before-2', 'ok', MONTH - 1, '9100000000000009'],
    ['long-ago', 'ok', TODAY - 400 * 24 * 60 * 60, null],
  ];
  for (const [commentId, status, at, commenterId] of rows) await seedSent({ commentId, status, at, commenterId });
}

describe('totals on the admin home page', () => {
  it('counts sent, skipped, failed and people reached for today, 7 days, 30 days and all time', async () => {
    expect(TODAY, 'the frozen clock moved; the dates above need updating').toBe(NOW - 12 * 60 * 60);
    await seedAccount();
    await seedOneAccount();

    const expected: SendTotals[] = [
      { sent: 2, skipped: 1, failed: 1, reached: 1 },
      { sent: 5, skipped: 1, failed: 1, reached: 4 },
      { sent: 6, skipped: 2, failed: 2, reached: 5 },
      { sent: 9, skipped: 2, failed: 2, reached: 6 },
    ];
    const hand = await Promise.all(STARTS.map((since) => byHand(since)));
    expect(hand).toEqual(expected);
    expect(await sendTotals(env.DB, SPANS)).toEqual(expected);
    expect(tilesAfter(await home(), 'Home')).toEqual(expected);
  });

  it('shows zeros, not blanks, before anything has been sent', async () => {
    const zero = { sent: 0, skipped: 0, failed: 0, reached: 0 };
    expect(tilesAfter(await home(), 'Home')).toEqual([zero, zero, zero, zero]);
  });

  it('labels the windows as UTC', async () => {
    const page = await home();
    expect(page).toContain('Today (UTC)');
    expect(page).toContain('Days start at 00:00 UTC');
  });

  it('runs one totals statement for one account, and no per-account breakdown', async () => {
    await seedAccount();
    await seedOneAccount();
    const { db, statements } = countingDb();
    const page = await home(db);
    expect(statements.filter((sql) => sql.includes('COUNT(DISTINCT'))).toHaveLength(1);
    expect(page).not.toContain('By account');
  });
});

describe('totals with more than one account', () => {
  const OTHER = '17841400000000002';

  async function seedTwoAccounts(): Promise<void> {
    await seedAccount({ igUserId: IG_USER, username: 'alpha' });
    await seedAccount({ igUserId: OTHER, username: 'beta' });
    await seedAccount({ igUserId: '17841400000000003', username: 'gamma', active: false });
    await seedOneAccount();
    // Alice comments on both accounts and gets a DM from each: one person reached.
    await seedSent({ commentId: 'beta-alice', status: 'ok', at: NOW - 30, igUserId: OTHER, commenterId: ALICE });
    await seedSent({ commentId: 'beta-bob', status: 'failed', at: WEEK + 5, igUserId: OTHER, commenterId: BOB });
    await seedSent({ commentId: 'beta-new', status: 'ok', at: MONTH, igUserId: OTHER, commenterId: '9100000000000010' });
  }

  it('breaks the totals down per account, and still counts a person reached by both accounts once', async () => {
    await seedTwoAccounts();
    const page = await home();

    const overall = await Promise.all(STARTS.map((since) => byHand(since)));
    expect(overall).toEqual([
      { sent: 3, skipped: 1, failed: 1, reached: 1 },
      { sent: 6, skipped: 1, failed: 2, reached: 4 },
      { sent: 8, skipped: 2, failed: 3, reached: 6 },
      { sent: 11, skipped: 2, failed: 3, reached: 7 },
    ]);
    expect(tilesAfter(page, 'Home')).toEqual(overall);

    const alpha = await Promise.all(STARTS.map((since) => byHand(since, IG_USER)));
    const beta = await Promise.all(STARTS.map((since) => byHand(since, OTHER)));
    expect(beta).toEqual([
      { sent: 1, skipped: 0, failed: 0, reached: 1 },
      { sent: 1, skipped: 0, failed: 1, reached: 1 },
      { sent: 2, skipped: 0, failed: 1, reached: 2 },
      { sent: 2, skipped: 0, failed: 1, reached: 2 },
    ]);
    expect(tilesAfter(page, 'By account @alpha')).toEqual(alpha);
    expect(tilesAfter(page, '@beta Today')).toEqual(beta);

    const zero = { sent: 0, skipped: 0, failed: 0, reached: 0 };
    expect(tilesAfter(page, '@gamma Today')).toEqual([zero, zero, zero, zero]);

    const perAccount = await sendTotalsByAccount(env.DB, SPANS);
    expect(perAccount.get(IG_USER)).toEqual(alpha);
    expect(perAccount.get(OTHER)).toEqual(beta);
    expect(perAccount.has('17841400000000003')).toBe(false);
  });

  it('adds exactly one statement for the breakdown, whatever the number of accounts', async () => {
    await seedTwoAccounts();
    const { db, statements } = countingDb();
    await home(db);
    expect(statements.filter((sql) => sql.includes('COUNT(DISTINCT'))).toHaveLength(2);
  });

  it('adds each account’s live counts to its own snapshot, so someone new to one account is new there but not overall', async () => {
    await seedTwoAccounts();
    const FRANK = '9100000000000011';
    await seedSent({ commentId: 'beta-frank-before', status: 'ok', at: CUTOFF - 100, igUserId: OTHER, commenterId: FRANK });
    await runScheduled(DAILY);
    expect(await readTotalsSnapshot(env.DB)).toEqual({
      cutoff: CUTOFF,
      all: await byHand(0, undefined, CUTOFF),
      accounts: { [IG_USER]: await byHand(0, IG_USER, CUTOFF), [OTHER]: await byHand(0, OTHER, CUTOFF) },
    });

    // Since the snapshot: alpha reaches Frank for the first time, beta again.
    // Alice heard from alpha before the cutoff and from beta only after it.
    await seedSent({ commentId: 'alpha-frank', status: 'ok', at: NOW, commenterId: FRANK });
    await seedSent({ commentId: 'beta-frank-again', status: 'ok', at: NOW, igUserId: OTHER, commenterId: FRANK });
    await seedSent({ commentId: 'beta-frank-skip', status: 'skipped', at: NOW, igUserId: OTHER, commenterId: FRANK });

    const page = await home();
    expect(tilesAfter(page, 'Home')).toEqual(await fullRecount());
    expect(tilesAfter(page, 'By account @alpha')).toEqual(await fullRecount(STARTS, IG_USER));
    expect(tilesAfter(page, '@beta Today')).toEqual(await fullRecount(STARTS, OTHER));
    expect(tilesAfter(page, '@gamma Today')).toEqual([zero, zero, zero, zero]);
  });
});

describe('all-time totals from the nightly snapshot', () => {
  it('adds the rows since the snapshot to it, and matches a full recount on both sides of the cutoff', async () => {
    await seedAccount();
    await seedOneAccount();
    const DAVE = '9100000000000012';
    const ERIN = '9100000000000013';
    await seedSent({ commentId: 'erin-before', status: 'ok', at: CUTOFF - 1, commenterId: ERIN });
    await seedSent({ commentId: 'stuck-before', status: 'pending', at: CUTOFF - 1, commenterId: DAVE });
    await seedSent({ commentId: 'dave-at-cutoff', status: 'ok', at: CUTOFF, commenterId: DAVE });

    await runScheduled(DAILY);

    // The sweep ran first, so the stuck send is in the snapshot as failed,
    // and the one still in flight is left for the live count.
    expect(await sentRow('stuck-before')).toMatchObject({ dm_status: 'failed', sent_at: CUTOFF - 1 });
    expect(await sentRow('today-pending')).toMatchObject({ dm_status: 'pending' });
    expect(await readTotalsSnapshot(env.DB)).toEqual({
      cutoff: CUTOFF,
      all: await byHand(0, undefined, CUTOFF),
      accounts: { [IG_USER]: await byHand(0, IG_USER, CUTOFF) },
    });

    // Since the snapshot: the in-flight send lands, and Erin, reached before
    // the cutoff, is reached again.
    await updateSent(env.DB, 'today-pending', { rule_id: null, dm_status: 'ok', reply_status: null, error: null, sent_at: NOW });
    await seedSent({ commentId: 'erin-after', status: 'ok', at: NOW, commenterId: ERIN });

    const expected = await fullRecount();
    expect(expected[3]).toEqual({ sent: 13, skipped: 2, failed: 3, reached: 9 });
    expect(tilesAfter(await home(), 'Home')).toEqual(expected);
  });

  it('stays exact as the snapshot moves forward a night at a time', async () => {
    await seedAccount();
    await seedOneAccount();
    await runScheduled(DAILY);

    const GRACE = '9100000000000014';
    await seedSent({ commentId: 'stuck-tonight', status: 'pending', at: NOW + 60, commenterId: GRACE });
    await seedSent({ commentId: 'alice-tonight', status: 'ok', at: NOW + 3600, commenterId: ALICE });
    await seedSent({ commentId: 'grace-tonight', status: 'ok', at: NOW + 7200, commenterId: GRACE });
    vi.setSystemTime(FROZEN_NOW_MS + DAY * 1000);
    await runScheduled(DAILY);

    expect(await sentRow('stuck-tonight')).toMatchObject({ dm_status: 'failed' });
    expect(await readTotalsSnapshot(env.DB)).toMatchObject({ cutoff: CUTOFF + DAY, all: await byHand(0, undefined, CUTOFF + DAY) });

    await seedSent({ commentId: 'grace-again', status: 'ok', at: NOW + DAY, commenterId: GRACE });
    await seedSent({ commentId: 'skip-tomorrow', status: 'skipped', at: NOW + DAY, commenterId: '9100000000000015' });
    const nextDay = [Date.UTC(2026, 9, 2), Date.UTC(2026, 8, 26), Date.UTC(2026, 8, 3), 0].map((ms) => ms / 1000);
    expect(tilesAfter(await home(), 'Home')).toEqual(await fullRecount(nextDay));
  });

  it('is refreshed by "Check connections now" too', async () => {
    await seedAccount();
    await seedOneAccount();
    const admin = await signedInAdmin();
    await admin.get(adminPath('/'));
    expect(await systemValue(TOTALS_SNAPSHOT_KEY)).toBeNull();
    await admin.submit(adminPath('/run-cron'));
    expect(await readTotalsSnapshot(env.DB)).toMatchObject({ cutoff: CUTOFF, all: await byHand(0, undefined, CUTOFF) });
  });

  it('catches up on its own when the daily job has missed its runs', async () => {
    await seedAccount();
    await seedOneAccount();
    await runScheduled(DAILY);
    vi.setSystemTime(FROZEN_NOW_MS + 3 * DAY * 1000);
    await seedSent({ commentId: 'later', status: 'ok', at: NOW + 2 * DAY, commenterId: '9100000000000016' });
    const page = await home();
    expect((await readTotalsSnapshot(env.DB))?.cutoff).toBe(CUTOFF + 3 * DAY);
    expect(tilesAfter(page, 'Home')[3]).toEqual(await byHand(0));
  });

  it('counts again when the stored snapshot is unreadable', async () => {
    await seedAccount();
    await seedOneAccount();
    await env.DB.prepare('INSERT INTO system (key, value) VALUES (?, ?)').bind(TOTALS_SNAPSHOT_KEY, '{"cutoff":"soon"}').run();
    expect(tilesAfter(await home(), 'Home')).toEqual(await fullRecount());
  });

  it('reads the recent rows on each visit, not the whole history', async () => {
    const OTHER = '17841400000000002';
    await seedAccount({ igUserId: IG_USER, username: 'alpha' });
    await seedAccount({ igUserId: OTHER, username: 'beta' });
    await seedOneAccount();
    await seedHistory(1_200, [IG_USER, OTHER]);
    await runScheduled(DAILY);

    const { db, calls } = countingDb();
    const page = await home(db);
    expect(tilesAfter(page, 'Home')).toEqual(await fullRecount());
    expect(tilesAfter(page, 'By account @alpha')).toEqual(await fullRecount(STARTS, IG_USER));
    // Reading the history each time, this visit read about 4,900 rows: the
    // whole table once for each set of totals and twice for the last 20.
    expect(rowsRead(calls)).toBeLessThan(150);
  });
});

describe('Home before the first snapshot', () => {
  it('counts a small history live, and leaves the snapshot and the stuck-send sweep to the daily job', async () => {
    await seedAccount();
    await seedOneAccount();
    await seedSent({ commentId: 'stuck', status: 'pending', at: NOW - 2 * DAY });
    const { db, statements } = countingDb();
    expect(tilesAfter(await home(db), 'Home')).toEqual(await fullRecount());
    expect(await systemValue(TOTALS_SNAPSHOT_KEY)).toBeNull();
    expect(await sentRow('stuck')).toMatchObject({ dm_status: 'pending' });
    expect(statements.filter((sql) => /^\s*UPDATE sent/.test(sql))).toEqual([]);
  });

  it('takes the snapshot on the first visit when the history is large, so the next visit reads only recent rows', async () => {
    await seedAccount();
    await seedOneAccount();
    await seedHistory(1_200);
    const admin = await signedInAdmin();
    const expected = await fullRecount();

    expect(tilesAfter(await homeAs(admin), 'Home')).toEqual(expected);
    expect(await readTotalsSnapshot(env.DB)).toMatchObject({ cutoff: CUTOFF, all: await byHand(0, undefined, CUTOFF) });

    const { db, calls } = countingDb();
    expect(tilesAfter(await homeAs(admin, db), 'Home')).toEqual(expected);
    expect(calls.filter((c) => c.sql.includes('LIMIT ?)'))).toEqual([]);
    expect(rowsRead(calls)).toBeLessThan(150);
  });
});

describe('query plans', () => {
  async function plan(call: DbCall): Promise<string[]> {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${call.sql}`)
      .bind(...call.binds)
      .all<{ detail: string }>();
    return results.map((r) => r.detail);
  }

  async function seedTwoWithSnapshot(): Promise<string> {
    const OTHER = '17841400000000002';
    await seedAccount({ igUserId: IG_USER, username: 'alpha' });
    await seedAccount({ igUserId: OTHER, username: 'beta' });
    await seedOneAccount();
    await seedSent({ commentId: 'beta-1', status: 'ok', at: NOW - 30, igUserId: OTHER, commenterId: ALICE });
    await runScheduled(DAILY);
    return OTHER;
  }

  it('reads Home’s totals and last 20 sends through an index on the time range, never a scan of sent', async () => {
    await seedTwoWithSnapshot();
    const { db, calls } = countingDb();
    await home(db);

    const totals = calls.filter((c) => c.sql.includes('COUNT(DISTINCT'));
    expect(totals).toHaveLength(2);
    for (const call of totals) {
      const steps = await plan(call);
      expect(steps.filter((s) => /^SCAN sent\b/.test(s)), steps.join(' | ')).toEqual([]);
      expect(steps).toContainEqual(
        expect.stringMatching(/^SEARCH sent USING INDEX (idx_sent_time \(sent_at>\?\)|idx_sent_account_time \(ig_user_id=\? AND sent_at>\?\))$/),
      );
      // Was this person reached before the snapshot? One index lookup each.
      expect(steps).toContainEqual(expect.stringMatching(/^SEARCH p USING COVERING INDEX idx_sent_reached /));
    }

    const [recent] = calls.filter((c) => c.sql.includes('LEFT JOIN rules'));
    const steps = await plan(recent!);
    expect(steps).toContain('SCAN s USING INDEX idx_sent_time');
    expect(steps).not.toContain('USE TEMP B-TREE FOR ORDER BY');

    for (const call of calls.filter((c) => /\bsent\b/.test(c.sql) && c !== recent)) {
      expect((await plan(call)).filter((s) => /^SCAN (sent|s)\b/.test(s)), call.sql).toEqual([]);
    }
  });

  it('keeps the daily job’s sweep and snapshot to the rows since the last one', async () => {
    await seedTwoWithSnapshot();
    const { db, calls } = countingDb();
    await snapshotTotals(db, NOW + DAY);

    const onSent = calls.filter((c) => /\bsent\b/.test(c.sql));
    expect(onSent).toHaveLength(3);
    for (const call of onSent) {
      const steps = await plan(call);
      expect(steps.filter((s) => /^SCAN sent\b/.test(s)), steps.join(' | ')).toEqual([]);
      expect(steps).toContainEqual(expect.stringMatching(/^SEARCH sent USING INDEX \w+ \(.*sent_at>\? AND sent_at<\?\)$/));
    }
  });
});
