import { Hono } from 'hono';
import { CRON_STALE_SECONDS, nowSeconds } from '../crypto.ts';
import { listAccounts, systemGet } from '../db.ts';
import type { Env } from '../types.ts';

/**
 * How long the five-minute reconciliation poll may be silent before it counts
 * as stale. Generous relative to its schedule: Cloudflare does not guarantee a
 * cron fires on the minute, and a monitor that pages on one skipped run is a
 * monitor an operator learns to ignore.
 */
export const POLL_STALE_SECONDS = 30 * 60;

export type HealthReport = {
  ok: boolean;
  database: 'ok' | 'error';
  accounts: { active: number; needs_reconnect: number };
  last_cron_ok_at: number | null;
  last_poll_ok_at: number | null;
};

function readTimestamp(raw: string | null): number | null {
  if (raw == null) return null;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

function isStale(at: number | null, within: number, now: number): boolean {
  // Never having run is stale. A fresh deployment is briefly unhealthy by this
  // rule, which is correct: nothing has proven the job works yet.
  if (at == null) return true;
  return now - at > within;
}

/**
 * Build the report.
 *
 * Separated from the route so the health rules can be tested without a Worker,
 * a request, or a live D1 instance.
 */
export function buildHealthReport(input: {
  databaseOk: boolean;
  activeAccounts: number;
  needsReconnect: number;
  lastCronOkAt: number | null;
  lastPollOkAt: number | null;
  now: number;
}): HealthReport {
  const cronStale = isStale(input.lastCronOkAt, CRON_STALE_SECONDS, input.now);
  const pollStale = isStale(input.lastPollOkAt, POLL_STALE_SECONDS, input.now);

  return {
    ok: input.databaseOk && !cronStale && !pollStale,
    database: input.databaseOk ? 'ok' : 'error',
    accounts: { active: input.activeAccounts, needs_reconnect: input.needsReconnect },
    last_cron_ok_at: input.lastCronOkAt,
    last_poll_ok_at: input.lastPollOkAt,
  };
}

export const healthRoutes = new Hono<{ Bindings: Env }>();

/**
 * `GET /health` — unauthenticated, for an uptime monitor.
 *
 * **Nothing here identifies anyone.** The response is booleans, two small
 * integers and two timestamps. No username, no `ig_user_id`, no secret, no
 * value derived from `ADMIN_URL_SECRET`, and no error text from the database —
 * a D1 failure message can carry a query, so the body says only `"error"` and
 * the detail stays in the Worker log.
 *
 * Two queries at most, both already used elsewhere, so a monitor polling every
 * 30 seconds stays inside a free-tier budget.
 */
healthRoutes.get('/health', async (c) => {
  const now = nowSeconds();

  let databaseOk = true;
  let activeAccounts = 0;
  let needsReconnect = 0;
  let lastCronOkAt: number | null = null;
  let lastPollOkAt: number | null = null;

  try {
    const accounts = await listAccounts(c.env.DB);
    activeAccounts = accounts.filter((a) => a.active === 1).length;
    needsReconnect = accounts.filter(
      (a) => a.needs_reconnect === 1 || a.token_expires_at <= now,
    ).length;

    lastCronOkAt = readTimestamp(await systemGet(c.env.DB, 'last_cron_ok_at'));
    lastPollOkAt = readTimestamp(await systemGet(c.env.DB, 'last_poll_ok_at'));
  } catch (err) {
    // The reason is worth having, but only where an operator can see it.
    console.error('health: database unreachable', err);
    databaseOk = false;
  }

  const report = buildHealthReport({
    databaseOk,
    activeAccounts,
    needsReconnect,
    lastCronOkAt,
    lastPollOkAt,
    now,
  });

  c.header('X-Robots-Tag', 'noindex');
  c.header('Cache-Control', 'no-store, max-age=0');
  return c.json(report, report.ok ? 200 : 503);
});
