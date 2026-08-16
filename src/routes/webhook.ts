import { Hono } from 'hono';
import { nowSeconds, verifyMetaSignatureAny } from '../crypto.ts';
import { insertWebhookEvent } from '../db.ts';
import { parseWebhookPayload, processWebhook } from '../process.ts';
import type { Env } from '../types.ts';

export const webhookRoutes = new Hono<{ Bindings: Env }>();

webhookRoutes.get('/', (c) => {
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');
  if (token !== c.env.WEBHOOK_VERIFY_TOKEN) return c.text('forbidden', 403);
  if (challenge == null || challenge === '') return c.text('forbidden', 403);
  return c.text(challenge, 200);
});

webhookRoutes.post('/', async (c) => {
  const raw = await c.req.text();
  const header = c.req.header('X-Hub-Signature-256');
  const ok = await verifyMetaSignatureAny(
    [c.env.FACEBOOK_APP_SECRET, c.env.META_APP_SECRET],
    raw,
    header,
  );
  if (!ok) {
    await insertWebhookEvent(c.env.DB, {
      received_at: nowSeconds(),
      status: 'bad_sig',
      object: null,
      preview: raw.slice(0, 200),
      error: header ? 'signature did not match Instagram or Facebook app secret' : 'missing X-Hub-Signature-256',
    }).catch((err) => {
      console.error('webhook log failed', err instanceof Error ? err.message : err);
    });
    return c.text('unauthorized', 401);
  }

  await insertWebhookEvent(c.env.DB, {
    received_at: nowSeconds(),
    status: 'received',
    object: objectOf(raw),
    preview: raw.slice(0, 200),
    error: null,
  }).catch((err) => {
    console.error('webhook log failed', err instanceof Error ? err.message : err);
  });

  c.executionCtx.waitUntil(
    (async () => {
      const payload: unknown = parseWebhookPayload(raw);
      await processWebhook(c.env, payload);
    })().catch((err) => {
      console.error('webhook waitUntil', err instanceof Error ? err.message : err);
    }),
  );

  return c.body('', 200);
});

function objectOf(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { object?: unknown };
    return typeof parsed.object === 'string' ? parsed.object : null;
  } catch {
    return null;
  }
}
