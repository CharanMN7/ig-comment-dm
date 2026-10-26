import { beforeEach, describe, expect, it, vi } from 'vitest';
import { meta, type MetaReply } from './support/meta.ts';
import { FROZEN_NOW_MS, seedAccount, seedRule, sentRow } from './support/seed.ts';
import { commentPayload, postWebhook } from './support/worker.ts';

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

  // Known bug: a network error on every attempt makes fetchWithRetry throw, and
  // processComment has no catch around the send, so the claimed row is left
  // `pending` forever. Dedupe then blocks any retry and Home shows
  // "In progress" for good. When that is fixed, drop `.fails`.
  it.fails('records a send that never reaches Meta as failed rather than leaving it pending', async () => {
    meta.on('POST', '/:id/messages', { networkError: true });
    const row = await deliverMatchingComment();
    expect(meta.callsTo('POST', '/:id/messages')).toHaveLength(3);
    expect(row).toMatchObject({ dm_status: 'failed' });
  });
});
