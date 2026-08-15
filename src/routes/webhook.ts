import { Hono } from 'hono';
import { verifyMetaSignature } from '../crypto.ts';
import { processWebhook } from '../process.ts';
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
  const ok = await verifyMetaSignature(c.env.META_APP_SECRET, raw, header);
  if (!ok) return c.text('unauthorized', 401);

  c.executionCtx.waitUntil(
    (async () => {
      const payload: unknown = JSON.parse(raw);
      await processWebhook(c.env, payload);
    })().catch((err) => {
      console.error('webhook waitUntil', err instanceof Error ? err.message : err);
    }),
  );

  return c.body('', 200);
});
