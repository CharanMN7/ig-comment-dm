import { Hono } from 'hono';
import { runCron } from './cron.ts';
import { securityHeaders } from './headers.ts';
import { reconcileComments } from './reconcile.ts';
import { adminRoutes } from './routes/admin.ts';
import { connectRoutes } from './routes/connect.ts';
import { legalRoutes } from './routes/legal.ts';
import { webhookRoutes } from './routes/webhook.ts';
import type { Env } from './types.ts';

const app = new Hono<{ Bindings: Env }>({ strict: false });

app.use('*', securityHeaders);

app.get('/', (c) => c.text('ok'));
app.route('/', legalRoutes);
app.route('/webhook', webhookRoutes);
app.route('/connect', connectRoutes);
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
