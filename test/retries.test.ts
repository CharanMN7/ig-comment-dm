import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { readTotalsSnapshot, retryUnsureSend } from '../src/db.ts';
import { MAX_ATTEMPTS, PAUSE_SECONDS, TOKEN_WAIT_NOTE } from '../src/queue.ts';
import { type MetaReply, meta } from './support/meta.ts';
import { FROZEN_NOW_MS, IG_USER, NOW, accountRow, seedAccount, seedQueued, seedRule, sentRow } from './support/seed.ts';
import { MINUTE_CRON, adminPath, commentPayload, postWebhook, runScheduled, signedInAdmin } from './support/worker.ts';

const dmCalls = () => meta.callsTo('POST', '/:id/messages');

function at(seconds: number): void {
  vi.setSystemTime(FROZEN_NOW_MS + seconds * 1000);
}

async function pausedUntil(): Promise<number> {
  const row = await env.DB.prepare('SELECT paused_until FROM send_budget WHERE ig_user_id = ?').bind(IG_USER).first<{ paused_until: number }>();
  return row?.paused_until ?? 0;
}

const refusal = (status: number, code: number, subcode?: number): MetaReply => ({
  status,
  json: { error: { message: 'refused', type: 'IGApiException', code, ...(subcode ? { error_subcode: subcode } : {}) } },
});

/** One queued comment, sent by the minute job at the frozen time. */
async function queuedAndDrained(answer: MetaReply) {
  await seedAccount();
  const ruleId = await seedRule();
  await seedQueued({ commentId: 'c1', ruleId });
  meta.on('POST', '/:id/messages', answer);
  await runScheduled(MINUTE_CRON);
  return sentRow('c1');
}

describe('a DM Instagram turns down for now', () => {
  it.each([
    ['HTTP 429', refusal(429, 4)],
    ['code 4, the app’s rate limit', refusal(400, 4)],
    ['code 17, the account’s rate limit', refusal(400, 17)],
    ['code 32', refusal(400, 32)],
    ['code 613, too many calls in an hour', refusal(400, 613)],
    ['code 80002, Instagram’s business-use-case limit', refusal(400, 80002)],
    ['code 80006, Messenger’s business-use-case limit', refusal(400, 80006)],
  ])('waits a minute and holds the account for 15 after %s', async (_, answer) => {
    const row = await queuedAndDrained(answer);
    expect(dmCalls()).toHaveLength(1);
    expect(row).toMatchObject({ dm_status: 'retry', attempts: 1, next_attempt_at: NOW + 60 });
    expect(await pausedUntil()).toBe(NOW + PAUSE_SECONDS);
  });

  it('tries Instagram’s temporary error again after 1, 5 and 20 minutes, then gives up on the fourth', async () => {
    const row = await queuedAndDrained(refusal(400, 2));
    expect(row).toMatchObject({ dm_status: 'retry', attempts: 1, next_attempt_at: NOW + 60 });
    expect(await pausedUntil()).toBe(0);

    at(30);
    await runScheduled(MINUTE_CRON);
    expect(dmCalls()).toHaveLength(1);

    at(60);
    await runScheduled(MINUTE_CRON);
    expect(await sentRow('c1')).toMatchObject({ dm_status: 'retry', attempts: 2, next_attempt_at: NOW + 60 + 5 * 60 });

    at(60 + 5 * 60);
    await runScheduled(MINUTE_CRON);
    expect(await sentRow('c1')).toMatchObject({ dm_status: 'retry', attempts: 3, next_attempt_at: NOW + 6 * 60 + 20 * 60 });

    at(26 * 60);
    await runScheduled(MINUTE_CRON);
    const last = await sentRow('c1');
    expect(dmCalls()).toHaveLength(MAX_ATTEMPTS);
    expect(last).toMatchObject({ dm_status: 'failed', attempts: 4, next_attempt_at: null });
    expect(last?.error).toMatch(/^DM: Instagram turned it down 4 times, so it was given up on\./);

    at(60 * 60);
    await runScheduled(MINUTE_CRON);
    expect(dmCalls()).toHaveLength(MAX_ATTEMPTS);
  });

  it('tries again any error Instagram marks as transient', async () => {
    const row = await queuedAndDrained({ status: 400, json: { error: { message: 'try later', code: 1, is_transient: true } } });
    expect(row).toMatchObject({ dm_status: 'retry', attempts: 1, next_attempt_at: NOW + 60 });
    expect(await pausedUntil()).toBe(0);
  });

  it('sends a retried DM once it succeeds, with the public reply after it', async () => {
    await seedAccount();
    const ruleId = await seedRule({ publicReply: 'Sent!' });
    await seedQueued({ commentId: 'c1', ruleId });
    let calls = 0;
    meta.on('POST', '/:id/messages', () => (calls++ === 0 ? refusal(400, 2) : { json: { recipient_id: '1', message_id: 'm1' } }));
    await runScheduled(MINUTE_CRON);
    expect(meta.callsTo('POST', '/:id/replies')).toEqual([]);

    at(60);
    await runScheduled(MINUTE_CRON);
    expect(await sentRow('c1')).toMatchObject({ dm_status: 'ok', reply_status: 'ok', attempts: 2, error: null });
    expect(meta.callsTo('POST', '/:id/replies')).toHaveLength(1);
  });

  it('stops the account’s other sends for the minute when Instagram says it’s sending too fast', async () => {
    await seedAccount();
    const ruleId = await seedRule();
    for (let i = 0; i < 4; i++) await seedQueued({ commentId: `q${i}`, ruleId, commentAt: NOW - 600 + i });
    meta.on('POST', '/:id/messages', refusal(429, 613));

    await runScheduled(MINUTE_CRON);

    expect(dmCalls()).toHaveLength(1);
    expect(await sentRow('q1')).toMatchObject({ dm_status: 'queued', attempts: 0 });

    // Held for 15 minutes, webhooks included.
    at(5 * 60);
    meta.on('POST', '/:id/messages', { json: { recipient_id: '1', message_id: 'm' } });
    await runScheduled(MINUTE_CRON);
    await postWebhook(commentPayload({ commentId: 'fresh' }));
    expect(dmCalls()).toHaveLength(1);
    expect(await sentRow('fresh')).toMatchObject({ dm_status: 'queued' });

    at(PAUSE_SECONDS);
    await runScheduled(MINUTE_CRON);
    expect(dmCalls().length).toBeGreaterThan(1);
  });
});

describe('a DM Instagram turns down for good', () => {
  it.each([
    ['already answered (subcode 2534025)', refusal(400, 100, 2534025)],
    ['the 7-day window closed (code 10, subcode 2534022)', refusal(400, 10, 2534022)],
    ['the user is unavailable (code 551)', refusal(400, 551)],
    ['a privacy block (code 200, subcode 1545041)', refusal(403, 200, 1545041)],
    ['any other 4xx', refusal(400, 100)],
    ['already answered, even dressed as a rate limit', refusal(429, 4, 2534025)],
  ])('fails it and never tries again when %s', async (_, answer) => {
    const row = await queuedAndDrained(answer);
    expect(row).toMatchObject({ dm_status: 'failed', attempts: 1, next_attempt_at: null });
    at(60 * 60);
    await runScheduled(MINUTE_CRON);
    expect(dmCalls()).toHaveLength(1);
  });
});

describe('a DM whose token stopped working', () => {
  it('stays queued without using a try, flags the account for reconnecting, and goes out once it is', async () => {
    await seedAccount();
    const ruleId = await seedRule();
    await seedQueued({ commentId: 'c1', ruleId, commentAt: NOW - 600 });
    await seedQueued({ commentId: 'c2', ruleId, commentAt: NOW - 300 });
    meta.on('POST', '/:id/messages', refusal(400, 190));

    await runScheduled(MINUTE_CRON);

    expect(dmCalls()).toHaveLength(1);
    const row = await sentRow('c1');
    expect(row).toMatchObject({ dm_status: 'queued', attempts: 0, next_attempt_at: NOW - 600 });
    expect(row?.error).toContain(TOKEN_WAIT_NOTE);
    expect(await sentRow('c2')).toMatchObject({ dm_status: 'queued' });
    expect(await accountRow()).toMatchObject({ needs_reconnect: 1 });

    at(2 * 60);
    await runScheduled(MINUTE_CRON);
    expect(dmCalls()).toHaveLength(1);

    // Reconnecting saves a new token and lifts the hold.
    meta.on('POST', '/:id/messages', { json: { recipient_id: '1', message_id: 'm' } });
    await seedAccount({ token: 'fresh-token' });
    at(3 * 60);
    await runScheduled(MINUTE_CRON);
    expect(dmCalls().slice(1).map((c) => c.authorization)).toEqual(['Bearer fresh-token', 'Bearer fresh-token']);
    expect(await sentRow('c1')).toMatchObject({ dm_status: 'ok', attempts: 1 });
  });
});

describe('a DM Instagram never confirmed', () => {
  async function unsureFromWebhook() {
    await seedAccount();
    await seedRule({ publicReply: 'Sent!' });
    meta.on('POST', '/:id/messages', { status: 503, json: {} });
    await postWebhook(commentPayload({ commentId: 'c1' }));
    meta.on('POST', '/:id/messages', { json: { recipient_id: '1', message_id: 'm' } });
  }

  it('is never sent again by itself', async () => {
    await unsureFromWebhook();
    expect(await sentRow('c1')).toMatchObject({ dm_status: 'unsure', attempts: 1 });
    at(60 * 60);
    await runScheduled(MINUTE_CRON);
    expect(dmCalls()).toHaveLength(1);
  });

  it('shows on Home as possibly delivered, and Send again queues it once', async () => {
    await unsureFromWebhook();
    const admin = await signedInAdmin();
    const home = (await admin.get(adminPath('/'))).text;
    expect(home).toContain('May have been delivered');
    expect(home).toContain('Instagram didn’t confirm it.');
    expect(home).toContain(`action="${adminPath('/sends/c1/retry')}"`);

    const res = await admin.submit(adminPath('/sends/c1/retry'));
    expect(res.status).toBe(302);
    expect(res.location).toContain('done=send-requeued');
    expect(await sentRow('c1')).toMatchObject({ dm_status: 'retry', attempts: 0, sent_at: NOW, error: null, reply_status: null });
    const again = await admin.submit(adminPath('/sends/c1/retry'));
    expect(again.location).toContain('done=send-unchanged');

    await runScheduled(MINUTE_CRON);
    expect(dmCalls()).toHaveLength(2);
    expect(await sentRow('c1')).toMatchObject({ dm_status: 'ok', reply_status: 'ok', attempts: 1 });
  });

  it('gets four fresh tries from Send again, so one rate limit doesn’t end it', async () => {
    await seedAccount();
    const ruleId = await seedRule();
    await seedQueued({ commentId: 'c1', ruleId });
    await env.DB.prepare("UPDATE sent SET dm_status = 'unsure', attempts = 4, next_attempt_at = NULL").run();
    expect(await retryUnsureSend(env.DB, 'c1', NOW)).toBe(true);
    meta.on('POST', '/:id/messages', refusal(429, 4));
    await runScheduled(MINUTE_CRON);
    expect(await sentRow('c1')).toMatchObject({ dm_status: 'retry', attempts: 1 });
    const text = (await (await signedInAdmin()).get(adminPath('/'))).text;
    expect(text).toContain('Try 2 of 4');
  });

  it('takes a retried send off the failed count it was in, once, and counts it as sent when it goes', async () => {
    await unsureFromWebhook();
    // The daily job's snapshot, a day later, counts the unsure DM as failed.
    at(24 * 60 * 60);
    await runScheduled('0 3 * * *');
    expect((await readTotalsSnapshot(env.DB))?.all).toMatchObject({ sent: 0, failed: 1 });

    const admin = await signedInAdmin();
    await admin.get(adminPath('/'));
    await admin.submit(adminPath('/sends/c1/retry'));
    await admin.get(adminPath('/'));
    await admin.submit(adminPath('/sends/c1/retry'));
    expect((await readTotalsSnapshot(env.DB))?.all).toMatchObject({ sent: 0, failed: 0 });
    expect((await readTotalsSnapshot(env.DB))?.accounts[IG_USER]).toMatchObject({ failed: 0 });

    await runScheduled(MINUTE_CRON);
    expect(await sentRow('c1')).toMatchObject({ dm_status: 'ok' });
    const text = (await admin.get(adminPath('/'))).text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain('All time 1 person reached 1 DM sent 0 skipped 0 failed');
  });

  it('needs the CSRF token to be sent again, and leaves a send that isn’t unsure alone', async () => {
    await unsureFromWebhook();
    await postWebhook(commentPayload({ commentId: 'c2' }));
    const admin = await signedInAdmin();
    await admin.get(adminPath('/'));
    expect((await admin.post(adminPath('/sends/c1/retry'), {})).status).toBe(403);
    expect(await sentRow('c1')).toMatchObject({ dm_status: 'unsure' });
    await admin.get(adminPath('/'));
    await admin.submit(adminPath('/sends/c2/retry'));
    expect(await sentRow('c2')).toMatchObject({ dm_status: 'ok' });
  });
});

describe('reconnecting', () => {
  it('lifts a dead token’s hold but keeps a rate limit’s', async () => {
    await seedAccount();
    const ruleId = await seedRule();
    await seedQueued({ commentId: 'c1', ruleId });
    await env.DB.prepare('INSERT INTO send_budget (ig_user_id, minute, used, paused_until, token_held_until) VALUES (?, 0, 0, ?, ?)')
      .bind(IG_USER, NOW + 600, NOW + 900)
      .run();

    await seedAccount({ token: 'fresh-token' });

    expect(await env.DB.prepare('SELECT paused_until, token_held_until FROM send_budget').first()).toEqual({ paused_until: NOW + 600, token_held_until: 0 });
    await runScheduled(MINUTE_CRON);
    expect(dmCalls()).toEqual([]);
    at(600);
    await runScheduled(MINUTE_CRON);
    expect(dmCalls()).toHaveLength(1);
  });
});

describe('the Accounts page', () => {
  it('says how many waiting DMs pausing an account will skip', async () => {
    await seedAccount();
    const ruleId = await seedRule();
    for (let i = 0; i < 3; i++) await seedQueued({ commentId: `q${i}`, ruleId });
    const text = (await (await signedInAdmin()).get(adminPath('/accounts'))).text.replace(/\s+/g, ' ');
    expect(text).toContain('Pausing skips its 3 waiting DMs: they aren’t sent after you resume.');
  });
});

describe('Home', () => {
  it('shows what’s waiting, the last hour against the limit, and a note while Instagram holds the account', async () => {
    await seedAccount();
    const ruleId = await seedRule();
    for (let i = 0; i < 12; i++) await postWebhook(commentPayload({ commentId: `sent-${i}` }));
    for (let i = 0; i < 20; i++) await seedQueued({ commentId: `q${i}`, ruleId, commentAt: NOW - 30 * 60 });
    meta.on('POST', '/:id/messages', refusal(429, 4));
    at(60);
    await runScheduled(MINUTE_CRON);

    const text = (await (await signedInAdmin()).get(adminPath('/'))).text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    expect(text).toContain('Sending');
    expect(text).toContain('@creator 19 queued, 1 to try again. Oldest comment 31 minutes old.');
    expect(text).toContain('13 DMs');
    expect(text).toContain('about 12 each right now');
    expect(text).toMatch(/Instagram asked @creator to slow down, so its DMs wait until 2026-10-01 12:16 UTC/);
    expect(text).toMatch(/Retrying .*Instagram turned it down for now\. Try 2 of 4 at 2026-10-01 12:02 UTC\./);
  });

  it('labels a comment that waited too long as expired', async () => {
    await seedAccount();
    const ruleId = await seedRule();
    await seedQueued({ commentId: 'old', ruleId, commentAt: NOW - 7 * 24 * 60 * 60 + 30 * 60 });
    await runScheduled(MINUTE_CRON);
    const text = (await (await signedInAdmin()).get(adminPath('/'))).text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toMatch(/Expired Expired: the DM was still waiting/);
  });
});
