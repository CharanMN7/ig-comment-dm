import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { QUEUE_EXPIRY_SECONDS, SENDS_PER_MINUTE } from '../src/crypto.ts';
import { runMinute } from '../src/cron.ts';
import { claimDueSends, deleteRule, reserveSends, toggleRule } from '../src/db.ts';
import { processWebhook } from '../src/process.ts';
import { ACCOUNT_PAUSED_REASON, EXPIRED_ERROR, LEASE_ERROR, RULE_DELETED_ERROR, RULE_OFF_ERROR, drainQueue, minuteOf } from '../src/queue.ts';
import { EXTRA_REPLY_NO_DM } from '../src/other-replies.ts';
import { Subrequests } from '../src/subrequests.ts';
import { type MetaCall, type MetaReply, meta } from './support/meta.ts';
import {
  DAY,
  FROZEN_NOW_MS,
  IG_USER,
  NOW,
  extraReplyRows,
  seedAccount,
  seedQueued,
  seedRule,
  sentRow,
  sentRows,
} from './support/seed.ts';
import { MINUTE_CRON, adminPath, commentPayload, commentValue, postWebhook, runMinutes, runScheduled, signedInAdmin } from './support/worker.ts';

const OTHER = '17841400000000002';

const dmTargets = () =>
  meta.callsTo('POST', '/:id/messages').map((c) => (c.body as { recipient: { comment_id: string } }).recipient.comment_id);

function at(seconds: number): void {
  vi.setSystemTime(FROZEN_NOW_MS + seconds * 1000);
}

function nextMinute(): void {
  vi.setSystemTime(Date.now() + 60_000);
}

/**
 * The real database, counting what Cloudflare counts as subrequests (each
 * statement run, and each batch once) and keeping every statement prepared,
 * batched ones included, with its binds.
 */
function subrequestCountingDb(): { db: D1Database; count: () => number; statements: Array<{ sql: string; binds: unknown[] }> } {
  let n = 0;
  const statements: Array<{ sql: string; binds: unknown[] }> = [];
  class Counted {
    constructor(
      readonly inner: D1PreparedStatement,
      readonly sql: string,
    ) {}
    bind(...values: unknown[]) {
      statements.push({ sql: this.sql, binds: values });
      return new Counted(this.inner.bind(...values), this.sql);
    }
    first(column?: string) {
      n++;
      return column == null ? this.inner.first() : this.inner.first(column);
    }
    all() {
      n++;
      return this.inner.all();
    }
    run() {
      n++;
      return this.inner.run();
    }
    raw() {
      n++;
      return this.inner.raw();
    }
  }
  const db = {
    prepare: (sql: string) => new Counted(env.DB.prepare(sql), sql),
    batch: (batched: Counted[]) => {
      n++;
      return env.DB.batch(batched.map((s) => s.inner));
    },
    exec: (sql: string) => env.DB.exec(sql),
  } as unknown as D1Database;
  return { db, count: () => n, statements };
}

describe('Instagram’s hourly limit', () => {
  it('sends 12 DMs a minute per account, queues the 13th, and sends it in the next minute', async () => {
    await seedAccount();
    await seedRule();
    for (let i = 0; i < 13; i++) await postWebhook(commentPayload({ commentId: `c${String(i).padStart(2, '0')}` }));

    expect(dmTargets()).toHaveLength(12);
    expect(await sentRow('c12')).toMatchObject({ dm_status: 'queued', attempts: 0 });
    const home = (await (await signedInAdmin()).get(adminPath('/'))).text;
    expect(home).toMatch(/<td>Queued<\/td>/);

    await runScheduled(MINUTE_CRON);
    expect(dmTargets()).toHaveLength(12);

    nextMinute();
    await runScheduled(MINUTE_CRON);
    expect(dmTargets().at(-1)).toBe('c12');
    expect(await sentRow('c12')).toMatchObject({ dm_status: 'ok', attempts: 1 });
  });

  it('keeps a separate 12 for each account', async () => {
    await seedAccount();
    await seedAccount({ igUserId: OTHER, username: 'second', token: 'token-two' });
    await seedRule();
    await seedRule({ igUserId: OTHER });
    for (let i = 0; i < 13; i++) {
      await postWebhook(commentPayload({ commentId: `a${i}` }));
      await postWebhook(commentPayload({ commentId: `b${i}`, igUserId: OTHER }));
    }
    const byToken = (token: string) => meta.callsTo('POST', '/:id/messages').filter((c) => c.authorization === `Bearer ${token}`);
    expect(byToken('IGAA-test-access-token')).toHaveLength(12);
    expect(byToken('token-two')).toHaveLength(12);
  });

  it('never grants more than 12 in a minute to reservations made at the same moment', async () => {
    const grants = await Promise.all(
      Array.from({ length: 20 }, () => reserveSends(env.DB, IG_USER, minuteOf(NOW), 1, SENDS_PER_MINUTE, NOW)),
    );
    expect(grants.reduce((a, b) => a + b, 0)).toBe(12);
    expect(grants.filter((g) => g === 1)).toHaveLength(12);
  });

  it('grants no rolling hour of 90 busy minutes more than 732 slots', async () => {
    const step = 10;
    const grants: Array<{ at: number; n: number }> = [];
    for (let at = NOW + 7; at < NOW + 90 * 60; at += step) {
      grants.push({ at, n: await reserveSends(env.DB, IG_USER, minuteOf(at), 5, SENDS_PER_MINUTE, at) });
    }
    let busiest = 0;
    for (let start = NOW; start < NOW + 30 * 60; start += step) {
      const inHour = grants.filter((g) => g.at >= start && g.at < start + 3600).reduce((sum, g) => sum + g.n, 0);
      busiest = Math.max(busiest, inHour);
    }
    expect(busiest).toBeLessThanOrEqual(732);
    // The cap is the binding limit here, not the test's own pace.
    expect(busiest).toBeGreaterThanOrEqual(720);
  });

  it('doesn’t reopen a minute another Worker has already moved past', async () => {
    expect(await reserveSends(env.DB, IG_USER, minuteOf(NOW) + 1, 12, SENDS_PER_MINUTE, NOW)).toBe(12);
    expect(await reserveSends(env.DB, IG_USER, minuteOf(NOW), 12, SENDS_PER_MINUTE, NOW)).toBe(0);
  });

  it('doesn’t reopen it while the new minute still has room either', async () => {
    const m = minuteOf(NOW);
    expect(await reserveSends(env.DB, IG_USER, m + 1, 5, SENDS_PER_MINUTE, NOW)).toBe(5);
    expect(await reserveSends(env.DB, IG_USER, m, 12, SENDS_PER_MINUTE, NOW)).toBe(0);
    expect(await reserveSends(env.DB, IG_USER, m + 1, 12, SENDS_PER_MINUTE, NOW)).toBe(7);
  });
});

describe('sending from the queue', () => {
  it('sends each queued comment once when two minute jobs drain at the same time', async () => {
    await seedAccount();
    const ruleId = await seedRule();
    for (let i = 0; i < 6; i++) await seedQueued({ commentId: `q${i}`, ruleId, commentAt: NOW - 600 + i });

    await Promise.all([drainQueue(env, new Subrequests()), drainQueue(env, new Subrequests())]);

    expect(dmTargets().sort()).toEqual(['q0', 'q1', 'q2', 'q3', 'q4', 'q5']);
    expect((await sentRows()).map((r) => [r.dm_status, r.attempts])).toEqual(Array.from({ length: 6 }, () => ['ok', 1]));
  });

  it('hands each due comment to exactly one of two claims made at the same moment', async () => {
    await seedAccount();
    const ruleId = await seedRule();
    for (let i = 0; i < 6; i++) await seedQueued({ commentId: `q${i}`, ruleId, commentAt: NOW - 600 + i });

    const [a, b] = await Promise.all([
      claimDueSends(env.DB, IG_USER, NOW, 4, NOW + 120),
      claimDueSends(env.DB, IG_USER, NOW, 4, NOW + 120),
    ]);

    const ids = [...a, ...b].map((r) => r.comment_id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  it('takes turns between accounts, so one busy account can’t have the whole minute', async () => {
    const accounts = [IG_USER, OTHER, '17841400000000003'];
    for (const [i, id] of accounts.entries()) {
      await seedAccount({ igUserId: id, username: `account${i}`, token: `token-${i}` });
      const ruleId = await seedRule({ igUserId: id });
      for (let j = 0; j < 20; j++) await seedQueued({ commentId: `${i}-${j}`, ruleId, commentAt: NOW - 3600 + j, igUserId: id });
    }
    const perAccount = () => [0, 1, 2].map((i) => meta.callsTo('POST', '/:id/messages').filter((c) => c.authorization === `Bearer token-${i}`).length);

    at(60);
    await runScheduled(MINUTE_CRON);
    const first = perAccount();
    expect(Math.min(...first)).toBeGreaterThanOrEqual(4);

    at(120);
    await runScheduled(MINUTE_CRON);
    const second = perAccount().map((n, i) => n - first[i]!);
    expect(Math.min(...second)).toBeGreaterThanOrEqual(4);
    // The account that went last, and got the leftovers, isn't the same one twice.
    expect(second).not.toEqual(first);
  });

  it('puts back the sends a failing account claimed but never started, and still drains the next account', async () => {
    await seedAccount();
    await seedAccount({ igUserId: OTHER, username: 'second', token: 'token-two' });
    const one = await seedRule();
    const two = await seedRule({ igUserId: OTHER });
    for (let i = 0; i < 3; i++) {
      await seedQueued({ commentId: `a${i}`, ruleId: one, commentAt: NOW - 600 + i });
      await seedQueued({ commentId: `b${i}`, ruleId: two, commentAt: NOW - 600 + i, igUserId: OTHER });
    }
    // D1 refuses the first outcome write, after the DM to a0 went out.
    let refused = false;
    const flaky = {
      prepare: (sql: string) => {
        if (!refused && sql.includes('attempts = attempts + ?')) {
          refused = true;
          return { bind: () => ({ run: () => Promise.reject(new Error('D1 is unavailable')) }) };
        }
        return env.DB.prepare(sql);
      },
      batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
      exec: (sql: string) => env.DB.exec(sql),
    } as unknown as D1Database;

    await runMinute({ ...env, DB: flaky }, FROZEN_NOW_MS + 60_000);

    const first = dmTargets()[0]!;
    const failed = first.startsWith('a') ? 'a' : 'b';
    const other = failed === 'a' ? 'b' : 'a';
    // The send that threw may have gone out, so it waits for its lease.
    expect(await sentRow(first)).toMatchObject({ dm_status: 'pending' });
    // Its account's other claims were never started: back in the queue now.
    for (const id of [1, 2]) expect(await sentRow(`${failed}${id}`)).toMatchObject({ dm_status: 'queued' });
    for (const id of [0, 1, 2]) expect(await sentRow(`${other}${id}`)).toMatchObject({ dm_status: 'ok' });
    expect(dmTargets()).toHaveLength(4);
  });

  it('sends a comment once when the webhook, the poll and the queue all see it', async () => {
    await seedAccount();
    await seedRule();
    for (let i = 0; i < 12; i++) await postWebhook(commentPayload({ commentId: `full-${i}` }));
    await postWebhook(commentPayload({ commentId: 'contested' }));
    expect(await sentRow('contested')).toMatchObject({ dm_status: 'queued' });
    meta.on('GET', '/me/media', { json: { data: [{ id: '18000000000000777' }] } });
    meta.on('GET', '/:id/comments', {
      json: { data: [{ id: 'contested', text: 'Guide please!', timestamp: new Date(FROZEN_NOW_MS).toISOString(), from: { id: '9100000000000001', username: 'a_fan' } }] },
    });

    // The fifth minute: the poll runs, while Meta delivers the comment again.
    vi.setSystemTime(FROZEN_NOW_MS + 5 * 60_000);
    await Promise.all([postWebhook(commentPayload({ commentId: 'contested' })), runScheduled(MINUTE_CRON), runScheduled(MINUTE_CRON)]);

    expect(dmTargets().filter((id) => id === 'contested')).toHaveLength(1);
    expect(await sentRow('contested')).toMatchObject({ dm_status: 'ok', attempts: 1 });
  });

  it('sends the oldest comment first and fills {username} from what the queue kept', async () => {
    await seedAccount();
    const ruleId = await seedRule({ dmText: 'Hi {username}!' });
    await seedQueued({ commentId: 'newer', ruleId, commentAt: NOW - 60, username: 'newer_fan' });
    await seedQueued({ commentId: 'older', ruleId, commentAt: NOW - 600, username: 'older_fan' });

    await runMinutes();

    expect(meta.callsTo('POST', '/:id/messages').map((c) => c.body)).toEqual([
      { recipient: { comment_id: 'older' }, message: { text: 'Hi older_fan!' } },
      { recipient: { comment_id: 'newer' }, message: { text: 'Hi newer_fan!' } },
    ]);
  });

  it('gives up on a comment an hour short of Instagram’s 7 days, without calling Instagram', async () => {
    await seedAccount();
    const ruleId = await seedRule();
    await seedQueued({ commentId: 'too-old', ruleId, commentAt: NOW - QUEUE_EXPIRY_SECONDS - 1 });
    await seedQueued({ commentId: 'six-days', ruleId, commentAt: NOW - 6 * DAY });
    // Waited past its comment's time, as a retry does, so the sweep's range
    // misses it and the claim has to catch it.
    await seedQueued({ commentId: 'late-retry', ruleId, commentAt: NOW - QUEUE_EXPIRY_SECONDS - 1 });
    await env.DB.prepare('UPDATE sent SET next_attempt_at = ? WHERE comment_id = ?').bind(NOW - 60, 'late-retry').run();

    await runMinutes();

    expect(dmTargets()).toEqual(['six-days']);
    expect(await sentRow('too-old')).toMatchObject({ dm_status: 'skipped', error: EXPIRED_ERROR, attempts: 0, next_attempt_at: null });
    expect(await sentRow('late-retry')).toMatchObject({ dm_status: 'skipped', error: EXPIRED_ERROR, attempts: 0 });
  });

  it('records a send whose Worker stopped as possibly delivered, and never sends it again', async () => {
    await seedAccount();
    const ruleId = await seedRule();
    await seedQueued({ commentId: 'stopped', ruleId });
    await seedQueued({ commentId: 'in-flight', ruleId });
    await env.DB.prepare(
      "UPDATE sent SET dm_status = 'pending', next_attempt_at = CASE comment_id WHEN 'stopped' THEN ? ELSE ? END",
    )
      .bind(NOW, NOW + 60)
      .run();

    await runMinutes();
    expect(await sentRow('stopped')).toMatchObject({ dm_status: 'unsure', error: LEASE_ERROR, attempts: 1, next_attempt_at: null });
    expect(LEASE_ERROR).toContain('may have been delivered');
    expect(await sentRow('in-flight')).toMatchObject({ dm_status: 'pending' });

    nextMinute();
    await runMinutes(2);
    expect(await sentRow('in-flight')).toMatchObject({ dm_status: 'unsure', error: LEASE_ERROR });
    expect(dmTargets()).toEqual([]);
  });

  it('leaves the daily job’s stuck-send sweep off a queued DM that is being sent right now', async () => {
    await seedAccount();
    const ruleId = await seedRule();
    // Queued an hour ago, so its sent_at is well before the sweep's cutoff.
    await seedQueued({ commentId: 'sending', ruleId, commentAt: NOW - 3600 });
    await env.DB.prepare("UPDATE sent SET dm_status = 'pending', next_attempt_at = ?, sent_at = ?").bind(NOW + 60, NOW - 3600).run();

    await runScheduled('0 3 * * *');

    expect(await sentRow('sending')).toMatchObject({ dm_status: 'pending' });
  });

  it('skips a queued DM whose rule was deleted or turned off while it waited', async () => {
    await seedAccount();
    const gone = await seedRule({ label: 'Gone' });
    const off = await seedRule({ label: 'Off' });
    await seedQueued({ commentId: 'for-gone', ruleId: gone });
    await seedQueued({ commentId: 'for-off', ruleId: off });
    await deleteRule(env.DB, gone);
    await toggleRule(env.DB, off);

    await runMinutes();

    expect(meta.calls).toEqual([]);
    expect(await sentRow('for-gone')).toMatchObject({ dm_status: 'skipped', error: RULE_DELETED_ERROR });
    expect(await sentRow('for-off')).toMatchObject({ dm_status: 'skipped', error: RULE_OFF_ERROR });
  });

  it('skips a paused account’s queued DMs rather than sending them late once it resumes', async () => {
    await seedAccount();
    const ruleId = await seedRule();
    await seedQueued({ commentId: 'held', ruleId });
    await env.DB.prepare('UPDATE accounts SET active = 0').run();
    await runMinutes();
    expect(await sentRow('held')).toMatchObject({ dm_status: 'skipped', error: ACCOUNT_PAUSED_REASON, next_attempt_at: null });

    await env.DB.prepare('UPDATE accounts SET active = 1').run();
    nextMinute();
    await runMinutes();
    expect(dmTargets()).toEqual([]);
  });

  it('posts another matching rule’s public reply only once a queued DM is confirmed, and only once', async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'], publicReply: 'Sent you a DM!' });
    const prices = await seedRule({ keywords: ['guide'], publicReply: 'Prices from $20', replyWithoutDm: true });
    await seedRule({ keywords: ['hello'], label: 'Filler' });
    for (let i = 0; i < 12; i++) await postWebhook(commentPayload({ commentId: `full-${i}`, text: 'hello' }));
    await postWebhook(commentPayload({ commentId: 'waits', text: 'guide please' }));
    expect(await sentRow('waits')).toMatchObject({ dm_status: 'queued' });
    expect(await extraReplyRows()).toMatchObject([{ comment_id: 'waits', rule_id: prices, status: 'queued' }]);
    expect(meta.callsTo('POST', '/waits/replies')).toEqual([]);

    nextMinute();
    await Promise.all([runScheduled(MINUTE_CRON), runScheduled(MINUTE_CRON)]);

    expect(meta.callsTo('POST', '/waits/replies').map((c) => c.body)).toEqual([{ message: 'Sent you a DM!' }, { message: 'Prices from $20' }]);
    expect(await extraReplyRows()).toMatchObject([{ comment_id: 'waits', rule_id: prices, status: 'ok' }]);
  });

  it('never posts another rule’s reply for a queued DM that Instagram turned down or that expired', async () => {
    await seedAccount();
    const guide = await seedRule({ keywords: ['guide'] });
    const prices = await seedRule({ keywords: ['guide'], publicReply: 'Prices from $20', replyWithoutDm: true });
    for (const [id, commentAt] of [['refused', NOW - 60], ['expired', NOW - QUEUE_EXPIRY_SECONDS + 30]] as const) {
      await seedQueued({ commentId: id, ruleId: guide, commentAt });
      await env.DB.prepare("INSERT INTO sent_extra_replies (comment_id, rule_id, status, error, sent_at) VALUES (?, ?, 'queued', NULL, ?)")
        .bind(id, prices, NOW)
        .run();
    }
    await env.DB.prepare('UPDATE sent SET next_attempt_at = ? WHERE comment_id = ?').bind(NOW - 60, 'expired').run();
    meta.on('POST', '/:id/messages', { status: 400, json: { error: { message: 'Invalid parameter', code: 100 } } });
    vi.setSystemTime(FROZEN_NOW_MS + 61 * 60_000);

    await runMinutes();

    expect(meta.callsTo('POST', '/:id/replies')).toEqual([]);
    expect(await extraReplyRows()).toMatchObject([
      { comment_id: 'refused', status: 'skipped', error: EXTRA_REPLY_NO_DM },
      { comment_id: 'expired', status: 'skipped', error: EXTRA_REPLY_NO_DM },
    ]);
  });

  it('accounts for every matched comment: each ends in one state, and DM calls equal the attempts recorded', async () => {
    await seedAccount();
    await seedRule({ excludeKeywords: ['price'], publicReply: 'Sent!' });
    const answers: Record<string, MetaReply> = {
      'c-refused': { status: 400, json: { error: { message: 'Invalid parameter', code: 100 } } },
      'c-unknown': { status: 503, json: {} },
      'q-refused': { status: 400, json: { error: { message: 'Invalid parameter', code: 100 } } },
    };
    meta.on('POST', '/:id/messages', (call: MetaCall) => {
      const id = (call.body as { recipient: { comment_id: string } }).recipient.comment_id;
      return answers[id] ?? { json: { recipient_id: '1', message_id: `m-${id}` } };
    });
    const ids = [
      'c-ok-1', 'c-refused', 'c-unknown', 'c-ok-2', 'c-ok-3', 'c-ok-4', 'c-ok-5', 'c-ok-6', 'c-ok-7', 'c-ok-8', 'c-ok-9', 'c-ok-10',
      'q-ok-1', 'q-refused', 'q-ok-2',
    ];
    for (const id of ids) await postWebhook(commentPayload({ commentId: id }));
    await postWebhook(commentPayload({ commentId: 'excluded', text: 'guide price?' }));
    await postWebhook(commentPayload({ commentId: 'unmatched', text: 'love it' }));
    await runMinutes(3);

    const rows = await sentRows();
    const count = (status: string) => rows.filter((r) => r.dm_status === status).length;
    // Claimed = sent + skipped + failed + unsure + queued + retrying + in flight, with nothing left waiting.
    expect(rows).toHaveLength(ids.length + 1);
    const states = ['ok', 'skipped', 'failed', 'unsure', 'queued', 'retry', 'pending'];
    expect(states.reduce((sum, state) => sum + count(state), 0)).toBe(rows.length);
    expect(states.map(count)).toEqual([12, 1, 2, 1, 0, 0, 0]);
    expect(meta.callsTo('POST', '/:id/messages')).toHaveLength(rows.reduce((sum, r) => sum + r.attempts, 0));
    expect(meta.callsTo('POST', '/:id/replies')).toHaveLength(12);
  });
});

describe('Cloudflare’s 50 subrequests per run', () => {
  it('keeps a poll minute with a long queue on two accounts inside 50', async () => {
    await seedAccount();
    await seedAccount({ igUserId: OTHER, username: 'second', token: 'token-two' });
    const one = await seedRule({ publicReply: 'Sent!' });
    const two = await seedRule({ igUserId: OTHER, publicReply: 'Sent!' });
    for (let i = 0; i < 30; i++) {
      await seedQueued({ commentId: `a${i}`, ruleId: one, commentAt: NOW - 3600 + i });
      await seedQueued({ commentId: `b${i}`, ruleId: two, commentAt: NOW - 3600 + i, igUserId: OTHER });
    }
    meta.on('GET', '/me/media', { json: { data: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] } });
    meta.on('GET', '/:id/comments', (call) => ({
      json: {
        data: Array.from({ length: 25 }, (_, i) => ({
          id: `${call.authorization === 'Bearer token-two' ? 'b' : 'a'}-${call.path.split('/')[1]}-${i}`,
          text: 'guide',
          timestamp: new Date(FROZEN_NOW_MS - 60_000).toISOString(),
          from: { id: `93${String(i).padStart(14, '0')}` },
        })),
      },
    }));
    const { db, count } = subrequestCountingDb();

    await runMinute({ ...env, DB: db }, FROZEN_NOW_MS);

    expect(count() + meta.calls.length).toBeLessThanOrEqual(50);
    // It still did real work on both fronts.
    expect(meta.callsTo('GET', '/:id/comments').length).toBeGreaterThan(0);
    expect(dmTargets().length).toBeGreaterThan(0);
  });

  it('keeps a quiet minute with a long queue inside 50, sending a full minute’s 12', async () => {
    await seedAccount();
    const ruleId = await seedRule({ publicReply: 'Sent!' });
    for (let i = 0; i < 30; i++) await seedQueued({ commentId: `q${String(i).padStart(2, '0')}`, ruleId, commentAt: NOW - 3600 + i });
    const { db, count } = subrequestCountingDb();

    await runMinute({ ...env, DB: db }, FROZEN_NOW_MS + 60_000);

    expect(count() + meta.calls.length).toBeLessThanOrEqual(50);
    expect(dmTargets()).toHaveLength(12);
  });

  it('gives every comment in a large delivery a row, sending what fits and queueing the rest', async () => {
    await seedAccount();
    await seedRule({ publicReply: 'Sent!' });
    const payload = commentPayload({ commentId: 'big-0' });
    for (let i = 1; i < 40; i++) payload.entry[0]!.changes.push({ field: 'comments', value: commentValue({ commentId: `big-${i}` }) });
    const { db, count } = subrequestCountingDb();

    await processWebhook({ ...env, DB: db }, payload, Date.now() + 25_000);

    expect(count() + meta.calls.length).toBeLessThanOrEqual(50);
    const rows = await sentRows();
    expect(rows).toHaveLength(40);
    expect(rows.filter((r) => r.dm_status === 'ok').length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.dm_status === 'queued').length).toBeGreaterThan(0);
  });
});

describe('reading the queue', () => {
  async function plan(sql: string, binds: unknown[]): Promise<string[]> {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...binds)
      .all<{ detail: string }>();
    return results.map((r) => r.detail);
  }

  it('finds due, stuck and expired sends through the queue indexes, never a scan of sent', async () => {
    await seedAccount();
    const ruleId = await seedRule();
    await seedQueued({ commentId: 'q1', ruleId });
    const { db, statements } = subrequestCountingDb();

    await drainQueue({ ...env, DB: db }, new Subrequests());

    const queueReads = statements.filter((c) => /next_attempt_at <=? \?/.test(c.sql));
    expect(queueReads.length).toBeGreaterThanOrEqual(4);
    for (const call of queueReads) {
      const steps = await plan(call.sql, call.binds);
      expect(steps.filter((s) => /^SCAN sent\b/.test(s)), `${call.sql}\n${steps.join(' | ')}`).toEqual([]);
      expect(steps.join(' | '), call.sql).toMatch(/idx_sent_(queue|lease)/);
    }
  });
});

describe('the migration', () => {
  it('leaves every row from before it out of the queue', async () => {
    await seedAccount();
    await seedRule();
    await env.DB.prepare(
      `INSERT INTO sent (comment_id, ig_user_id, rule_id, commenter_id, dm_status, reply_status, error, sent_at)
       VALUES ('old-ok', ?1, 1, NULL, 'ok', NULL, NULL, ?2), ('old-failed', ?1, 1, NULL, 'failed', NULL, 'x', ?2)`,
    )
      .bind(IG_USER, NOW - DAY)
      .run();
    await runMinutes(2);
    expect(dmTargets()).toEqual([]);
    expect(await sentRows()).toMatchObject([
      { comment_id: 'old-failed', dm_status: 'failed', attempts: 0, next_attempt_at: null, comment_at: null, username: null },
      { comment_id: 'old-ok', dm_status: 'ok', attempts: 0, next_attempt_at: null },
    ]);
  });
});

describe('D1’s 100,000 row writes a day', () => {
  /** Rows written, as D1 counts them for the free plan, by everything one webhook delivery and the minute job after it do. */
  async function rowsWritten(work: (db: D1Database) => Promise<unknown>): Promise<number> {
    let written = 0;
    const tally = <T>(result: T): T => {
      for (const r of Array.isArray(result) ? result : [result]) written += (r as D1Result).meta?.rows_written ?? 0;
      return result;
    };
    const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
      ({
        inner: stmt,
        bind: (...v: unknown[]) => wrap(stmt.bind(...v)),
        first: async (col?: string) => {
          const res = tally(await stmt.all<Record<string, unknown>>());
          const row = res.results[0];
          return row == null ? null : col == null ? row : row[col];
        },
        all: async () => tally(await stmt.all()),
        run: async () => tally(await stmt.run()),
        raw: () => stmt.raw(),
      }) as unknown as D1PreparedStatement;
    const db = {
      prepare: (sql: string) => wrap(env.DB.prepare(sql)),
      batch: async (s: Array<D1PreparedStatement & { inner: D1PreparedStatement }>) => tally(await env.DB.batch(s.map((x) => x.inner))),
      exec: (sql: string) => env.DB.exec(sql),
    } as unknown as D1Database;
    await work(db);
    return written;
  }

  it('costs a comment no rule matches nothing beyond the webhook log, and a DM 10 rows sent now or 13 queued', async () => {
    await seedAccount();
    await seedRule({ publicReply: 'Sent!' });
    // Warm the budget row, which is written once per account and then updated.
    await reserveSends(env.DB, IG_USER, minuteOf(NOW) - 1, 1, SENDS_PER_MINUTE, NOW);

    const unmatched = await rowsWritten((db) =>
      processWebhook({ ...env, DB: db }, commentPayload({ commentId: 'nope', text: 'love it' }), Date.now() + 25_000),
    );
    const now = await rowsWritten((db) => processWebhook({ ...env, DB: db }, commentPayload({ commentId: 'now' }), Date.now() + 25_000));
    for (let i = 0; i < 11; i++) await postWebhook(commentPayload({ commentId: `fill-${i}` }));
    const queued = await rowsWritten((db) => processWebhook({ ...env, DB: db }, commentPayload({ commentId: 'later' }), Date.now() + 25_000));
    nextMinute();
    const drained = await rowsWritten((db) => runMinute({ ...env, DB: db }, Date.now()));

    expect(await sentRow('later')).toMatchObject({ dm_status: 'ok' });
    // The webhook route's own log adds 2 to each: the row and its index. The
    // docs quote these numbers; change them together.
    expect(unmatched).toBe(0);
    expect(now).toBeLessThanOrEqual(10);
    expect(queued + drained).toBeLessThanOrEqual(13);
  });
});
