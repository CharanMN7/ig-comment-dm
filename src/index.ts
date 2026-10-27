import { Hono } from 'hono';
import { runCron } from './cron.ts';
import { securityHeaders } from './headers.ts';
import { ICON_SVG } from './icons.ts';
import { reconcileComments } from './reconcile.ts';
import { adminRoutes } from './routes/admin.ts';
import { connectRoutes } from './routes/connect.ts';
import { healthRoutes } from './routes/health.ts';
import { PNGS, installRoutes } from './routes/install.ts';
import { legalRoutes } from './routes/legal.ts';
import { webhookRoutes } from './routes/webhook.ts';
import type { Env } from './types.ts';

const app = new Hono<{ Bindings: Env }>({ strict: false });

app.use('*', securityHeaders);

app.get('/', (c) => c.text('ok'));
// The same drawing as the admin's home-screen icon, which gives nothing away, so
// these live outside /a/ and can be cached. Pages link the SVG. /favicon.ico is
// for responses with no <head> to link from (`/`, /health, a 404), which a
// browser asks about anyway, and is a PNG because every browser reads one there.
const ICON_CACHE = 'public, max-age=604800';
app.get('/favicon.svg', (c) => c.body(ICON_SVG, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': ICON_CACHE }));
app.get('/favicon.ico', (c) => c.body(PNGS[192], 200, { 'Content-Type': 'image/png', 'Cache-Control': ICON_CACHE }));
app.route('/health', healthRoutes);
app.route('/', legalRoutes);
app.route('/webhook', webhookRoutes);
app.route('/connect', connectRoutes);
// First, so its four public GETs answer before the admin login middleware.
app.route('/a/:secret', installRoutes);
app.route('/a/:secret', adminRoutes);

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (event.cron === '*/5 * * * *') {
      await reconcileComments(env);
      return;
    }
    await runCron(env);
  },
};
