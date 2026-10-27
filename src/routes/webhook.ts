import { Hono } from 'hono';
import { nowSeconds, verifyMetaSignatureAny } from '../crypto.ts';
import { logBadSignature, logVerifiedWebhook } from '../db.ts';
import { WEBHOOK_SEND_BUDGET_MS, parseWebhookPayload, processWebhook } from '../process.ts';
import type { Env } from '../types.ts';

export const webhookRoutes = new Hono<{ Bindings: Env }>();

webhookRoutes.get('/', (c) => {
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');
  if (token !== c.env.WEBHOOK_VERIFY_TOKEN) return c.text('forbidden', 403);
  if (challenge == null || challenge === '') return c.text('forbidden', 403);
  return c.text(challenge, 200);
});

// A comment notification from Meta is well under a kilobyte. This leaves room
// for a batch of hundreds, and stops anyone else making the Worker buffer an
// unbounded body before the signature check can turn it away. A comment in a
// delivery refused here is still found by the 5-minute poll.
const WEBHOOK_MAX_BYTES = 256 * 1024;

webhookRoutes.post('/', async (c) => {
  const raw = await readCapped(c.req.raw, WEBHOOK_MAX_BYTES);
  if (raw == null) return c.text('payload too large', 413);
  const header = c.req.header('X-Hub-Signature-256');
  const ok = await verifyMetaSignatureAny(
    [c.env.FACEBOOK_APP_SECRET, c.env.META_APP_SECRET],
    raw,
    header,
  );
  if (!ok) {
    // Meta signs every delivery, so a POST with no signature at all is a
    // scanner or a hand-made request, not Meta with a secret we lack, and
    // isn't worth a database write.
    if (header) {
      await logBadSignature(c.env.DB, nowSeconds(), raw.slice(0, 200)).catch((err) => {
        console.error('webhook log failed', err instanceof Error ? err.message : err);
      });
    }
    return c.text('unauthorized', 401);
  }

  await logVerifiedWebhook(c.env.DB, nowSeconds(), objectOf(raw), raw.slice(0, 200)).catch((err) => {
    console.error('webhook log failed', err instanceof Error ? err.message : err);
  });

  c.executionCtx.waitUntil(
    (async () => {
      const deadline = Date.now() + WEBHOOK_SEND_BUDGET_MS;
      const payload: unknown = parseWebhookPayload(raw);
      await processWebhook(c.env, payload, deadline);
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

/** The body as text, or null once it is declared or found to be over `max` bytes. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get('Content-Length')) > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
