import {
  TOKEN_LOOKAHEAD_SECONDS,
  TOKEN_MIN_AGE_SECONDS,
  RECONNECT_WARN_SECONDS,
  decryptAesGcm,
  encryptAesGcm,
  nowSeconds,
} from './crypto.ts';
import {
  NO_SENDS,
  type TotalsSnapshot,
  accountsNeedingRefresh,
  addTotals,
  failStalePending,
  flagNeedsReconnect,
  listAccounts,
  pruneWebhookEvents,
  readTotalsSnapshot,
  sendTotals,
  sendTotalsByAccount,
  systemSet,
  updateAccountToken,
  writeTotalsSnapshot,
} from './db.ts';
import { refreshLongLived, subscribeCommentWebhooks } from './meta.ts';
import type { Env } from './types.ts';

/**
 * A send makes at most two Meta calls (DM, then public reply), so it ends
 * within 2 x META_CALL_MAX_MS, about 65 s. A row still `pending` long after
 * that was claimed by a Worker stopped mid-send: waitUntil's 30 s cap, a
 * deploy, a crash. scripts/test-unit.ts keeps this above 10x that bound.
 */
export const STALE_PENDING_SECONDS = 15 * 60;

export const STALE_PENDING_ERROR =
  'The Worker stopped before this send finished. The DM may or may not have gone out, so it was not tried again.';

export const EMPTY_SNAPSHOT: TotalsSnapshot = { cutoff: 0, all: NO_SENDS, accounts: {} };

/**
 * Fails stuck sends, then folds every row older than STALE_PENDING_SECONDS
 * into the stored all-time totals. The sweep comes first because it is the
 * only thing that changes a row without moving its sent_at forward: once it
 * has run, nothing before its cutoff can change, so counts up to there stay
 * true. Both read only the rows since the previous snapshot, so only the first
 * run reads the whole table.
 */
export async function snapshotTotals(db: D1Database, now: number): Promise<TotalsSnapshot> {
  const previous = (await readTotalsSnapshot(db)) ?? EMPTY_SNAPSHOT;
  const cutoff = now - STALE_PENDING_SECONDS;
  if (cutoff <= previous.cutoff) return previous;
  await failStalePending(db, previous.cutoff, cutoff, STALE_PENDING_ERROR);
  const span = [{ from: previous.cutoff, to: cutoff, firstReach: true }];
  const [added = NO_SENDS] = await sendTotals(db, span);
  const accounts = { ...previous.accounts };
  for (const [id, [t = NO_SENDS]] of await sendTotalsByAccount(db, span)) {
    accounts[id] = addTotals(accounts[id] ?? NO_SENDS, t);
  }
  const next = { cutoff, all: addTotals(previous.all, added), accounts };
  await writeTotalsSnapshot(db, next);
  return next;
}

export async function ensureCommentSubscriptions(env: Env): Promise<void> {
  const accounts = await listAccounts(env.DB);
  for (const account of accounts) {
    if (account.active !== 1) continue;
    try {
      const token = await decryptAesGcm(env.TOKEN_ENCRYPTION_KEY, account.token_iv, account.access_token_enc);
      const res = await subscribeCommentWebhooks(account.ig_user_id, token);
      if (!res.ok) console.error('subscribed_apps failed', account.ig_user_id, res.status, res.body);
    } catch (err) {
      console.error('subscribed_apps failed', account.ig_user_id, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Daily token refresh. Idempotent: running it five times in a day is harmless.
 * Cloudflare cron has no retries, so we select tokens expiring within 10 days
 * (about ten chances) and skip anything refreshed in the last 24 hours.
 * Paused accounts are refreshed too: pausing stops DMs, and a token left
 * alone for 60 days can't be refreshed at all.
 */
export async function runCron(env: Env): Promise<void> {
  // Daily is enough: a stuck row already blocks a resend, so waiting only
  // delays its label, and Home counts the rows since the snapshot live. First,
  // so a slow Meta call can't keep it from running.
  try {
    await snapshotTotals(env.DB, nowSeconds());
  } catch (err) {
    console.error('snapshot send totals failed', err instanceof Error ? err.message : err);
  }
  await ensureCommentSubscriptions(env);
  const now = nowSeconds();
  const accounts = await accountsNeedingRefresh(env.DB, now + TOKEN_LOOKAHEAD_SECONDS);

  for (const account of accounts) {
    const tokenAgeBase = account.last_refreshed_at ?? account.connected_at;
    if (now - tokenAgeBase < TOKEN_MIN_AGE_SECONDS) continue;

    let token: string;
    try {
      token = await decryptAesGcm(env.TOKEN_ENCRYPTION_KEY, account.token_iv, account.access_token_enc);
    } catch (err) {
      console.error('cron decrypt failed', account.ig_user_id, err);
      if (account.token_expires_at - now < RECONNECT_WARN_SECONDS) {
        await flagNeedsReconnect(env.DB, account.ig_user_id);
      }
      continue;
    }

    // A network failure throws rather than returning a result. Uncaught, it
    // ended the whole run: later accounts went unrefreshed and last_cron_ok_at
    // unwritten, and Cloudflare does not retry a cron.
    const result = await refreshLongLived(token).catch((err: unknown) => ({
      ok: false as const,
      status: 0,
      body: err instanceof Error ? err.message : String(err),
    }));
    if (result.ok) {
      const enc = await encryptAesGcm(env.TOKEN_ENCRYPTION_KEY, result.access_token);
      await updateAccountToken(
        env.DB,
        account.ig_user_id,
        enc.ciphertext,
        enc.iv,
        now + result.expires_in,
        now,
      );
      continue;
    }

    console.error('cron refresh failed', account.ig_user_id, result.status, result.body);
    if (account.token_expires_at - now < RECONNECT_WARN_SECONDS) {
      await flagNeedsReconnect(env.DB, account.ig_user_id);
    }
  }

  try {
    await pruneWebhookEvents(env.DB, nowSeconds() - 7 * 24 * 60 * 60);
  } catch (err) {
    console.error('prune webhook_events failed', err instanceof Error ? err.message : err);
  }
  await systemSet(env.DB, 'last_cron_ok_at', String(nowSeconds()));
}
