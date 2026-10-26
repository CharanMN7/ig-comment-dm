import { describe, expect, it } from 'vitest';
import { meta } from './support/meta.ts';
import { ACCESS_TOKEN, DAY, IG_USER, NOW, seedAccount, seedRule, sentRow, sentRows } from './support/seed.ts';
import { commentPayload, commentValue, postWebhook } from './support/worker.ts';

const dmCalls = () => meta.callsTo('POST', '/:id/messages');
const replyCalls = () => meta.callsTo('POST', '/:id/replies');

describe('a comment that matches an active rule', () => {
  it('sends one private reply to the comment, posts the public reply, and records both', async () => {
    await seedAccount();
    const ruleId = await seedRule({
      keywords: ['guide', 'freebie'],
      dmText: 'Here is the guide: https://example.com/g',
      publicReply: 'Sent you a DM!',
    });

    const res = await postWebhook(commentPayload({ commentId: '17900000000000042', fromId: '9100000000000007', text: 'GUIDE please 🙏' }));

    expect(res.status).toBe(200);
    expect(dmCalls()).toEqual([
      expect.objectContaining({
        host: 'graph.instagram.com',
        path: `/${IG_USER}/messages`,
        authorization: `Bearer ${ACCESS_TOKEN}`,
        body: { recipient: { comment_id: '17900000000000042' }, message: { text: 'Here is the guide: https://example.com/g' } },
      }),
    ]);
    expect(replyCalls()).toEqual([
      expect.objectContaining({
        path: '/17900000000000042/replies',
        authorization: `Bearer ${ACCESS_TOKEN}`,
        body: { message: 'Sent you a DM!' },
      }),
    ]);
    expect(await sentRow('17900000000000042')).toMatchObject({
      comment_id: '17900000000000042',
      ig_user_id: IG_USER,
      rule_id: ruleId,
      commenter_id: '9100000000000007',
      dm_status: 'ok',
      reply_status: 'ok',
      error: null,
      sent_at: NOW,
    });
  });

  it('sends only the DM when the rule has no public reply', async () => {
    await seedAccount();
    await seedRule({ publicReply: null });
    await postWebhook(commentPayload());
    expect(dmCalls()).toHaveLength(1);
    expect(replyCalls()).toEqual([]);
    expect(await sentRow('17900000000000001')).toMatchObject({ dm_status: 'ok', reply_status: null });
  });

  it('keeps comment and media ids longer than 2^53 exact', async () => {
    await seedAccount();
    await seedRule({ mediaId: '18099999999999999' });
    // Meta sends these as bare JSON numbers; JSON.parse alone would round them.
    const raw = JSON.stringify(commentPayload({ text: 'guide' }))
      .replace('"17900000000000001"', '17999999999999999')
      .replace('"18000000000000777"', '18099999999999999');

    await postWebhook(raw);

    expect(dmCalls()).toEqual([expect.objectContaining({ body: expect.objectContaining({ recipient: { comment_id: '17999999999999999' } }) })]);
    expect(await sentRow('17999999999999999')).toMatchObject({ dm_status: 'ok' });
  });

  it('keeps the ids exact when the comment text itself contains a colon and a long number', async () => {
    await seedAccount();
    await seedRule();
    const raw = JSON.stringify(commentPayload({ text: 'guide please, order: 123456789012345 thanks' }))
      .replace('"17900000000000001"', '17999999999999999');

    await postWebhook(raw);

    expect(dmCalls()).toEqual([expect.objectContaining({ body: expect.objectContaining({ recipient: { comment_id: '17999999999999999' } }) })]);
    expect(await sentRow('17999999999999999')).toMatchObject({ dm_status: 'ok' });
  });

  it('handles the Instagram Login shape with field and value on the entry', async () => {
    await seedAccount();
    await seedRule();
    await postWebhook({
      object: 'instagram',
      entry: [{ id: IG_USER, time: NOW, field: 'comments', value: commentValue({ commentId: 'flat-1' }) }],
    });
    expect(dmCalls()).toEqual([expect.objectContaining({ body: expect.objectContaining({ recipient: { comment_id: 'flat-1' } }) })]);
  });

  it('accepts entry.time in milliseconds', async () => {
    await seedAccount();
    await seedRule();
    await postWebhook(commentPayload({ time: NOW * 1000 }));
    expect(dmCalls()).toHaveLength(1);
  });
});

describe('comments that must not trigger a DM', () => {
  it('records a non-matching comment as skipped and calls Meta for nothing', async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'] });
    await postWebhook(commentPayload({ text: 'great video, guidelines were helpful' }));
    expect(meta.calls).toEqual([]);
    expect(await sentRows()).toEqual([expect.objectContaining({ dm_status: 'skipped', error: 'no matching rule', rule_id: null })]);
  });

  it('ignores the operator commenting on their own post, writing no row at all', async () => {
    await seedAccount();
    await seedRule();
    await postWebhook(commentPayload({ fromId: IG_USER, text: 'guide' }));
    expect(meta.calls).toEqual([]);
    expect(await sentRows()).toEqual([]);
  });

  it('skips a comment older than 7 days without calling Meta', async () => {
    await seedAccount();
    await seedRule();
    await postWebhook(commentPayload({ time: NOW - 7 * DAY - 1 }));
    expect(meta.calls).toEqual([]);
    expect(await sentRows()).toMatchObject([
      expect.objectContaining({ dm_status: 'skipped', error: 'comment older than 7 days — Instagram will not accept a private reply' }),
    ]);
  });

  it('drops comments for an account that is not connected', async () => {
    await seedAccount();
    await seedRule();
    await postWebhook(commentPayload({ igUserId: '17841400000000555' }));
    expect(meta.calls).toEqual([]);
    expect(await sentRows()).toEqual([]);
  });

  it('drops comments for a paused account', async () => {
    await seedAccount({ active: false });
    await seedRule();
    await postWebhook(commentPayload());
    expect(meta.calls).toEqual([]);
    expect(await sentRows()).toEqual([]);
  });

  it('ignores changes whose field is not comments', async () => {
    await seedAccount();
    await seedRule();
    const payload = commentPayload();
    payload.entry[0]!.changes[0]!.field = 'mentions';
    await postWebhook(payload);
    expect(meta.calls).toEqual([]);
    expect(await sentRows()).toEqual([]);
  });

  it('does not use a paused rule', async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'], active: false });
    await postWebhook(commentPayload({ text: 'guide' }));
    expect(meta.calls).toEqual([]);
    expect(await sentRows()).toEqual([expect.objectContaining({ dm_status: 'skipped', error: 'no matching rule' })]);
  });
});

describe('duplicate delivery', () => {
  it('sends one DM when Meta delivers the same comment twice', async () => {
    await seedAccount();
    await seedRule();
    const first = await postWebhook(commentPayload());
    const second = await postWebhook(commentPayload());
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(dmCalls()).toHaveLength(1);
    expect(await sentRows()).toHaveLength(1);
  });

  it('sends one DM when both deliveries arrive at the same time', async () => {
    await seedAccount();
    await seedRule();
    await Promise.all([postWebhook(commentPayload()), postWebhook(commentPayload())]);
    expect(dmCalls()).toHaveLength(1);
    expect(await sentRows()).toHaveLength(1);
  });

  it('handles each distinct comment in one batched delivery', async () => {
    await seedAccount();
    await seedRule();
    const payload = commentPayload({ commentId: 'batch-1' });
    payload.entry[0]!.changes.push({ field: 'comments', value: commentValue({ commentId: 'batch-2' }) });
    payload.entry[0]!.changes.push({ field: 'comments', value: commentValue({ commentId: 'batch-1' }) });
    await postWebhook(payload);
    expect(dmCalls().map((c) => (c.body as { recipient: { comment_id: string } }).recipient.comment_id)).toEqual(['batch-1', 'batch-2']);
  });
});

describe('match modes', () => {
  it('DMs a hashtag that contains the keyword when the rule matches anywhere', async () => {
    await seedAccount();
    const ruleId = await seedRule({ keywords: ['launch'], matchMode: 'contains', dmText: 'launch link' });
    await postWebhook(commentPayload({ text: 'So ready for #launch2026 🚀' }));
    expect(dmCalls()).toEqual([expect.objectContaining({ body: expect.objectContaining({ message: { text: 'launch link' } }) })]);
    expect(await sentRows()).toEqual([expect.objectContaining({ dm_status: 'ok', rule_id: ruleId })]);
  });

  it('skips the same comment when the rule matches whole words only', async () => {
    await seedAccount();
    await seedRule({ keywords: ['launch'], matchMode: 'word' });
    await postWebhook(commentPayload({ text: 'So ready for #launch2026 🚀' }));
    expect(meta.calls).toEqual([]);
    expect(await sentRows()).toEqual([expect.objectContaining({ dm_status: 'skipped', error: 'no matching rule' })]);
  });
});

describe('exclusions', () => {
  it('skips a comment that matches an exclusion, records why, and calls Meta for nothing', async () => {
    await seedAccount();
    const ruleId = await seedRule({ keywords: ['guide'], excludeKeywords: ['how much', 'already have'], publicReply: 'Sent!' });
    await postWebhook(commentPayload({ text: 'How much is the guide?' }));
    expect(meta.calls).toEqual([]);
    expect(await sentRows()).toEqual([
      expect.objectContaining({ rule_id: ruleId, dm_status: 'skipped', reply_status: null, error: 'Skipped: matched exclusion “how much”' }),
    ]);
  });

  it('keeps the skip when Meta delivers the comment again', async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'], excludeKeywords: ['how much'] });
    await postWebhook(commentPayload({ text: 'how much is the guide' }));
    await postWebhook(commentPayload({ text: 'how much is the guide' }));
    expect(meta.calls).toEqual([]);
    expect(await sentRows()).toEqual([expect.objectContaining({ dm_status: 'skipped' })]);
  });

  it('still sends when the exclusion is not in the comment', async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'], excludeKeywords: ['how much'] });
    await postWebhook(commentPayload({ text: 'guide please' }));
    expect(dmCalls()).toHaveLength(1);
  });

  it('lets another matching rule without that exclusion fire', async () => {
    await seedAccount();
    await seedRule({ label: 'Reel guide', keywords: ['guide'], mediaId: 'reel-1', excludeKeywords: ['how much'], dmText: 'reel guide' });
    const fallback = await seedRule({ label: 'Any guide', keywords: ['guide'], dmText: 'price list and guide' });
    await postWebhook(commentPayload({ mediaId: 'reel-1', text: 'how much is the guide' }));
    expect(dmCalls()).toEqual([expect.objectContaining({ body: expect.objectContaining({ message: { text: 'price list and guide' } }) })]);
    expect(await sentRows()).toEqual([expect.objectContaining({ dm_status: 'ok', rule_id: fallback, error: null })]);
  });
});

describe('rules that reply to every comment on a post', () => {
  it('DMs any comment on its post, with no keyword', async () => {
    await seedAccount();
    const ruleId = await seedRule({ keywords: [], matchAll: true, mediaId: 'reel-1', dmText: 'You are in the giveaway!' });
    await postWebhook(commentPayload({ mediaId: 'reel-1', text: 'love this 😍' }));
    expect(dmCalls()).toEqual([expect.objectContaining({ body: expect.objectContaining({ message: { text: 'You are in the giveaway!' } }) })]);
    expect(await sentRows()).toEqual([expect.objectContaining({ dm_status: 'ok', rule_id: ruleId })]);
  });

  it('does nothing for comments on other posts', async () => {
    await seedAccount();
    await seedRule({ keywords: [], matchAll: true, mediaId: 'reel-1' });
    await postWebhook(commentPayload({ mediaId: 'reel-2', text: 'love this' }));
    expect(meta.calls).toEqual([]);
    expect(await sentRows()).toEqual([expect.objectContaining({ dm_status: 'skipped', error: 'no matching rule' })]);
  });

  it('lets a keyword rule on the same post, or on all posts, win', async () => {
    await seedAccount();
    await seedRule({ keywords: [], matchAll: true, mediaId: 'reel-1', dmText: 'giveaway' });
    await seedRule({ keywords: ['price'], dmText: 'price list' });
    await seedRule({ keywords: ['guide'], mediaId: 'reel-1', dmText: 'reel guide' });
    await postWebhook(commentPayload({ commentId: 'c-guide', mediaId: 'reel-1', text: 'guide please' }));
    await postWebhook(commentPayload({ commentId: 'c-price', mediaId: 'reel-1', text: 'price?' }));
    await postWebhook(commentPayload({ commentId: 'c-other', mediaId: 'reel-1', text: 'so cool' }));
    expect(dmCalls().map((c) => (c.body as { message: { text: string } }).message.text)).toEqual(['reel guide', 'price list', 'giveaway']);
  });

  it('still ignores the operator, old comments and repeat deliveries', async () => {
    await seedAccount();
    await seedRule({ keywords: [], matchAll: true, mediaId: 'reel-1' });
    await postWebhook(commentPayload({ commentId: 'c-self', mediaId: 'reel-1', fromId: IG_USER, text: 'thanks all!' }));
    await postWebhook(commentPayload({ commentId: 'c-old', mediaId: 'reel-1', time: NOW - 7 * DAY - 1 }));
    await postWebhook(commentPayload({ commentId: 'c-twice', mediaId: 'reel-1' }));
    await postWebhook(commentPayload({ commentId: 'c-twice', mediaId: 'reel-1' }));
    expect(dmCalls().map((c) => (c.body as { recipient: { comment_id: string } }).recipient.comment_id)).toEqual(['c-twice']);
    expect((await sentRows()).map((r) => [r.comment_id, r.dm_status])).toEqual([
      ['c-old', 'skipped'],
      ['c-twice', 'ok'],
    ]);
  });

  it('applies its exclusions', async () => {
    await seedAccount();
    const ruleId = await seedRule({ keywords: [], matchAll: true, mediaId: 'reel-1', excludeKeywords: ['already entered'] });
    await postWebhook(commentPayload({ mediaId: 'reel-1', text: 'I already entered!' }));
    expect(meta.calls).toEqual([]);
    expect(await sentRows()).toEqual([
      expect.objectContaining({ dm_status: 'skipped', rule_id: ruleId, error: 'Skipped: matched exclusion “already entered”' }),
    ]);
  });
});

describe('media-scoped rules', () => {
  it('prefers a rule scoped to the post over an older all-posts rule', async () => {
    await seedAccount();
    await seedRule({ label: 'All posts', keywords: ['guide'], dmText: 'generic guide' });
    const scoped = await seedRule({ label: 'This reel', keywords: ['guide'], mediaId: 'reel-1', dmText: 'reel guide' });

    await postWebhook(commentPayload({ mediaId: 'reel-1', text: 'guide' }));

    expect(dmCalls()).toEqual([expect.objectContaining({ body: expect.objectContaining({ message: { text: 'reel guide' } }) })]);
    expect(await sentRows()).toEqual([expect.objectContaining({ rule_id: scoped })]);
  });

  it('does not fire a scoped rule for a comment on a different post', async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'], mediaId: 'reel-1' });
    await postWebhook(commentPayload({ mediaId: 'reel-2', text: 'guide' }));
    expect(meta.calls).toEqual([]);
    expect(await sentRows()).toEqual([expect.objectContaining({ dm_status: 'skipped', error: 'no matching rule' })]);
  });

  it('falls back to an all-posts rule when the scoped rule does not match', async () => {
    await seedAccount();
    await seedRule({ keywords: ['recipe'], mediaId: 'reel-1', dmText: 'recipe' });
    const general = await seedRule({ keywords: ['guide'], dmText: 'guide' });
    await postWebhook(commentPayload({ mediaId: 'reel-1', text: 'guide' }));
    expect(await sentRows()).toEqual([expect.objectContaining({ dm_status: 'ok', rule_id: general })]);
  });
});

describe('when Meta or the stored token fails', () => {
  it('records a 400 from the DM endpoint verbatim as failed, without retrying', async () => {
    await seedAccount();
    await seedRule({ publicReply: 'Check your DMs' });
    const error = { error: { message: 'This message is sent outside of allowed window.', type: 'IGApiException', code: 10, error_subcode: 2534022 } };
    meta.on('POST', '/:id/messages', { status: 400, json: error });

    const res = await postWebhook(commentPayload());

    expect(res.status).toBe(200);
    expect(dmCalls()).toHaveLength(1);
    const row = await sentRow('17900000000000001');
    expect(row).toMatchObject({ dm_status: 'failed' });
    expect(row?.error).toContain(`DM: ${JSON.stringify(error)}`);
  });

  it('holds back the public reply when the DM fails, and records it as skipped', async () => {
    await seedAccount();
    await seedRule({ publicReply: 'Check your DMs' });
    meta.on('POST', '/:id/messages', { status: 400, json: { error: { message: 'nope' } } });
    await postWebhook(commentPayload());
    expect(replyCalls()).toEqual([]);
    const row = await sentRow('17900000000000001');
    expect(row).toMatchObject({ dm_status: 'failed', reply_status: 'skipped' });
    expect(row?.error).toBe('DM: {"error":{"message":"nope"}}');
  });

  it('records a failed public reply alongside a successful DM', async () => {
    await seedAccount();
    await seedRule({ publicReply: 'Check your DMs' });
    meta.on('POST', '/:id/replies', { status: 403, json: { error: { message: 'replies disabled' } } });
    await postWebhook(commentPayload());
    const row = await sentRow('17900000000000001');
    expect(row).toMatchObject({ dm_status: 'ok', reply_status: 'failed' });
    expect(row?.error).toContain('public reply: {"error":{"message":"replies disabled"}}');
  });

  it('records a token that no longer decrypts as failed and calls Meta for nothing', async () => {
    await seedAccount({ encryptionKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))) });
    await seedRule({ publicReply: 'Check your DMs' });
    await postWebhook(commentPayload());
    expect(meta.calls).toEqual([]);
    const row = await sentRow('17900000000000001');
    expect(row).toMatchObject({ dm_status: 'failed', reply_status: 'skipped' });
    expect(row?.error).toMatch(/^could not decrypt access token/);
  });
});
