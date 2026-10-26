import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { insertWebhookEvent, tryClaimComment } from '../src/db.ts';
import { FAKE_EXPIRES_IN, type MetaCall, meta } from './support/meta.ts';
import {
  ACCESS_TOKEN,
  DAY,
  IG_USER,
  NOW,
  accountRow,
  seedAccount,
  seedRule,
  sentRows,
  storedToken,
  systemValue,
} from './support/seed.ts';
import { adminPath, runScheduled, signedInAdmin } from './support/worker.ts';

const POLL = '*/5 * * * *';
const DAILY = '0 3 * * *';

/** Instagram's own timestamp format, which has no colon in the offset. */
function igTime(unix: number): string {
  return new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, '+0000');
}

function comment(id: string, text: string, opts: { from?: string; at?: number } = {}) {
  return { id, text, timestamp: igTime(opts.at ?? NOW - 120), from: { id: opts.from ?? '9100000000000001', username: 'a_fan' } };
}

function commentsByMedia(byMedia: Record<string, unknown[] | { status: number }>) {
  return (call: MetaCall) => {
    const mediaId = call.path.split('/')[1]!;
    const entry = byMedia[mediaId] ?? [];
    return Array.isArray(entry) ? { json: { data: entry } } : { status: entry.status, json: { error: { message: 'Unsupported get request' } } };
  };
}

const dmTargets = () =>
  meta.callsTo('POST', '/:id/messages').map((c) => (c.body as { recipient: { comment_id: string } }).recipient.comment_id);

describe('the 5-minute comment poll', () => {
  it('DMs matching comments the webhook missed, on scoped posts first, then recent ones', async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'], dmText: 'guide link' });
    await seedRule({ keywords: ['recipe'], mediaId: 'scoped-media', dmText: 'recipe link' });
    await tryClaimComment(env.DB, { comment_id: 'c-done', ig_user_id: IG_USER, commenter_id: null, dm_status: 'ok', error: null, sent_at: NOW - 600 });
    meta.on('GET', '/me/media', { json: { data: ['m1', 'm2', 'm3', 'm4'].map((id) => ({ id, caption: id, permalink: '' })) } });
    meta.on(
      'GET',
      '/:id/comments',
      commentsByMedia({
        'scoped-media': [comment('c-recipe', 'Recipe please')],
        m1: [
          comment('c-guide', 'guide!'),
          comment('c-self', 'guide', { from: IG_USER }),
          comment('c-nomatch', 'lovely'),
          comment('c-old', 'guide', { at: NOW - 73 * 60 * 60 }),
          comment('c-done', 'guide'),
        ],
      }),
    );

    await runScheduled(POLL);

    expect(meta.callsTo('GET', '/:id/comments').map((c) => c.path)).toEqual(['/scoped-media/comments', '/m1/comments', '/m2/comments']);
    expect(meta.callsTo('GET', '/:id/comments')[0]).toMatchObject({
      authorization: `Bearer ${ACCESS_TOKEN}`,
      query: { fields: 'id,text,timestamp,from', order: 'reverse_chronological', limit: '25' },
    });
    expect(dmTargets()).toEqual(['c-recipe', 'c-guide']);
    expect(meta.callsTo('POST', '/:id/messages')[0]!.body).toEqual({ recipient: { comment_id: 'c-recipe' }, message: { text: 'recipe link' } });
    expect((await sentRows()).map((r) => [r.comment_id, r.dm_status])).toEqual([
      ['c-done', 'ok'],
      ['c-guide', 'ok'],
      ['c-recipe', 'ok'],
    ]);
    expect(await systemValue('last_poll_ok_at')).toBe(String(NOW));
  });

  it('matches each rule the way it is set to, as the webhook does', async () => {
    await seedAccount();
    await seedRule({ keywords: ['launch'], matchMode: 'contains' });
    await seedRule({ keywords: ['guide'], matchMode: 'word' });
    meta.on('GET', '/me/media', { json: { data: [{ id: 'm1' }] } });
    meta.on('GET', '/:id/comments', commentsByMedia({ m1: [comment('c-tag', '#launch2026'), comment('c-plural', 'guides?')] }));
    await runScheduled(POLL);
    expect(dmTargets()).toEqual(['c-tag']);
    expect((await sentRows()).map((r) => r.comment_id)).toEqual(['c-tag']);
  });

  it('does not DM a comment the webhook already handled', async () => {
    await seedAccount();
    await seedRule();
    meta.on('GET', '/me/media', { json: { data: [{ id: 'm1' }] } });
    meta.on('GET', '/:id/comments', commentsByMedia({ m1: [comment('c1', 'guide')] }));
    await runScheduled(POLL);
    await runScheduled(POLL);
    expect(dmTargets()).toEqual(['c1']);
  });

  it('skips accounts with no active rules without calling Instagram', async () => {
    await seedAccount();
    await seedRule({ active: false });
    await runScheduled(POLL);
    expect(meta.calls).toEqual([]);
    expect(await systemValue('last_poll_ok_at')).toBe(String(NOW));
  });

  it('skips paused accounts', async () => {
    await seedAccount({ active: false });
    await seedRule();
    await runScheduled(POLL);
    expect(meta.calls).toEqual([]);
  });

  it('carries on past a post whose comments cannot be listed', async () => {
    await seedAccount();
    await seedRule();
    meta.on('GET', '/me/media', { json: { data: [{ id: 'm1' }, { id: 'm2' }] } });
    meta.on('GET', '/:id/comments', commentsByMedia({ m1: { status: 400 }, m2: [comment('c2', 'guide')] }));
    await runScheduled(POLL);
    expect(dmTargets()).toEqual(['c2']);
  });

  it('sends at most 10 DMs per sweep', async () => {
    await seedAccount();
    await seedRule();
    meta.on('GET', '/me/media', { json: { data: [{ id: 'm1' }] } });
    meta.on('GET', '/:id/comments', commentsByMedia({ m1: Array.from({ length: 12 }, (_, i) => comment(`c${i}`, 'guide')) }));
    await runScheduled(POLL);
    expect(dmTargets()).toHaveLength(10);
  });

  it('does not refresh tokens or touch subscriptions', async () => {
    await seedAccount({ expiresAt: NOW + 2 * DAY, lastRefreshedAt: NOW - 50 * DAY });
    await runScheduled(POLL);
    expect(meta.calls).toEqual([]);
    expect(await systemValue('last_cron_ok_at')).toBeNull();
  });
});

describe('the daily token refresh', () => {
  it('re-subscribes every active account to comment webhooks and records a clean run', async () => {
    await seedAccount({ igUserId: '17841400000000001', token: 'token-one' });
    await seedAccount({ igUserId: '17841400000000002', token: 'token-two' });
    await seedAccount({ igUserId: '17841400000000003', token: 'token-paused', active: false });

    await runScheduled(DAILY);

    expect(meta.callsTo('POST', '/:id/subscribed_apps')).toEqual([
      expect.objectContaining({ path: '/17841400000000001/subscribed_apps', authorization: 'Bearer token-one', body: { subscribed_fields: ['comments'] } }),
      expect.objectContaining({ path: '/17841400000000002/subscribed_apps', authorization: 'Bearer token-two', body: { subscribed_fields: ['comments'] } }),
    ]);
    expect(await systemValue('last_cron_ok_at')).toBe(String(NOW));
  });

  it('refreshes a token expiring within 10 days and stores the new one encrypted', async () => {
    await seedAccount({ expiresAt: NOW + 5 * DAY, lastRefreshedAt: NOW - 55 * DAY });

    await runScheduled(DAILY);

    expect(meta.callsTo('GET', '/refresh_access_token')).toEqual([
      expect.objectContaining({ host: 'graph.instagram.com', query: { grant_type: 'ig_refresh_token', access_token: ACCESS_TOKEN } }),
    ]);
    expect(await storedToken()).toBe('refreshed-token');
    expect(await accountRow()).toMatchObject({ token_expires_at: NOW + FAKE_EXPIRES_IN, last_refreshed_at: NOW, needs_reconnect: 0 });
    expect((await accountRow())?.access_token_enc).not.toContain('refreshed-token');
  });

  it('leaves alone tokens that are not near expiry or were refreshed in the last day', async () => {
    await seedAccount({ igUserId: '17841400000000001', expiresAt: NOW + 30 * DAY });
    await seedAccount({ igUserId: '17841400000000002', expiresAt: NOW + 5 * DAY, lastRefreshedAt: NOW - 60 * 60 });
    await runScheduled(DAILY);
    expect(meta.callsTo('GET', '/refresh_access_token')).toEqual([]);
  });

  it('flags the account for reconnect when refresh fails with under 14 days left', async () => {
    await seedAccount({ expiresAt: NOW + 5 * DAY, lastRefreshedAt: NOW - 55 * DAY });
    meta.on('GET', '/refresh_access_token', { status: 400, json: { error: { message: 'Session has expired', code: 190 } } });

    await runScheduled(DAILY);

    expect(await accountRow()).toMatchObject({ needs_reconnect: 1, token_expires_at: NOW + 5 * DAY });
    expect(await storedToken()).toBe(ACCESS_TOKEN);
    expect(await systemValue('last_cron_ok_at')).toBe(String(NOW));

    const admin = await signedInAdmin();
    expect((await admin.get(adminPath('/'))).text).toContain('Instagram needs reconnecting');
  });

  it('refreshes a paused account too, since pausing stops DMs and not token upkeep', async () => {
    await seedAccount({ token: 'token-paused', expiresAt: NOW + 5 * DAY, lastRefreshedAt: NOW - 55 * DAY, active: false });

    await runScheduled(DAILY);

    expect(meta.callsTo('GET', '/refresh_access_token')).toEqual([expect.objectContaining({ query: expect.objectContaining({ access_token: 'token-paused' }) })]);
    expect(meta.callsTo('POST', '/:id/subscribed_apps')).toEqual([]);
    expect(await storedToken()).toBe('refreshed-token');
    expect(await accountRow()).toMatchObject({ active: 0, token_expires_at: NOW + FAKE_EXPIRES_IN, last_refreshed_at: NOW });
  });

  it('marks sends the Worker never finished as failed, without sending them again', async () => {
    await seedAccount();
    await seedRule();
    const claim = (comment_id: string, dm_status: string, sent_at: number) =>
      tryClaimComment(env.DB, { comment_id, ig_user_id: IG_USER, commenter_id: '9100000000000001', dm_status, error: null, sent_at });
    await claim('c-stuck', 'pending', NOW - 2 * DAY);
    await claim('c-stuck-recently', 'pending', NOW - 16 * 60);
    await claim('c-in-flight', 'pending', NOW - 60);
    await claim('c-sent', 'ok', NOW - 2 * DAY);

    await runScheduled(DAILY);

    const stopped = 'The Worker stopped before this send finished. The DM may or may not have gone out, so it was not tried again.';
    expect((await sentRows()).map((r) => [r.comment_id, r.dm_status, r.error, r.sent_at])).toEqual([
      ['c-in-flight', 'pending', null, NOW - 60],
      ['c-sent', 'ok', null, NOW - 2 * DAY],
      ['c-stuck', 'failed', stopped, NOW - 2 * DAY],
      ['c-stuck-recently', 'failed', stopped, NOW - 16 * 60],
    ]);
    expect(meta.callsTo('POST', '/:id/messages')).toEqual([]);
    expect(meta.callsTo('POST', '/:id/replies')).toEqual([]);
  });

  it('prunes webhook events older than 7 days', async () => {
    await insertWebhookEvent(env.DB, { received_at: NOW - 8 * DAY, status: 'received', object: 'instagram', preview: 'old', error: null });
    await insertWebhookEvent(env.DB, { received_at: NOW - 1 * DAY, status: 'received', object: 'instagram', preview: 'new', error: null });
    await runScheduled(DAILY);
    const { results } = await env.DB.prepare('SELECT preview FROM webhook_events').all<{ preview: string }>();
    expect(results).toEqual([{ preview: 'new' }]);
  });

  it('runs from the admin "Check connections now" button too', async () => {
    await seedAccount();
    const admin = await signedInAdmin();
    await admin.get(adminPath('/'));
    meta.clearCalls();
    const res = await admin.submit(adminPath('/run-cron'));
    expect(res.status).toBe(302);
    expect(meta.callsTo('POST', '/:id/subscribed_apps')).toHaveLength(1);
    expect(await systemValue('last_cron_ok_at')).toBe(String(NOW));
  });

  it('never polls comments', async () => {
    await seedAccount();
    await seedRule();
    await runScheduled(DAILY);
    expect(meta.callsTo('GET', '/:id/comments')).toEqual([]);
    expect(await sentRows()).toEqual([]);
  });
});
