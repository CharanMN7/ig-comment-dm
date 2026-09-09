import { Hono } from 'hono';
import { CRON_STALE_SECONDS, nowSeconds } from '../crypto.ts';
import { countAccountHealth, systemGet } from '../db.ts';
import type { Env } from '../types.ts';

/**
 * How long the five-minute reconciliation poll may be silent before it counts
 * as stale. Generous relative to its schedule: Cloudflare does not guarantee a
 * cron fires on the minute, and a monitor that pages on one skipped run is a
 * monitor an operator learns to ignore.
 */
export const POLL_STALE_SECONDS = 30 * 60;

export type HealthStatus = 'ok' | 'starting' | 'error';

export type HealthReport = {
  ok: boolean;
  status: HealthStatus;
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

function isStale(at: number, within: number, now: number): boolean {
  return now - at > within;
}

/**
 * Build the report.
 *
 * Separated from the route so the health rules can be tested without a Worker,
 * a request, or a live D1 instance.
 *
 * Three states, not two. A job that has run and then gone quiet is a real
 * outage — `error`, `503`. A job that has *never* run is a different thing, and
 * on a clean deploy it is the normal thing: the nightly cron is on `0 3 * * *`,
 * so for up to a day there is no timestamp to be recent. Reporting that as
 * `503` means the first thing an operator's monitor does on a fresh deploy is
 * page them for nothing, which is how a monitor gets ignored. So it is
 * `starting`, and `200`.
 *
 * `starting` is bounded rather than open-ended: the five-minute poll only gets
 * that benefit of the doubt while the nightly has also never run. Once the
 * nightly has fired, the Worker has demonstrably been alive for a day, and a
 * poll with no timestamp is then a genuine failure.
 */
export function buildHealthReport(input: {
  databaseOk: boolean;
  activeAccounts: number;
  needsReconnect: number;
  lastCronOkAt: number | null;
  lastPollOkAt: number | null;
  now: number;
}): HealthReport {
  const cronRan = input.lastCronOkAt != null;
  const pollRan = input.lastPollOkAt != null;

  const cronStale = cronRan && isStale(input.lastCronOkAt as number, CRON_STALE_SECONDS, input.now);
  const pollStale = pollRan && isStale(input.lastPollOkAt as number, POLL_STALE_SECONDS, input.now);

  // A poll that has never run is only "not yet" while nothing else has run
  // either. If the nightly has fired, the Worker has been up for a day and the
  // five-minute poll has had ~288 chances.
  const pollNeverRanButShouldHave = !pollRan && cronRan;

  let status: HealthStatus;
  if (!input.databaseOk || cronStale || pollStale || pollNeverRanButShouldHave) {
    status = 'error';
  } else if (!cronRan || !pollRan) {
    status = 'starting';
  } else {
    status = 'ok';
  }

  return {
    ok: status === 'ok',
    status,
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
 * Three small queries, none of which reads a token column, so a monitor polling
 * every 60 seconds stays inside a free-tier budget.
 *
 * `503` only for `status: "error"`. `starting` answers `200`, because a monitor
 * should not page for a deploy that is merely young.
 */
healthRoutes.get('/health', async (c) => {
  const now = nowSeconds();

  let databaseOk = true;
  let activeAccounts = 0;
  let needsReconnect = 0;
  let lastCronOkAt: number | null = null;
  let lastPollOkAt: number | null = null;

  try {
    const counts = await countAccountHealth(c.env.DB, now);
    activeAccounts = counts.active;
    needsReconnect = counts.needsReconnect;

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
  return c.json(report, report.status === 'error' ? 503 : 200);
});
