import { Hono } from 'hono';
import { runCron } from './cron.ts';
import { adminRoutes } from './routes/admin.ts';
import { connectRoutes } from './routes/connect.ts';
import { webhookRoutes } from './routes/webhook.ts';
import type { Env } from './types.ts';

const app = new Hono<{ Bindings: Env }>({ strict: false });

app.get('/', (c) => c.text('ok'));
app.route('/webhook', webhookRoutes);
app.route('/connect', connectRoutes);
app.route('/a/:secret', adminRoutes);

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runCron(env);
  },
};
