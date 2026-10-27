import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { insertWebhookEvent, tryClaimComment } from '../src/db.ts';
import { DRAIN_BUDGET_MS, drainQueue } from '../src/queue.ts';
import { reconcileComments } from '../src/reconcile.ts';
import { Subrequests } from '../src/subrequests.ts';
import { FAKE_EXPIRES_IN, type MetaCall, meta } from './support/meta.ts';
import {
  ACCESS_TOKEN,
  DAY,
  FROZEN_NOW_MS,
  IG_USER,
  NOW,
  accountRow,
  extraReplyRows,
  seedAccount,
  seedRule,
  sentRows,
  storedToken,
  systemValue,
} from './support/seed.ts';
import { adminPath, commentPayload, commentValue, postWebhook, runScheduled, signedInAdmin } from './support/worker.ts';

const POLL = '* * * * *';
const DAILY = '0 3 * * *';

/** Instagram's own timestamp format, which has no colon in the offset. */
function igTime(unix: number): string {
  return new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, '+0000');
}

function comment(id: string, text: string, opts: { from?: string; at?: number; username?: string | null } = {}) {
  const from = { id: opts.from ?? '9100000000000001', ...(opts.username === null ? {} : { username: opts.username ?? 'a_fan' }) };
  return { id, text, timestamp: igTime(opts.at ?? NOW - 120), from };
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

describe('the comment poll, every fifth minute', () => {
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

  it('records an excluded comment as skipped, exactly as the webhook would, and never revisits it', async () => {
    await seedAccount();
    const ruleId = await seedRule({ keywords: ['guide'], excludeKeywords: ['how much'] });
    meta.on('GET', '/me/media', { json: { data: [{ id: 'm1' }] } });
    meta.on(
      'GET',
      '/:id/comments',
      commentsByMedia({ m1: [comment('c-price', 'how much is the guide?'), comment('c-guide', 'guide please'), comment('c-other', 'lovely')] }),
    );

    await runScheduled(POLL);

    expect(dmTargets()).toEqual(['c-guide']);
    expect(await sentRows()).toEqual([
      expect.objectContaining({ comment_id: 'c-guide', dm_status: 'ok', rule_id: ruleId }),
      expect.objectContaining({ comment_id: 'c-price', dm_status: 'skipped', rule_id: ruleId, error: 'Skipped: matched exclusion “how much”' }),
    ]);

    meta.clearCalls();
    await runScheduled(POLL);
    expect(dmTargets()).toEqual([]);
    expect(await sentRows()).toHaveLength(2);
  });

  it('lets another rule answer a comment one rule excludes, as the webhook does', async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'], mediaId: 'm1', excludeKeywords: ['how much'], dmText: 'reel guide' });
    const fallback = await seedRule({ keywords: ['guide'], dmText: 'price list' });
    meta.on('GET', '/:id/comments', commentsByMedia({ m1: [comment('c-price', 'how much is the guide?')] }));
    await runScheduled(POLL);
    expect(meta.callsTo('POST', '/:id/messages').map((c) => c.body)).toEqual([
      { recipient: { comment_id: 'c-price' }, message: { text: 'price list' } },
    ]);
    expect(await sentRows()).toEqual([expect.objectContaining({ dm_status: 'ok', rule_id: fallback })]);
  });

  it('answers recent comments on a match-all post, inside the lookback and the per-sweep cap', async () => {
    await seedAccount();
    await seedRule({ keywords: [], matchAll: true, mediaId: 'giveaway-reel' });
    meta.on(
      'GET',
      '/:id/comments',
      commentsByMedia({
        'giveaway-reel': [
          ...Array.from({ length: 11 }, (_, i) => comment(`c${String(i).padStart(2, '0')}`, `entry ${i}`)),
          comment('c-self', 'thanks everyone', { from: IG_USER }),
          comment('c-old', 'me too', { at: NOW - 73 * 60 * 60 }),
        ],
      }),
    );
    await runScheduled(POLL);
    expect(dmTargets()).toEqual(Array.from({ length: 10 }, (_, i) => `c${String(i).padStart(2, '0')}`));
    expect(meta.callsTo('GET', '/me/media')).toEqual([]);
  });

  const commentReads = () => meta.callsTo('GET', '/:id/comments').map((c) => c.path.split('/')[1]);

  it('takes turns when rules cover more than 3 posts, so a fourth post is read on the next sweep', async () => {
    await seedAccount();
    for (const post of ['p1', 'p2', 'p3', 'p4']) await seedRule({ keywords: [], matchAll: true, mediaId: post });
    meta.on('GET', '/:id/comments', commentsByMedia({ p4: [comment('c-on-p4', 'me please')] }));

    await runScheduled(POLL);
    expect(commentReads()).toEqual(['p1', 'p2', 'p3']);
    expect(dmTargets()).toEqual([]);

    meta.clearCalls();
    await runScheduled(POLL);
    expect(commentReads()).toEqual(['p4', 'p1', 'p2']);
    expect(dmTargets()).toEqual(['c-on-p4']);

    meta.clearCalls();
    await runScheduled(POLL);
    expect(commentReads()).toEqual(['p3', 'p4', 'p1']);
  });

  it('still reads the newest posts for an all-posts rule when 3 rules have posts of their own', async () => {
    await seedAccount();
    for (const post of ['s1', 's2', 's3']) await seedRule({ keywords: ['recipe'], mediaId: post });
    await seedRule({ keywords: ['guide'] });
    meta.on('GET', '/me/media', { json: { data: ['m1', 'm2', 'm3', 'm4'].map((id) => ({ id })) } });
    meta.on('GET', '/:id/comments', commentsByMedia({ m1: [comment('c-guide', 'guide please')] }));

    await runScheduled(POLL);
    expect(commentReads()).toEqual(['s1', 's2', 's3']);
    meta.clearCalls();
    await runScheduled(POLL);
    expect(commentReads()).toEqual(['m1', 'm2', 'm3']);
    expect(dmTargets()).toEqual(['c-guide']);
  });

  it('starts the next sweep at a post the 10-a-sweep cap cut short', async () => {
    await seedAccount();
    for (const post of ['p1', 'p2', 'p3', 'p4']) await seedRule({ keywords: [], matchAll: true, mediaId: post });
    meta.on('GET', '/:id/comments', commentsByMedia({ p1: Array.from({ length: 12 }, (_, i) => comment(`c${String(i)}`, 'me')) }));

    await runScheduled(POLL);
    expect(commentReads()).toEqual(['p1']);
    expect(dmTargets()).toHaveLength(10);

    meta.clearCalls();
    await runScheduled(POLL);
    expect(commentReads()).toEqual(['p1', 'p2', 'p3']);
    expect(dmTargets()).toEqual(['c10', 'c11']);
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

  it("answers a boosted post's ad comments, which Instagram lists under the post, once across webhook and poll", async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'], mediaId: 'post-1', dmText: 'reel guide' });
    // The webhook saw this one on the ad, with the ad's media id and the post as original_media_id.
    await postWebhook({
      object: 'instagram',
      entry: [{
        id: IG_USER,
        time: NOW,
        changes: [{
          field: 'comments',
          value: { ...commentValue({ commentId: 'c-ad-hooked', text: 'guide' }), media: { id: 'ad-media-1', ad_id: '120212345678900001', original_media_id: 'post-1' } },
        }],
      }],
    });
    // The post's listing carries comments on its ad as well, with nothing marking them as the ad's.
    meta.on('GET', '/:id/comments', commentsByMedia({ 'post-1': [comment('c-ad-hooked', 'guide'), comment('c-ad-missed', 'guide')] }));

    await runScheduled(POLL);

    expect(dmTargets()).toEqual(['c-ad-hooked', 'c-ad-missed']);
    expect((await sentRows()).map((r) => [r.comment_id, r.dm_status])).toEqual([
      ['c-ad-hooked', 'ok'],
      ['c-ad-missed', 'ok'],
    ]);
  });

  it("posts every matching rule's public reply once when the webhook and the poll take the same comment at once", async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'], publicReply: 'Reply 1' });
    const other = await seedRule({ keywords: ['guide'], publicReply: 'Reply 2', replyWithoutDm: true });
    meta.on('GET', '/me/media', { json: { data: [{ id: 'm1' }] } });
    meta.on('GET', '/:id/comments', commentsByMedia({ m1: [comment('c-both', 'guide')] }));

    await Promise.all([postWebhook(commentPayload({ commentId: 'c-both', text: 'guide', mediaId: 'm1' })), runScheduled(POLL)]);

    expect(dmTargets()).toEqual(['c-both']);
    expect(meta.callsTo('POST', '/:id/replies').map((c) => c.body)).toEqual([{ message: 'Reply 1' }, { message: 'Reply 2' }]);
    expect(await extraReplyRows()).toMatchObject([{ comment_id: 'c-both', rule_id: other, status: 'ok' }]);
  });

  it('puts the username from the comment listing into the DM and public reply', async () => {
    await seedAccount();
    await seedRule({ dmText: 'Hi {username}, here you go', publicReply: 'Sent, {username}!' });
    meta.on('GET', '/me/media', { json: { data: [{ id: 'm1' }] } });
    meta.on(
      'GET',
      '/:id/comments',
      commentsByMedia({ m1: [comment('c-named', 'guide', { username: 'polled_fan' }), comment('c-anon', 'guide', { username: null })] }),
    );

    await runScheduled(POLL);

    expect(meta.callsTo('POST', '/:id/messages').map((c) => c.body)).toEqual([
      { recipient: { comment_id: 'c-named' }, message: { text: 'Hi polled_fan, here you go' } },
      { recipient: { comment_id: 'c-anon' }, message: { text: 'Hi, here you go' } },
    ]);
    expect(meta.callsTo('POST', '/:id/replies').map((c) => [c.path, c.body])).toEqual([
      ['/c-named/replies', { message: 'Sent, polled_fan!' }],
      ['/c-anon/replies', { message: 'Sent!' }],
    ]);
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

  it('does not answer, once the account is resumed, comments that arrived while it was paused', async () => {
    await seedAccount({ active: false });
    await seedRule({ keywords: ['guide'] });
    await postWebhook(commentPayload({ commentId: 'c-while-paused', text: 'guide' }));

    await env.DB.prepare('UPDATE accounts SET active = 1 WHERE ig_user_id = ?').bind(IG_USER).run();
    meta.on('GET', '/me/media', { json: { data: [{ id: 'm1' }] } });
    meta.on('GET', '/:id/comments', commentsByMedia({ m1: [comment('c-while-paused', 'guide'), comment('c-after', 'guide')] }));
    await runScheduled(POLL);

    expect(dmTargets()).toEqual(['c-after']);
    expect((await sentRows()).map((r) => [r.comment_id, r.dm_status, r.error])).toEqual([
      ['c-after', 'ok', null],
      ['c-while-paused', 'skipped', 'account paused'],
    ]);
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

  it('counts only the comments it queues towards the 10, not ones the webhook claimed first', async () => {
    await seedAccount();
    await seedRule();
    // The webhook claims c0 to c9 after the sweep has checked which comments
    // it already has, and before the sweep writes their rows. The DB below
    // stands in for that timing: its check always answers "none".
    for (let i = 0; i < 10; i++) {
      await tryClaimComment(env.DB, { comment_id: `c${i}`, ig_user_id: IG_USER, commenter_id: null, dm_status: 'ok', error: null, sent_at: NOW });
    }
    const racing = {
      prepare: (sql: string) =>
        env.DB.prepare(sql.startsWith('SELECT comment_id FROM sent WHERE comment_id IN') ? 'SELECT comment_id FROM sent WHERE 0 AND ? IS NOT NULL' : sql),
      batch: (s: D1PreparedStatement[]) => env.DB.batch(s),
      exec: (sql: string) => env.DB.exec(sql),
    } as unknown as D1Database;
    meta.on('GET', '/me/media', { json: { data: [{ id: 'm1' }] } });
    meta.on('GET', '/:id/comments', commentsByMedia({ m1: Array.from({ length: 12 }, (_, i) => comment(`c${i}`, 'guide')) }));

    await reconcileComments({ ...env, DB: racing }, new Subrequests());
    await drainQueue(env, new Subrequests());

    expect(dmTargets()).toEqual(['c10', 'c11']);
  });

  it('stops starting sends once the minute has used its time, and puts the rest back in the queue', async () => {
    await seedAccount();
    await seedRule();
    meta.on('GET', '/me/media', { json: { data: [{ id: 'm1' }] } });
    meta.on(
      'GET',
      '/:id/comments',
      commentsByMedia({ m1: [comment('c1', 'guide', { at: NOW - 300 }), comment('c2', 'guide please', { at: NOW - 200 }), comment('c3', 'guide?', { at: NOW - 100 })] }),
    );
    // Stands in for a minute slowed down by Instagram: the first DM leaves it
    // a second short of its budget, too little to start another send.
    meta.on('POST', '/:id/messages', () => {
      vi.setSystemTime(FROZEN_NOW_MS + DRAIN_BUDGET_MS - 1_000);
      return { json: { recipient_id: '1234567890', message_id: 'm1' } };
    });

    await runScheduled(POLL);

    expect(dmTargets()).toEqual(['c1']);
    expect((await sentRows()).map((r) => [r.comment_id, r.dm_status])).toEqual([
      ['c1', 'ok'],
      ['c2', 'queued'],
      ['c3', 'queued'],
    ]);
    expect(await systemValue('last_poll_ok_at')).not.toBeNull();

    meta.on('POST', '/:id/messages', { json: { recipient_id: '1234567890', message_id: 'm2' } });
    meta.clearCalls();
    vi.setSystemTime(FROZEN_NOW_MS + 60 * 1000);
    await runScheduled(POLL);

    expect(dmTargets()).toEqual(['c2', 'c3']);
    expect(meta.callsTo('GET', '/:id/comments')).toEqual([]);
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

  it('marks sends the Worker never finished as possibly delivered, without sending them again', async () => {
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
      ['c-stuck', 'unsure', stopped, NOW - 2 * DAY],
      ['c-stuck-recently', 'unsure', stopped, NOW - 16 * 60],
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
