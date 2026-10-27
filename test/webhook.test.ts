import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { meta } from './support/meta.ts';
import { FROZEN_NOW_MS, seedAccount, seedRule, sentRows, webhookEvents } from './support/seed.ts';
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

  it('rejects a body with no X-Hub-Signature-256 header without writing anything', async () => {
    const res = await postWebhook(commentPayload(), { signature: null });
    expect(res.status).toBe(401);
    expect(await webhookEvents()).toEqual([]);
    expect(meta.calls).toEqual([]);
  });

  it('logs at most one wrong signature a minute, however many arrive', async () => {
    const burst = await Promise.all(Array.from({ length: 20 }, () => postWebhook(commentPayload(), { secret: 'wrong' })));
    expect(burst.map((r) => r.status)).toEqual(Array(20).fill(401));
    expect(await webhookEvents()).toEqual([expect.objectContaining({ status: 'bad_sig' })]);

    vi.setSystemTime(FROZEN_NOW_MS + 59_000);
    await postWebhook(commentPayload(), { secret: 'wrong' });
    expect(await webhookEvents()).toHaveLength(1);

    vi.setSystemTime(FROZEN_NOW_MS + 60_000);
    await postWebhook(commentPayload(), { secret: 'wrong' });
    expect(await webhookEvents()).toEqual([expect.objectContaining({ status: 'bad_sig' }), expect.objectContaining({ status: 'bad_sig' })]);
  });

  it('still logs every good delivery while wrong signatures are being held back', async () => {
    await postWebhook(commentPayload(), { secret: 'wrong' });
    await postWebhook(commentPayload({ commentId: 'c-1' }));
    await postWebhook(commentPayload(), { secret: 'wrong' });
    await postWebhook(commentPayload({ commentId: 'c-2' }));
    expect((await webhookEvents()).map((e) => e.status)).toEqual(['bad_sig', 'received', 'received']);
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

  it('turns away a body declared larger than 256 KB without reading it', async () => {
    let pulled = false;
    // A high-water mark of 0, so nothing is pulled until someone reads.
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
          throw new Error('the Worker read a body it should have refused');
        },
      },
      { highWaterMark: 0 },
    );
    const res = await request('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(256 * 1024 + 1), 'X-Hub-Signature-256': 'sha256=00' },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(pulled).toBe(false);
    expect(await webhookEvents()).toEqual([]);
  });

  it('stops reading a body with no length once it passes 256 KB', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks++;
        if (chunks > 100) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const res = await request('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=00' },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(chunks).toBeLessThan(10);
    expect(await webhookEvents()).toEqual([]);
  });

  it('accepts a signed body just under 256 KB', async () => {
    const payload = commentPayload();
    const raw = JSON.stringify(payload);
    const padded = raw.slice(0, -1) + ',"pad":"' + 'x'.repeat(256 * 1024 - raw.length - 10) + '"}';
    expect(new TextEncoder().encode(padded).length).toBeLessThanOrEqual(256 * 1024);
    const res = await postWebhook(padded);
    expect(res.status).toBe(200);
    expect(meta.callsTo('POST', '/:id/messages')).toHaveLength(1);
  });

  it('answers 200 to a signed body that is not JSON, without processing anything', async () => {
    const res = await postWebhook('this is not json');
    expect(res.status).toBe(200);
    expect(await webhookEvents()).toEqual([expect.objectContaining({ status: 'received', object: null })]);
    expect(await sentRows()).toEqual([]);
    expect(meta.calls).toEqual([]);
  });
});
