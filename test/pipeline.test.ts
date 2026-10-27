import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { claimExtraReply } from '../src/db.ts';
import { EXTRA_REPLY_NONE, EXTRA_REPLY_NO_DM, EXTRA_REPLY_OVER_CAP, EXTRA_REPLY_OWN_DM_ONLY } from '../src/other-replies.ts';
import { meta } from './support/meta.ts';
import { ACCESS_TOKEN, DAY, IG_USER, NOW, extraReplyRows, seedAccount, seedRule, sentRow, sentRows } from './support/seed.ts';
import { commentPayload, commentValue, postWebhook, runMinutes } from './support/worker.ts';

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

describe('the {username} placeholder', () => {
  it('puts the commenter\'s username into the DM and the public reply', async () => {
    await seedAccount();
    await seedRule({ dmText: 'Hey {username}, here is the guide: https://example.com/g', publicReply: 'Check your DMs, @{Username}!' });

    await postWebhook(commentPayload({ username: 'sarah.k' }));

    expect(dmCalls()).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ message: { text: 'Hey sarah.k, here is the guide: https://example.com/g' } }) }),
    ]);
    expect(replyCalls()).toEqual([expect.objectContaining({ body: { message: 'Check your DMs, @sarah.k!' } })]);
    expect(await sentRow('17900000000000001')).toMatchObject({ dm_status: 'ok', reply_status: 'ok', error: null });
  });

  it('still sends both, with the token tidied away, when the payload has no username', async () => {
    await seedAccount();
    await seedRule({ dmText: 'Hey {username}, here is the guide:\n\nhttps://example.com/g', publicReply: 'Sent you a DM {username} 🙌' });

    await postWebhook(commentPayload({ username: null }));

    expect(dmCalls()).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ message: { text: 'Hey, here is the guide:\n\nhttps://example.com/g' } }) }),
    ]);
    expect(replyCalls()).toEqual([expect.objectContaining({ body: { message: 'Sent you a DM 🙌' } })]);
    expect(await sentRow('17900000000000001')).toMatchObject({ dm_status: 'ok', reply_status: 'ok' });
  });

  it('sends text with no placeholder byte for byte, leaving other braces alone', async () => {
    await seedAccount();
    await seedRule({ dmText: 'Use code {SAVE10} at {link}' });
    await postWebhook(commentPayload({ username: 'sarah' }));
    expect(dmCalls()).toEqual([expect.objectContaining({ body: expect.objectContaining({ message: { text: 'Use code {SAVE10} at {link}' } }) })]);
  });
});

describe('public reply variations', () => {
  it('posts one of the variations per comment, with {username} filled in', async () => {
    await seedAccount();
    await seedRule({ publicReply: JSON.stringify(['Sent, {username}!', 'Check your DMs 📩', 'On its way']) });
    const payload = commentPayload({ commentId: 'v-0', username: 'sarah' });
    for (let i = 1; i < 30; i++) {
      payload.entry[0]!.changes.push({ field: 'comments', value: commentValue({ commentId: `v-${i}`, username: 'sarah' }) });
    }

    // One delivery can't send 30 within its 50 subrequests, so most wait in
    // the queue for the minute job.
    await postWebhook(payload);
    expect(replyCalls().length).toBeLessThan(30);
    await runMinutes(4);

    const posted = replyCalls().map((c) => (c.body as { message: string }).message);
    expect(posted).toHaveLength(30);
    expect(new Set(replyCalls().map((c) => c.path)).size).toBe(30);
    for (const message of posted) expect(['Sent, sarah!', 'Check your DMs 📩', 'On its way']).toContain(message);
    // Thirty identical picks from three would be a one-in-10^14 fluke, not chance.
    expect(new Set(posted).size).toBeGreaterThan(1);
  });

  it('sends a legacy multi-line public reply whole, as one reply', async () => {
    await seedAccount();
    await seedRule({ publicReply: 'Sent you a DM!\nCheck your message requests too.' });
    await postWebhook(commentPayload());
    expect(replyCalls()).toEqual([expect.objectContaining({ body: { message: 'Sent you a DM!\nCheck your message requests too.' } })]);
  });

  it('sends a saved reply that only looks like a list as one reply, never silently dropping it', async () => {
    await seedAccount();
    await seedRule({ publicReply: '[see bio] for the link' });
    await postWebhook(commentPayload());
    expect(replyCalls()).toEqual([expect.objectContaining({ body: { message: '[see bio] for the link' } })]);
    expect(await sentRow('17900000000000001')).toMatchObject({ reply_status: 'ok' });
  });
});

describe('comments that must not trigger a DM', () => {
  // A busy account's comments mostly match nothing, and a row for each would
  // spend D1's 100,000 daily row writes on them.
  it('writes no row for a comment no rule matches, and calls Meta for nothing', async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'] });
    await postWebhook(commentPayload({ text: 'great video, guidelines were helpful' }));
    expect(meta.calls).toEqual([]);
    expect(await sentRows()).toEqual([]);
  });

  it('ignores the operator commenting on their own post, writing no row at all', async () => {
    await seedAccount();
    await seedRule();
    await postWebhook(commentPayload({ fromId: IG_USER, text: 'guide' }));
    expect(meta.calls).toEqual([]);
    expect(await sentRows()).toEqual([]);
  });

  it('records a matching comment older than 7 days as skipped without calling Meta', async () => {
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

  it('records a paused account’s matching comments as skipped, without calling Instagram', async () => {
    await seedAccount({ active: false });
    const ruleId = await seedRule();
    await postWebhook(commentPayload());
    await postWebhook(commentPayload({ commentId: 'no-rule', text: 'love it' }));
    expect(meta.calls).toEqual([]);
    expect(await sentRows()).toMatchObject([{ rule_id: ruleId, dm_status: 'skipped', error: 'account paused' }]);
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
    expect(await sentRows()).toEqual([]);
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

  it('ignores the same comment when the rule matches whole words only', async () => {
    await seedAccount();
    await seedRule({ keywords: ['launch'], matchMode: 'word' });
    await postWebhook(commentPayload({ text: 'So ready for #launch2026 🚀' }));
    expect(meta.calls).toEqual([]);
    expect(await sentRows()).toEqual([]);
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
    expect(await sentRows()).toEqual([]);
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
    expect(await sentRows()).toEqual([]);
  });

  it('falls back to an all-posts rule when the scoped rule does not match', async () => {
    await seedAccount();
    await seedRule({ keywords: ['recipe'], mediaId: 'reel-1', dmText: 'recipe' });
    const general = await seedRule({ keywords: ['guide'], dmText: 'guide' });
    await postWebhook(commentPayload({ mediaId: 'reel-1', text: 'guide' }));
    expect(await sentRows()).toEqual([expect.objectContaining({ dm_status: 'ok', rule_id: general })]);
  });
});

describe('comments on a boosted post', () => {
  const POST = '18011100000000001';
  const AD_MEDIA = '18055500000000001';

  /**
   * A comment left on the ad, in the shape Meta documents: `media.id` is the
   * ad's own media, and `ad_id`, `ad_title` and `original_media_id` are added
   * to `media`. No live boosted post was available, so this fixture is built
   * from Meta's webhook reference rather than captured.
   */
  function adComment(opts: { commentId?: string; text?: string } = {}) {
    return {
      object: 'instagram',
      entry: [
        {
          id: IG_USER,
          time: NOW,
          changes: [
            {
              field: 'comments',
              value: {
                from: { id: '9100000000000042', username: 'saw_the_ad' },
                media: {
                  id: AD_MEDIA,
                  ad_id: '120212345678900001',
                  ad_title: 'Free guide reel - boost',
                  original_media_id: POST,
                  media_product_type: 'FEED',
                },
                id: opts.commentId ?? '17955500000000001',
                text: opts.text ?? 'guide please!',
              },
            },
          ],
        },
      ],
    };
  }

  it('answers with the rule scoped to the original post, once, though Meta may deliver it twice', async () => {
    await seedAccount();
    const scoped = await seedRule({ label: 'This reel', keywords: ['guide'], mediaId: POST, dmText: 'reel guide', publicReply: 'Sent!' });

    // Meta warns that comments on boosted posts can arrive as duplicate notifications.
    await postWebhook(adComment());
    await postWebhook(adComment());

    expect(dmCalls()).toEqual([
      expect.objectContaining({ body: { recipient: { comment_id: '17955500000000001' }, message: { text: 'reel guide' } } }),
    ]);
    expect(replyCalls()).toEqual([expect.objectContaining({ path: '/17955500000000001/replies' })]);
    expect(await sentRows()).toEqual([
      expect.objectContaining({ comment_id: '17955500000000001', rule_id: scoped, dm_status: 'ok', reply_status: 'ok' }),
    ]);
  });

  it('still prefers the post rule over an older all-posts rule', async () => {
    await seedAccount();
    await seedRule({ label: 'All posts', keywords: ['guide'], dmText: 'generic guide' });
    const scoped = await seedRule({ label: 'This reel', keywords: ['guide'], mediaId: POST, dmText: 'reel guide' });
    await postWebhook(adComment());
    expect(dmCalls()).toEqual([expect.objectContaining({ body: expect.objectContaining({ message: { text: 'reel guide' } }) })]);
    expect(await sentRows()).toEqual([expect.objectContaining({ rule_id: scoped })]);
  });

  it('leaves all-posts rules answering ad comments as before', async () => {
    await seedAccount();
    await seedRule({ keywords: ['recipe'], mediaId: POST, dmText: 'recipe' });
    const general = await seedRule({ keywords: ['guide'], dmText: 'generic guide' });
    await postWebhook(adComment());
    expect(await sentRows()).toEqual([expect.objectContaining({ dm_status: 'ok', rule_id: general })]);
  });

  it('reads original_media_id exactly when Meta sends it as a bare number', async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'], mediaId: '18099999999999999' });
    const raw = JSON.stringify(adComment()).replace(`"original_media_id":"${POST}"`, '"original_media_id":18099999999999999');
    await postWebhook(raw);
    expect(await sentRows()).toEqual([expect.objectContaining({ dm_status: 'ok' })]);
  });
});

describe('when more than one rule matches', () => {
  const replyTexts = () => replyCalls().map((c) => (c.body as { message: string }).message);

  it('sends one DM, from the first rule, and the public reply of every rule set to reply without its DM', async () => {
    await seedAccount();
    const guide = await seedRule({ label: 'Guide', keywords: ['guide'], dmText: 'guide link', publicReply: 'Sent you the guide!' });
    const price = await seedRule({ label: 'Price', keywords: ['price'], dmText: 'price list', publicReply: 'From $20, {username}!', replyWithoutDm: true });
    const quiet = await seedRule({ label: 'Quiet', keywords: ['guide'], dmText: 'other guide', replyWithoutDm: true });
    const own = await seedRule({ label: 'Own DM only', keywords: ['guide'], publicReply: 'Check your DMs!' });

    await postWebhook(commentPayload({ text: 'guide price?', username: 'sarah' }));

    expect(dmCalls().map((c) => c.body)).toEqual([{ recipient: { comment_id: '17900000000000001' }, message: { text: 'guide link' } }]);
    expect(replyCalls().map((c) => [c.path, c.body])).toEqual([
      ['/17900000000000001/replies', { message: 'Sent you the guide!' }],
      ['/17900000000000001/replies', { message: 'From $20, sarah!' }],
    ]);
    expect(await sentRows()).toEqual([expect.objectContaining({ rule_id: guide, dm_status: 'ok', reply_status: 'ok', error: null })]);
    expect(await extraReplyRows()).toMatchObject([
      { comment_id: '17900000000000001', rule_id: price, status: 'ok', error: null, sent_at: NOW },
      { comment_id: '17900000000000001', rule_id: quiet, status: 'skipped', error: EXTRA_REPLY_NONE },
      { comment_id: '17900000000000001', rule_id: own, status: 'skipped', error: EXTRA_REPLY_OWN_DM_ONLY },
    ]);
  });

  it('posts no other rule’s reply unless that rule was set to, so a “Check your DMs” reply is never false', async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'], dmText: 'guide link' });
    const prices = await seedRule({ keywords: ['guide'], dmText: 'price list', publicReply: 'Prices are in your DMs' });
    await postWebhook(commentPayload({ text: 'guide' }));
    expect(dmCalls()).toHaveLength(1);
    expect(replyCalls()).toEqual([]);
    expect(await extraReplyRows()).toMatchObject([{ rule_id: prices, status: 'skipped', error: EXTRA_REPLY_OWN_DM_ONLY }]);
  });

  it('posts other rules’ replies even when the DM rule has none, and picks one variation', async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'] });
    await seedRule({ keywords: ['guide'], publicReply: JSON.stringify(['Variation A', 'Variation B']), replyWithoutDm: true });
    await postWebhook(commentPayload({ text: 'guide' }));
    expect(dmCalls()).toHaveLength(1);
    expect(replyTexts()).toHaveLength(1);
    expect(['Variation A', 'Variation B']).toContain(replyTexts()[0]);
    expect(await extraReplyRows()).toMatchObject([{ status: 'ok' }]);
  });

  it('posts at most two other rules’ replies, and records the rest as over the limit', async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'], publicReply: 'Reply 1' });
    const ids: number[] = [];
    for (const n of [2, 3, 4, 5]) ids.push(await seedRule({ keywords: ['guide'], publicReply: `Reply ${n}`, replyWithoutDm: true }));

    await postWebhook(commentPayload({ text: 'guide' }));

    expect(dmCalls()).toHaveLength(1);
    expect(replyTexts()).toEqual(['Reply 1', 'Reply 2', 'Reply 3']);
    expect(await extraReplyRows()).toMatchObject([
      { rule_id: ids[0], status: 'ok' },
      { rule_id: ids[1], status: 'ok' },
      { rule_id: ids[2], status: 'skipped', error: EXTRA_REPLY_OVER_CAP },
      { rule_id: ids[3], status: 'skipped', error: EXTRA_REPLY_OVER_CAP },
    ]);
  });

  it('posts no public reply at all when the DM fails, and says why for each rule', async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'], publicReply: 'Sent you a DM!' });
    const price = await seedRule({ keywords: ['guide'], publicReply: 'From $20', replyWithoutDm: true });
    meta.on('POST', '/:id/messages', { status: 400, json: { error: { message: 'outside of allowed window' } } });

    await postWebhook(commentPayload({ text: 'guide' }));

    expect(replyCalls()).toEqual([]);
    expect(await sentRows()).toEqual([expect.objectContaining({ dm_status: 'failed', reply_status: 'skipped' })]);
    expect(await extraReplyRows()).toMatchObject([{ rule_id: price, status: 'skipped', error: EXTRA_REPLY_NO_DM }]);
  });

  it('posts nothing for other rules when the token no longer decrypts', async () => {
    await seedAccount({ encryptionKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))) });
    await seedRule({ keywords: ['guide'] });
    await seedRule({ keywords: ['guide'], publicReply: 'From $20', replyWithoutDm: true });
    await postWebhook(commentPayload({ text: 'guide' }));
    expect(meta.calls).toEqual([]);
    expect(await extraReplyRows()).toMatchObject([{ status: 'skipped', error: EXTRA_REPLY_NO_DM }]);
  });

  it('leaves out a rule whose exclusion matched: it neither replies nor counts towards the limit', async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'], publicReply: 'Reply 1' });
    await seedRule({ keywords: ['guide'], excludeKeywords: ['how much'], publicReply: 'Excluded', replyWithoutDm: true });
    await seedRule({ keywords: ['guide'], publicReply: 'Reply 2', replyWithoutDm: true });
    await seedRule({ keywords: ['guide'], publicReply: 'Reply 3', replyWithoutDm: true });

    await postWebhook(commentPayload({ text: 'how much is the guide' }));

    expect(replyTexts()).toEqual(['Reply 1', 'Reply 2', 'Reply 3']);
    expect((await extraReplyRows()).map((r) => r.status)).toEqual(['ok', 'ok']);
  });

  it('records another rule’s failed reply, and still posts the next one', async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'] });
    const broken = await seedRule({ keywords: ['guide'], publicReply: 'Broken', replyWithoutDm: true });
    const fine = await seedRule({ keywords: ['guide'], publicReply: 'Fine', replyWithoutDm: true });
    meta.on('POST', '/:id/replies', (call) =>
      (call.body as { message: string }).message === 'Broken'
        ? { status: 400, json: { error: { message: 'Comment is too long' } } }
        : { json: { id: '18000000000000001' } },
    );

    await postWebhook(commentPayload({ text: 'guide' }));

    expect(replyTexts()).toEqual(['Broken', 'Fine']);
    expect(await sentRows()).toEqual([expect.objectContaining({ dm_status: 'ok', reply_status: null, error: null })]);
    expect(await extraReplyRows()).toMatchObject([
      { rule_id: broken, status: 'failed', error: expect.stringContaining('Comment is too long') },
      { rule_id: fine, status: 'ok', error: null },
    ]);
  });

  it('posts each reply once when Meta delivers the comment twice, even at the same time', async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'], publicReply: 'Reply 1' });
    await seedRule({ keywords: ['guide'], publicReply: 'Reply 2', replyWithoutDm: true });
    await Promise.all([postWebhook(commentPayload({ text: 'guide' })), postWebhook(commentPayload({ text: 'guide' }))]);
    await postWebhook(commentPayload({ text: 'guide' }));
    expect(dmCalls()).toHaveLength(1);
    expect(replyTexts()).toEqual(['Reply 1', 'Reply 2']);
    expect(await extraReplyRows()).toHaveLength(1);
  });

  it('lets only one of two racing claims for the same rule and comment post its reply', async () => {
    const row = { comment_id: '17900000000000001', rule_id: 7, status: 'pending', error: null, sent_at: NOW };
    const claims = await Promise.all([claimExtraReply(env.DB, row), claimExtraReply(env.DB, { ...row, status: 'skipped' })]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await extraReplyRows()).toHaveLength(1);
    expect(await claimExtraReply(env.DB, row)).toBe(false);
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
