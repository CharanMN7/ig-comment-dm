import {
  TOKEN_LOOKAHEAD_SECONDS,
  TOKEN_MIN_AGE_SECONDS,
  RECONNECT_WARN_SECONDS,
  decryptAesGcm,
  encryptAesGcm,
  nowSeconds,
} from './crypto.ts';
import { accountsNeedingRefresh, flagNeedsReconnect, listAccounts, systemSet, updateAccountToken } from './db.ts';
import { refreshLongLived, subscribeCommentWebhooks } from './meta.ts';
import type { Env } from './types.ts';

export async function ensureCommentSubscriptions(env: Env): Promise<void> {
  const accounts = await listAccounts(env.DB);
  for (const account of accounts) {
    if (account.active !== 1) continue;
    try {
      const token = await decryptAesGcm(env.TOKEN_ENCRYPTION_KEY, account.token_iv, account.access_token_enc);
      const res = await subscribeCommentWebhooks(token);
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
 */
export async function runCron(env: Env): Promise<void> {
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

    const result = await refreshLongLived(token);
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

  await systemSet(env.DB, 'last_cron_ok_at', String(nowSeconds()));
}
