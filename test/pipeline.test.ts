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
    expect(await sentRow('17900000000000042')).toEqual({
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
    expect(await sentRows()).toEqual([
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

  it('still posts the public reply when the DM fails', async () => {
    await seedAccount();
    await seedRule({ publicReply: 'Check your DMs' });
    meta.on('POST', '/:id/messages', { status: 400, json: { error: { message: 'nope' } } });
    await postWebhook(commentPayload());
    expect(replyCalls()).toHaveLength(1);
    expect(await sentRow('17900000000000001')).toMatchObject({ dm_status: 'failed', reply_status: 'ok' });
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
    await seedRule();
    await postWebhook(commentPayload());
    expect(meta.calls).toEqual([]);
    const row = await sentRow('17900000000000001');
    expect(row).toMatchObject({ dm_status: 'failed' });
    expect(row?.error).toMatch(/^could not decrypt access token/);
  });
});
