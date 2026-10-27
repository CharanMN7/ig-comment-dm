import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_TIME_FOR_PUBLIC_REPLY_ERROR, WEBHOOK_SEND_BUDGET_MS } from '../src/process.ts';
import { FAKE_EXPIRES_IN, FAKE_ME, meta, type MetaReply } from './support/meta.ts';
import {
  DAY,
  FROZEN_NOW_MS,
  NOW,
  accountRow,
  extraReplyRows,
  seedAccount,
  seedRule,
  sentRow,
  storedToken,
  systemValue,
} from './support/seed.ts';
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

// Nothing tells Meta a request is a repeat, so a second attempt after an
// answer that never came can deliver the same DM, or post the same public
// reply, twice. These cases must each reach Instagram at most once.
describe('a DM or public reply gets one attempt', () => {
  it('records a 5xx as may have been delivered, without sending again', async () => {
    meta.on('POST', '/:id/messages', { status: 500, json: { error: { message: 'An unknown error occurred', code: 1 } } });
    const row = await deliverMatchingComment();
    expect(meta.callsTo('POST', '/:id/messages')).toHaveLength(1);
    expect(row).toMatchObject({ dm_status: 'failed' });
    expect(row?.error).toMatch(
      /^DM: Instagram answered with a server error \(500\), so it may have been delivered\. It wasn't sent again, so it can't arrive twice\. \(.*An unknown error occurred.*\)$/,
    );
  });

  it('records a 429 as Instagram turning the DM down, without sending again', async () => {
    meta.on('POST', '/:id/messages', { status: 429, json: { error: { message: 'Application request limit reached', code: 4 } } });
    const row = await deliverMatchingComment();
    expect(meta.callsTo('POST', '/:id/messages')).toHaveLength(1);
    expect(row).toMatchObject({ dm_status: 'failed' });
    expect(row?.error).toMatch(/^DM: \{.*Application request limit reached/);
  });

  it('never retries other 4xx responses', async () => {
    meta.on('POST', '/:id/messages', { status: 400, json: { error: { message: 'Invalid parameter' } } });
    const row = await deliverMatchingComment();
    expect(meta.callsTo('POST', '/:id/messages')).toHaveLength(1);
    expect(row).toMatchObject({ dm_status: 'failed' });
    expect(row?.error).toMatch(/^DM: \{.*Invalid parameter/);
  });

  // A pending row is never retried: dedupe and the 5-minute poll both treat it
  // as handled, and Home shows "In progress" for good.
  it('records a dropped connection as may have been delivered rather than leaving it pending', async () => {
    meta.on('POST', '/:id/messages', { networkError: true });
    const row = await deliverMatchingComment();
    expect(meta.callsTo('POST', '/:id/messages')).toHaveLength(1);
    expect(row).toMatchObject({ dm_status: 'failed' });
    expect(row?.error).toMatch(/^DM: the connection to Instagram failed, so it may have been delivered\. .+ \(.+\)$/);
  });

  it('records an answer cut off partway as may have been delivered, even when it began with 200', async () => {
    meta.on('POST', '/:id/messages', { cutOff: true });
    const row = await deliverMatchingComment();
    expect(meta.callsTo('POST', '/:id/messages')).toHaveLength(1);
    expect(row).toMatchObject({ dm_status: 'failed' });
    expect(row?.error).toMatch(/^DM: Instagram's answer was cut off before it could be read, so it may have been delivered\./);
  });

  it('records a public reply that never reaches Meta as failed, keeping the DM as sent', async () => {
    meta.on('POST', '/:id/replies', { networkError: true });
    await seedAccount();
    await seedRule({ publicReply: 'Sent you a DM!' });
    await postWebhook(commentPayload());
    const row = await sentRow('17900000000000001');
    expect(meta.callsTo('POST', '/:id/replies')).toHaveLength(1);
    expect(row).toMatchObject({ dm_status: 'ok', reply_status: 'failed' });
    expect(row?.error).toMatch(/^public reply: the connection to Instagram failed, so it may have been posted\. It wasn't posted again, so it can't appear twice\./);
  });

  it('posts a public reply after a 5xx exactly once', async () => {
    meta.on('POST', '/:id/replies', { status: 503, json: {} });
    await seedAccount();
    await seedRule({ publicReply: 'Sent you a DM!' });
    await postWebhook(commentPayload());
    expect(meta.callsTo('POST', '/:id/replies')).toHaveLength(1);
    expect(await sentRow('17900000000000001')).toMatchObject({ dm_status: 'ok', reply_status: 'failed' });
  });

  describe('with a hung request', () => {
    const timedOut = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    afterEach(() => {
      vi.restoreAllMocks();
    });

    // AbortSignal.timeout runs on workerd's own clock, which fake timers don't
    // move, so a real hang would cost the suite 10 seconds. An already-expired
    // signal is what fetch sees once the time is up.
    it('gives the DM one 10-second attempt and records the timeout as may have been delivered', async () => {
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort(timedOut()));
      const row = await deliverMatchingComment();
      expect(timeout.mock.calls).toEqual([[10_000]]);
      expect(row).toMatchObject({ dm_status: 'failed' });
      expect(row?.error).toBe(
        "DM: Instagram didn't answer within 10 seconds, so it may have been delivered. It wasn't sent again, so it can't arrive twice. (The operation was aborted due to timeout)",
      );
    });

    // The request reaches Instagram, which may act on it, and only then does
    // the attempt run out of time. Before single attempts this posted three
    // replies under the comment.
    it('posts a public reply that times out exactly once', async () => {
      const signals: AbortController[] = [];
      vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
        const controller = new AbortController();
        signals.push(controller);
        return controller.signal;
      });
      meta.on('POST', '/:id/replies', () => {
        signals.at(-1)!.abort(timedOut());
        return { json: { id: '18000000000000001' } };
      });
      await seedAccount();
      await seedRule({ publicReply: 'Sent you a DM!' });

      await withBackoffSkipped(postWebhook(commentPayload()));

      expect(meta.callsTo('POST', '/:id/messages')).toHaveLength(1);
      expect(meta.callsTo('POST', '/:id/replies')).toHaveLength(1);
      const row = await sentRow('17900000000000001');
      expect(row).toMatchObject({ dm_status: 'ok', reply_status: 'failed' });
      expect(row?.error).toMatch(/^public reply: Instagram didn't answer within 10 seconds, so it may have been posted\./);
    });
  });
});

describe('reads from Instagram', () => {
  it('retries a 5xx with growing jittered backoff and uses the eventual answer', async () => {
    await seedAccount({ expiresAt: NOW + 3 * DAY, lastRefreshedAt: NOW - 57 * DAY });
    meta.on(
      'GET',
      '/refresh_access_token',
      replies(
        { status: 500, json: {} },
        { status: 503, json: {} },
        { json: { access_token: 'refreshed-token', token_type: 'bearer', expires_in: FAKE_EXPIRES_IN } },
      ),
    );

    await withBackoffSkipped(runScheduled('0 3 * * *'));

    const attempts = meta.callsTo('GET', '/refresh_access_token');
    expect(attempts).toHaveLength(3);
    expect(await storedToken()).toBe('refreshed-token');
    const [first, second] = gapsBetween(attempts);
    expect(first).toBeGreaterThanOrEqual(250);
    expect(first).toBeLessThan(750);
    expect(second).toBeGreaterThanOrEqual(500);
    expect(second).toBeLessThan(1500);
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

  /** Meta answers every call to `path` after `ms` of the frozen clock. */
  function answersAfter(method: string, path: string, ms: number, json: unknown) {
    meta.on(method, path, () => {
      vi.setSystemTime(Date.now() + ms);
      return { json };
    });
  }

  function batch(...ids: string[]) {
    const payload = commentPayload({ commentId: ids[0] });
    for (const id of ids.slice(1)) payload.entry[0]!.changes.push({ field: 'comments', value: commentValue({ commentId: id }) });
    return payload;
  }

  it('cuts a DM attempt to the time left, then records a public reply there is no time for as failed', async () => {
    const attempts = trackAttempts([]);
    answersAfter('POST', '/:id/messages', 9_000, { recipient_id: '1234567890', message_id: 'm1' });
    answersAfter('POST', '/:id/replies', 9_000, { id: '18000000000000001' });
    await seedAccount();
    await seedRule({ publicReply: 'Sent you a DM!' });

    await postWebhook(batch('first', 'second'));

    // The first comment's DM and reply use 18 s; the second's DM gets the 7 s
    // left, is answered after 9, and leaves no time for its reply.
    expect(attempts.map((a) => a.ms)).toEqual([10_000, 10_000, 7_000]);
    expect(meta.callsTo('POST', '/:id/replies')).toHaveLength(1);
    expect(await sentRow('first')).toMatchObject({ dm_status: 'ok', reply_status: 'ok', error: null });
    expect(await sentRow('second')).toMatchObject({ dm_status: 'ok', reply_status: 'failed', error: NO_TIME_FOR_PUBLIC_REPLY_ERROR });
  });

  it("records another rule's public reply as failed when the DM rule's own reply used up the time", async () => {
    meta.on('POST', '/:id/replies', () => {
      vi.setSystemTime(deadline - 1_000);
      return { json: { id: '18000000000000001' } };
    });
    await seedAccount();
    await seedRule({ publicReply: 'Sent you a DM!' });
    const other = await seedRule({ publicReply: 'From $20', replyWithoutDm: true });

    await withBackoffSkipped(postWebhook(commentPayload()));

    expect(meta.callsTo('POST', '/:id/replies').map((c) => c.body)).toEqual([{ message: 'Sent you a DM!' }]);
    expect(await sentRow('17900000000000001')).toMatchObject({ dm_status: 'ok', reply_status: 'ok', error: null });
    expect(await extraReplyRows()).toMatchObject([{ rule_id: other, status: 'failed', error: NO_TIME_FOR_PUBLIC_REPLY_ERROR }]);
  });

  it('shares the time across a batched delivery and claims no comment it has no time to send', async () => {
    const attempts = trackAttempts([0, 1, 2]);
    await seedAccount();
    await seedRule();

    await postWebhook(batch('batch-1', 'batch-2', 'batch-3', 'batch-4'));

    // Two full attempts, a third cut to the 5 s left, and no time for a fourth.
    expect(attempts.map((a) => a.ms)).toEqual([10_000, 10_000, 5_000]);
    for (const id of ['batch-1', 'batch-2', 'batch-3']) {
      const row = await sentRow(id);
      expect(row).toMatchObject({ dm_status: 'failed' });
      expect(row!.sent_at * 1000).toBeLessThanOrEqual(deadline);
    }
    expect((await sentRow('batch-3'))?.error).toMatch(/^DM: Instagram didn't answer within 5 seconds, so it may have been delivered\./);
    // Left unclaimed rather than failed, so the 5-minute poll can still send it.
    expect(await sentRow('batch-4')).toBeNull();
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
