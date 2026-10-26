import {
  TOKEN_LOOKAHEAD_SECONDS,
  TOKEN_MIN_AGE_SECONDS,
  RECONNECT_WARN_SECONDS,
  decryptAesGcm,
  encryptAesGcm,
  nowSeconds,
} from './crypto.ts';
import {
  accountsNeedingRefresh,
  failStalePending,
  flagNeedsReconnect,
  listAccounts,
  pruneWebhookEvents,
  systemSet,
  updateAccountToken,
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
  // Daily, not every 5 minutes: `sent` gains a row per comment, is never
  // pruned and has no index on dm_status, so this is a full scan. Once a day
  // costs about one Home visit; 288 times a day could use up the free plan's
  // D1 reads. A stuck row already blocks a resend, so waiting only delays its
  // label. First, so a slow Meta call can't keep it from running.
  try {
    await failStalePending(env.DB, nowSeconds() - STALE_PENDING_SECONDS, STALE_PENDING_ERROR);
  } catch (err) {
    console.error('fail stale pending sends failed', err instanceof Error ? err.message : err);
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
