import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { type SendTotals, sendTotals, sendTotalsByAccount } from '../src/db.ts';
import { IG_USER, NOW, seedAccount, seedSent } from './support/seed.ts';
import { adminPath, countingDb, request, signedInAdmin } from './support/worker.ts';

// The frozen clock is 2026-10-01 12:00 UTC. These are written out as dates
// rather than derived from NOW the way the Worker derives them, so an
// off-by-one-day in the Worker can't agree with itself here.
const TODAY = Date.UTC(2026, 9, 1) / 1000;
const WEEK = Date.UTC(2026, 8, 25) / 1000; // today and the six days before it
const MONTH = Date.UTC(2026, 8, 2) / 1000; // today and the 29 days before it
const STARTS = [TODAY, WEEK, MONTH, 0];
const LABELS = ['Today (UTC)', 'Last 7 days', 'Last 30 days', 'All time'];

const ALICE = '9100000000000001';
const BOB = '9100000000000002';
const CAROL = '9100000000000003';

/** The same numbers, one plain query per window and status, as someone checking D1 by hand would write them. */
async function byHand(since: number, igUserId?: string): Promise<SendTotals> {
  const account = igUserId ? ' AND ig_user_id = ?' : '';
  const one = async (select: string, status: string) => {
    const binds: unknown[] = [status, since, ...(igUserId ? [igUserId] : [])];
    const row = await env.DB.prepare(`SELECT ${select} AS n FROM sent WHERE dm_status = ? AND sent_at >= ?${account}`)
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
  const admin = await signedInAdmin();
  const res = await request(adminPath('/'), { headers: { Cookie: admin.cookieHeader }, env: db ? { DB: db } : undefined });
  expect(res.status).toBe(200);
  return res.text;
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
    expect(await sendTotals(env.DB, STARTS)).toEqual(expected);
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

    const perAccount = await sendTotalsByAccount(env.DB, STARTS);
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
});
