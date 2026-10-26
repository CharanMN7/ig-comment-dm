import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { meta } from './support/meta.ts';
import { seedAccount, seedRule, sentRows, webhookEvents } from './support/seed.ts';
import { commentPayload, postWebhook, request, signature } from './support/worker.ts';

describe('GET /webhook verification handshake', () => {
  it('echoes hub.challenge when the verify token matches', async () => {
    const res = await request('/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444');
    expect(res.status).toBe(200);
    expect(res.text).toBe('1158201444');
  });

  it('answers 403 when the verify token is wrong', async () => {
    const res = await request('/webhook?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=1158201444');
    expect(res.status).toBe(403);
    expect(res.text).not.toContain('1158201444');
  });

  it('answers 403 when the challenge is missing, even with the right token', async () => {
    const res = await request('/webhook?hub.mode=subscribe&hub.verify_token=verify-me');
    expect(res.status).toBe(403);
  });
});

describe('POST /webhook signature checks', () => {
  beforeEach(async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'] });
  });

  it('accepts a body signed with META_APP_SECRET and logs it as received', async () => {
    const res = await postWebhook(commentPayload(), { secret: env.META_APP_SECRET });
    expect(res.status).toBe(200);
    expect(await webhookEvents()).toEqual([expect.objectContaining({ status: 'received', object: 'instagram', error: null })]);
    expect(meta.callsTo('POST', '/:id/messages')).toHaveLength(1);
  });

  it('accepts a body signed with FACEBOOK_APP_SECRET, which Meta uses for live comments', async () => {
    const res = await postWebhook(commentPayload(), { secret: env.FACEBOOK_APP_SECRET });
    expect(res.status).toBe(200);
    expect(meta.callsTo('POST', '/:id/messages')).toHaveLength(1);
  });

  it('rejects a body signed with the wrong secret, logs bad_sig and sends nothing', async () => {
    const res = await postWebhook(commentPayload(), { secret: 'not-the-app-secret' });
    expect(res.status).toBe(401);
    expect(await webhookEvents()).toEqual([
      expect.objectContaining({ status: 'bad_sig', error: 'signature did not match Instagram or Facebook app secret' }),
    ]);
    expect(await sentRows()).toEqual([]);
    expect(meta.calls).toEqual([]);
  });

  it('rejects a body with no X-Hub-Signature-256 header and logs it apart from a wrong signature', async () => {
    const res = await postWebhook(commentPayload(), { signature: null });
    expect(res.status).toBe(401);
    expect(await webhookEvents()).toEqual([expect.objectContaining({ status: 'unsigned', error: 'missing X-Hub-Signature-256' })]);
    expect(meta.calls).toEqual([]);
  });

  it('rejects a signature header that is not sha256=<hex>', async () => {
    const res = await postWebhook(commentPayload(), { signature: 'sha1=abc' });
    expect(res.status).toBe(401);
  });

  it('verifies the raw bytes, so a re-serialized body fails', async () => {
    const payload = commentPayload();
    const compact = JSON.stringify(payload);
    const pretty = JSON.stringify(payload, null, 2);
    const res = await postWebhook(pretty, { signature: await signature(compact) });
    expect(res.status).toBe(401);
    expect(meta.calls).toEqual([]);
  });

  it('still accepts META_APP_SECRET signatures when FACEBOOK_APP_SECRET is unset, and rejects Facebook ones', async () => {
    const noFacebook = { FACEBOOK_APP_SECRET: undefined };
    const viaInstagram = await postWebhook(commentPayload({ commentId: 'c-ig' }), { secret: env.META_APP_SECRET, env: noFacebook });
    const viaFacebook = await postWebhook(commentPayload({ commentId: 'c-fb' }), { secret: env.FACEBOOK_APP_SECRET, env: noFacebook });
    expect(viaInstagram.status).toBe(200);
    expect(viaFacebook.status).toBe(401);
  });

  it('answers 200 to a signed body that is not JSON, without processing anything', async () => {
    const res = await postWebhook('this is not json');
    expect(res.status).toBe(200);
    expect(await webhookEvents()).toEqual([expect.objectContaining({ status: 'received', object: null })]);
    expect(await sentRows()).toEqual([]);
    expect(meta.calls).toEqual([]);
  });
});
