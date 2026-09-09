import { Hono } from 'hono';
import { CRON_STALE_SECONDS, nowSeconds } from '../crypto.ts';
import { getHealthSummary } from '../db.ts';
import type { Env } from '../types.ts';

export const healthRoutes = new Hono<{ Bindings: Env }>();

export type HealthResponse = {
  ok: boolean;
  database: 'ok' | 'error';
  accounts: {
    active: number;
    needs_reconnect: number;
  };
  last_cron_ok_at: number | null;
  last_poll_ok_at: number | null;
};

healthRoutes.get('/', async (c) => {
  const now = nowSeconds();

  try {
    const summary = await getHealthSummary(c.env.DB, now);

    const cronStale = summary.lastCronOkAt == null || now - summary.lastCronOkAt > CRON_STALE_SECONDS;
    const ok = !cronStale;

    const body: HealthResponse = {
      ok,
      database: 'ok',
      accounts: {
        active: summary.activeAccounts,
        needs_reconnect: summary.needsReconnectAccounts,
      },
      last_cron_ok_at: summary.lastCronOkAt,
      last_poll_ok_at: summary.lastPollOkAt,
    };

    return c.json(body, ok ? 200 : 503);
  } catch (err) {
    console.error('health check failed', err instanceof Error ? err.message : err);
    const body: HealthResponse = {
      ok: false,
      database: 'error',
      accounts: {
        active: 0,
        needs_reconnect: 0,
      },
      last_cron_ok_at: null,
      last_poll_ok_at: null,
    };
    return c.json(body, 503);
  }
});
