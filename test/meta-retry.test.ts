import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_TIME_FOR_PUBLIC_REPLY_ERROR, WEBHOOK_SEND_BUDGET_MS } from '../src/process.ts';
import { FAKE_EXPIRES_IN, FAKE_ME, meta, type MetaReply } from './support/meta.ts';
import { DAY, FROZEN_NOW_MS, NOW, accountRow, seedAccount, seedRule, sentRow, storedToken, systemValue } from './support/seed.ts';
import {
  commentPayload,
  commentValue,
  postWebhook,
  returnFromInstagram,
  runScheduled,
  signedInAdmin,
  startConnect,
} from './support/worker.ts';

// Backoff sleeps up to two real seconds per call, so setTimeout is faked here
// too. vi.mock can't stub the sleep instead: the pool loads the Worker's
// modules before a test file's mocks are registered.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
  vi.setSystemTime(FROZEN_NOW_MS);
});

/** Lets fake time run forward whenever the Worker is waiting on a backoff timer. */
async function withBackoffSkipped<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = work.finally(() => {
    settled = true;
  });
  while (!settled) await vi.advanceTimersToNextTimerAsync();
  return tracked;
}

function replies(...sequence: MetaReply[]) {
  let i = 0;
  return () => sequence[Math.min(i++, sequence.length - 1)]!;
}

async function deliverMatchingComment() {
  await seedAccount();
  await seedRule();
  await withBackoffSkipped(postWebhook(commentPayload()));
  return sentRow('17900000000000001');
}

function gapsBetween(calls: { at: number }[]): number[] {
  return calls.slice(1).map((c, i) => c.at - calls[i]!.at);
}

describe('Meta retry policy', () => {
  it('retries a 5xx with growing jittered backoff and records the eventual success', async () => {
    meta.on('POST', '/:id/messages', replies({ status: 500, json: {} }, { status: 503, json: {} }, { json: { message_id: 'm1' } }));
    const row = await deliverMatchingComment();
    const attempts = meta.callsTo('POST', '/:id/messages');
    expect(attempts).toHaveLength(3);
    expect(row).toMatchObject({ dm_status: 'ok', error: null });
    const [first, second] = gapsBetween(attempts);
    expect(first).toBeGreaterThanOrEqual(250);
    expect(first).toBeLessThan(750);
    expect(second).toBeGreaterThanOrEqual(500);
    expect(second).toBeLessThan(1500);
  });

  it('gives up after three attempts and records the last 5xx body', async () => {
    meta.on('POST', '/:id/messages', { status: 500, json: { error: { message: 'An unknown error occurred', code: 1 } } });
    const row = await deliverMatchingComment();
    expect(meta.callsTo('POST', '/:id/messages')).toHaveLength(3);
    expect(row).toMatchObject({ dm_status: 'failed' });
    expect(row?.error).toContain('An unknown error occurred');
  });

  it('treats 429 like a 5xx', async () => {
    meta.on('POST', '/:id/messages', replies({ status: 429, json: {} }, { json: { message_id: 'm1' } }));
    const row = await deliverMatchingComment();
    expect(meta.callsTo('POST', '/:id/messages')).toHaveLength(2);
    expect(row).toMatchObject({ dm_status: 'ok' });
  });

  it('never retries other 4xx responses', async () => {
    meta.on('POST', '/:id/messages', { status: 400, json: { error: { message: 'Invalid parameter' } } });
    const row = await deliverMatchingComment();
    expect(meta.callsTo('POST', '/:id/messages')).toHaveLength(1);
    expect(row).toMatchObject({ dm_status: 'failed' });
  });

  // A pending row is never retried: dedupe and the 5-minute poll both treat it
  // as handled, and Home shows "In progress" for good.
  it('records a send that never reaches Meta as failed rather than leaving it pending', async () => {
    meta.on('POST', '/:id/messages', { networkError: true });
    const row = await deliverMatchingComment();
    expect(meta.callsTo('POST', '/:id/messages')).toHaveLength(3);
    expect(row).toMatchObject({ dm_status: 'failed' });
    expect(row?.error).toMatch(/^DM: could not reach Instagram after 3 tries \(.+\)$/);
  });

  describe('with a hung request', () => {
    // AbortSignal.timeout runs on workerd's own clock, which fake timers don't
    // move, so a real hang would cost the suite 30 seconds. An already-expired
    // signal is what fetch sees once the 10 seconds are up.
    const expired = () => AbortSignal.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('gives every attempt its own 10-second timeout and records three timeouts as a failed send', async () => {
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(expired);
      const row = await deliverMatchingComment();
      expect(timeout.mock.calls).toEqual([[10_000], [10_000], [10_000]]);
      expect(row).toMatchObject({ dm_status: 'failed' });
      expect(row?.error).toBe('DM: could not reach Instagram after 3 tries (The operation was aborted due to timeout)');
    });

    it('retries after a timeout like any other network failure', async () => {
      vi.spyOn(AbortSignal, 'timeout').mockImplementationOnce(expired);
      const row = await deliverMatchingComment();
      expect(meta.callsTo('POST', '/:id/messages')).toHaveLength(1);
      expect(row).toMatchObject({ dm_status: 'ok', error: null });
    });
  });

  it('records a public reply that never reaches Meta as failed, keeping the DM as sent', async () => {
    meta.on('POST', '/:id/replies', { networkError: true });
    await seedAccount();
    await seedRule({ publicReply: 'Sent you a DM!' });
    await withBackoffSkipped(postWebhook(commentPayload()));
    const row = await sentRow('17900000000000001');
    expect(meta.callsTo('POST', '/:id/replies')).toHaveLength(3);
    expect(row).toMatchObject({ dm_status: 'ok', reply_status: 'failed' });
    expect(row?.error).toMatch(/^public reply: could not reach Instagram after 3 tries/);
  });
});

describe('the time a webhook delivery is allowed', () => {
  // The webhook starts the clock as it hands the delivery to waitUntil, and only these tests move Date.
  const deadline = FROZEN_NOW_MS + WEBHOOK_SEND_BUDGET_MS;
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Records each attempt's timeout and when it started. The attempts numbered
   * in `hanging` (from 0) get no answer: the clock moves on by their whole
   * timeout and the request is aborted, as AbortSignal.timeout would do on
   * workerd's own clock, which fake timers can't reach.
   */
  function trackAttempts(hanging: number[]): Array<{ ms: number; at: number }> {
    const attempts: Array<{ ms: number; at: number }> = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      attempts.push({ ms, at: Date.now() });
      if (!hanging.includes(attempts.length - 1)) return realTimeout(ms);
      vi.setSystemTime(Date.now() + ms);
      return AbortSignal.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    });
    return attempts;
  }

  it('cuts the last DM attempt to the time left, then records a public reply there is no time for as failed', async () => {
    const attempts = trackAttempts([0, 1]);
    // The third attempt gets through a second before the deadline.
    meta.on('POST', '/:id/messages', () => {
      vi.setSystemTime(deadline - 1_000);
      return { json: { recipient_id: '1234567890', message_id: 'm1' } };
    });
    await seedAccount();
    await seedRule({ publicReply: 'Sent you a DM!' });

    await withBackoffSkipped(postWebhook(commentPayload()));

    expect(attempts.map((a) => a.ms).slice(0, 2)).toEqual([10_000, 10_000]);
    expect(attempts[2]!.ms).toBe(deadline - attempts[2]!.at);
    expect(attempts[2]!.ms).toBeLessThan(10_000);
    // Three attempts, all the DM's: the public reply never started one.
    expect(attempts).toHaveLength(3);
    expect(meta.callsTo('POST', '/:id/replies')).toEqual([]);
    const row = await sentRow('17900000000000001');
    expect(row).toMatchObject({ dm_status: 'ok', reply_status: 'failed', error: NO_TIME_FOR_PUBLIC_REPLY_ERROR });
    expect(row!.sent_at * 1000).toBeLessThanOrEqual(deadline);
  });

  it('shares the time across a batched delivery: no retry that cannot finish, and no claim without time to send', async () => {
    // Attempt 0 is the first comment's DM, which Meta answers after 9 s.
    const attempts = trackAttempts([1, 2]);
    meta.on('POST', '/:id/messages', () => {
      vi.setSystemTime(Date.now() + 9_000);
      return { json: { recipient_id: '1234567890', message_id: 'm1' } };
    });
    await seedAccount();
    await seedRule();
    const payload = commentPayload({ commentId: 'batch-1' });
    payload.entry[0]!.changes.push(
      { field: 'comments', value: commentValue({ commentId: 'batch-2' }) },
      { field: 'comments', value: commentValue({ commentId: 'batch-3' }) },
    );

    await withBackoffSkipped(postWebhook(payload));

    // The second comment's first attempt gets its full 10 s, its second only
    // what is left, and a third would start after the deadline.
    expect(attempts.map((a) => a.ms).slice(0, 2)).toEqual([10_000, 10_000]);
    expect(attempts[2]!.ms).toBe(deadline - attempts[2]!.at);
    expect(attempts).toHaveLength(3);
    expect(meta.callsTo('POST', '/:id/messages')).toHaveLength(1);
    expect(await sentRow('batch-1')).toMatchObject({ dm_status: 'ok' });
    const failed = await sentRow('batch-2');
    expect(failed).toMatchObject({ dm_status: 'failed' });
    expect(failed?.error).toMatch(/^DM: could not reach Instagram after 2 tries, and there was no time left to try again \(.+\)$/);
    expect(failed!.sent_at * 1000).toBeLessThanOrEqual(deadline);
    // Left unclaimed rather than failed, so the 5-minute poll can still send it.
    expect(await sentRow('batch-3')).toBeNull();
  });
});

describe('when Instagram cannot be reached at all', () => {
  it('still refreshes the other accounts and records the daily run when one refresh never gets an answer', async () => {
    await seedAccount({ igUserId: '17841400000000001', token: 'token-unreachable', expiresAt: NOW + 3 * DAY, lastRefreshedAt: NOW - 57 * DAY });
    await seedAccount({ igUserId: '17841400000000002', token: 'token-fine', expiresAt: NOW + 5 * DAY, lastRefreshedAt: NOW - 55 * DAY });
    meta.on('GET', '/refresh_access_token', (call) =>
      call.query.access_token === 'token-unreachable'
        ? { networkError: true }
        : { json: { access_token: 'refreshed-token', token_type: 'bearer', expires_in: FAKE_EXPIRES_IN } },
    );

    await withBackoffSkipped(runScheduled('0 3 * * *'));

    expect(meta.callsTo('GET', '/refresh_access_token').map((c) => c.query.access_token)).toEqual([
      'token-unreachable',
      'token-unreachable',
      'token-unreachable',
      'token-fine',
    ]);
    expect(await storedToken('17841400000000002')).toBe('refreshed-token');
    expect(await accountRow('17841400000000001')).toMatchObject({ needs_reconnect: 1, token_expires_at: NOW + 3 * DAY });
    // The skipped backoff moves the fake clock on by a second or two.
    expect(Number(await systemValue('last_cron_ok_at'))).toBeGreaterThanOrEqual(NOW);
  });

  it('reports a saved account as connected when only the comment subscription never gets an answer', async () => {
    meta.on('POST', '/:id/subscribed_apps', { networkError: true });
    const admin = await signedInAdmin();
    const state = await startConnect(admin);

    const res = await withBackoffSkipped(returnFromInstagram(admin, { code: 'c', state }));

    expect(res.status).toBe(200);
    expect(res.text).toContain(`Connected @${FAKE_ME.username}`);
    expect(res.text).toContain('Comment notifications may not be on yet.');
    expect(await accountRow(FAKE_ME.user_id)).toMatchObject({ username: FAKE_ME.username, active: 1 });
  });
});
