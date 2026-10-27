import { systemGet, systemSet } from './db.ts';
import { plural } from './html.ts';

/**
 * The admin panel is on the open internet and its second factor is a password a
 * human chose, with an 8-character floor. The path secret makes the panel hard
 * to *find*, but once someone has the URL — a leaked bookmark, a screenshot, a
 * shoulder-surfed browser — nothing stopped them from posting the login form a
 * few thousand times a minute.
 *
 * Cloudflare's Rate Limiting binding is not on the free tier, so this counts in
 * D1. Two rows in `system`, no new table, no per-request cost on the webhook
 * path. Backoff doubles from one minute and caps at an hour, which is slow
 * enough to make guessing pointless and short enough that a legitimate operator
 * who fat-fingered their password five times is not locked out for the evening.
 */
export const FREE_ATTEMPTS = 5;
const BASE_LOCK_SECONDS = 60;
const MAX_LOCK_SECONDS = 60 * 60;

const FAILS_KEY = 'login_fail_count';
const LOCKED_UNTIL_KEY = 'login_locked_until';

export type ThrottleState = {
  fails: number;
  lockedUntil: number;
};

function toInt(value: string | null): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function lockSecondsFor(fails: number): number {
  // FREE_ATTEMPTS is a count of attempts, not an index: the fifth wrong
  // password is still free, the sixth is the first to wait.
  if (fails <= FREE_ATTEMPTS) return 0;
  const over = fails - FREE_ATTEMPTS - 1;
  return Math.min(BASE_LOCK_SECONDS * 2 ** over, MAX_LOCK_SECONDS);
}

export async function readThrottle(db: D1Database): Promise<ThrottleState> {
  const [fails, lockedUntil] = await Promise.all([
    systemGet(db, FAILS_KEY),
    systemGet(db, LOCKED_UNTIL_KEY),
  ]);
  return { fails: toInt(fails), lockedUntil: toInt(lockedUntil) };
}

/** Seconds remaining on the lock, or 0 if login is currently allowed. */
export function lockRemaining(state: ThrottleState, now: number): number {
  return state.lockedUntil > now ? state.lockedUntil - now : 0;
}

export type Reservation = {
  allowed: boolean;
  /**
   * Seconds left on the lock: the one this attempt started, if it was the one
   * to cross the line, or the one that refused it.
   */
  lock: number;
};

/**
 * Claims one password check before the password is hashed, or refuses it.
 *
 * Counting a failure only after the hash meant attempts sent in parallel all
 * read "unlocked" before any of them was counted, so none of them was held
 * back. Here the count goes up, and the lock it earns is written, in one D1
 * batch, which runs as a single transaction that no other request's
 * statements can interleave with. Every attempt sees the ones that claimed a
 * check before it, and parallel attempts get the same five free tries plus
 * one as attempts sent one at a time.
 *
 * An attempt that turns out right clears the count; a wrong one has already
 * been counted. Attempts refused while locked count for nothing, so the wait
 * doubles only for wrong passwords tried after it ends.
 */
export async function reserveAttempt(db: D1Database, now: number): Promise<Reservation> {
  const unlocked = `COALESCE((SELECT CAST(value AS INTEGER) FROM system WHERE key = ?2), 0) <= ?3`;
  const [, claimed, , locked] = await db.batch<{ value: string | number }>([
    db.prepare(`INSERT OR IGNORE INTO system (key, value) VALUES (?, '0')`).bind(FAILS_KEY),
    db
      .prepare(
        `UPDATE system SET value = CAST(value AS INTEGER) + 1
         WHERE key = ?1 AND ${unlocked}
         RETURNING value`,
      )
      .bind(FAILS_KEY, LOCKED_UNTIL_KEY, now),
    // lockSecondsFor in SQL, so the lock lands in the same transaction as the
    // count that earned it. The shift is capped so it can't overflow, and the
    // cast is there because D1 binds every JS number as a REAL.
    db
      .prepare(
        `INSERT INTO system (key, value)
         SELECT ?2, CAST(?3 + MIN(?5 << MIN(fails - ?4 - 1, 30), ?6) AS INTEGER)
         FROM (SELECT CAST(value AS INTEGER) AS fails FROM system WHERE key = ?1)
         WHERE fails > ?4 AND ${unlocked}
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .bind(FAILS_KEY, LOCKED_UNTIL_KEY, now, FREE_ATTEMPTS, BASE_LOCK_SECONDS, MAX_LOCK_SECONDS),
    db.prepare(`SELECT value FROM system WHERE key = ?`).bind(LOCKED_UNTIL_KEY),
  ]);
  const lock = lockRemaining({ fails: 0, lockedUntil: toInt(String(locked?.results[0]?.value ?? '')) }, now);
  return { allowed: (claimed?.results.length ?? 0) > 0, lock };
}

export async function clearFailures(db: D1Database): Promise<void> {
  await systemSet(db, FAILS_KEY, '0');
  await systemSet(db, LOCKED_UNTIL_KEY, '0');
}

export function describeLock(seconds: number): string {
  // Rounded up, so the page never promises a wait shorter than the real one.
  if (seconds > 60) return `${Math.ceil(seconds / 60)} minutes`;
  return `${seconds} ${plural(seconds, 'second', 'seconds')}`;
}
