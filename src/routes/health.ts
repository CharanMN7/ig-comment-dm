import { Hono } from 'hono';
import { CRON_STALE_SECONDS, POLL_STALE_SECONDS, nowSeconds } from '../crypto.ts';
import { HEALTH_FIRST_SEEN_KEY, healthSnapshot, systemSet } from '../db.ts';
import type { Env } from '../types.ts';

/**
 * This app fails silently: when the daily refresh stops running, nothing says so
 * until every token has expired, and the red banner only shows to someone who
 * opens the admin panel. An uptime monitor polling this route turns that into an
 * alert. The status code carries the verdict, so a monitor never parses the body.
 *
 * Anyone can call it, so the body holds fixed strings, small counts and
 * timestamps only: no account ids, usernames, or anything derived from a secret.
 */
export const healthRoutes = new Hono<{ Bindings: Env }>();

// The daily job runs at 03:00 UTC, so a new deploy sees its first run within a
// day. Two more hours absorb a slow trigger before a missing one counts.
export const CRON_FIRST_RUN_SECONDS = 26 * 60 * 60;

type JobState = 'ok' | 'starting' | 'stale';

// A job that has never run is "starting" for as long as its first run could
// still be on the way, and no longer, so a deploy whose triggers never fire
// still alerts instead of reporting healthy forever. The admin Home banner uses
// the same verdict, so the panel and a monitor never disagree.
export function jobState(
  lastOkAt: number | null,
  staleAfter: number,
  firstRunWithin: number,
  firstSeenAt: number,
  now: number,
): JobState {
  if (lastOkAt != null) return now - lastOkAt > staleAfter ? 'stale' : 'ok';
  return now - firstSeenAt > firstRunWithin ? 'stale' : 'starting';
}

healthRoutes.get('/', async (c) => {
  // A cached 200 would hide the very outage the monitor is polling for.
  c.header('Cache-Control', 'no-store');
  c.header('X-Robots-Tag', 'noindex');

  const now = nowSeconds();
  let snapshot;
  try {
    snapshot = await healthSnapshot(c.env.DB, now);
    // Written once, on the first check, as the clock for the "starting" grace.
    if (snapshot.firstSeenAt == null) await systemSet(c.env.DB, HEALTH_FIRST_SEEN_KEY, String(now));
  } catch (err) {
    console.error('health check: database did not answer', err instanceof Error ? err.message : err);
    return c.json({ ok: false, database: 'error' }, 503);
  }

  const firstSeenAt = snapshot.firstSeenAt ?? now;
  const cron = jobState(snapshot.lastCronOkAt, CRON_STALE_SECONDS, CRON_FIRST_RUN_SECONDS, firstSeenAt, now);
  const poll = jobState(snapshot.lastPollOkAt, POLL_STALE_SECONDS, POLL_STALE_SECONDS, firstSeenAt, now);
  const ok = cron !== 'stale' && poll !== 'stale';
  return c.json(
    {
      ok,
      database: 'ok',
      accounts: { active: snapshot.activeAccounts, needs_reconnect: snapshot.needsReconnect },
      cron,
      poll,
      last_cron_ok_at: snapshot.lastCronOkAt,
      last_poll_ok_at: snapshot.lastPollOkAt,
    },
    ok ? 200 : 503,
  );
});
