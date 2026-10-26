import { nowSeconds } from './crypto.ts';
import { systemGet, systemSet } from './db.ts';

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

export async function recordFailure(db: D1Database): Promise<number> {
  // Increment and lock in SQL, not read-then-write in the Worker. Wrong
  // passwords posted in parallel all read the same count, so five at once used
  // to count as one, and a later, shorter lock could overwrite a longer one.
  const row = await db
    .prepare(
      `INSERT INTO system (key, value) VALUES (?, '1')
       ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
       RETURNING value`,
    )
    .bind(FAILS_KEY)
    .first<{ value: string | number }>();
  const lock = lockSecondsFor(toInt(String(row?.value ?? '')));
  if (lock > 0) {
    await db
      .prepare(
        `INSERT INTO system (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER))`,
      )
      .bind(LOCKED_UNTIL_KEY, String(nowSeconds() + lock))
      .run();
  }
  return lock;
}

export async function clearFailures(db: D1Database): Promise<void> {
  await systemSet(db, FAILS_KEY, '0');
  await systemSet(db, LOCKED_UNTIL_KEY, '0');
}

export function describeLock(seconds: number): string {
  if (seconds >= 120) return `${Math.ceil(seconds / 60)} minutes`;
  if (seconds > 60) return 'a minute';
  return `${seconds} seconds`;
}
