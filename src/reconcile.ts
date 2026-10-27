import { COMMENT_MAX_AGE_SECONDS, decryptAesGcm, nowSeconds } from './crypto.ts';
import { knownComments, listAccounts, listActiveRules, systemSet } from './db.ts';
import { isSelfComment } from './guard.ts';
import { hasTimeForCall, listMediaComments, listRecentMedia } from './meta.ts';
import { admitComment } from './queue.ts';
import type { Subrequests } from './subrequests.ts';
import type { Env } from './types.ts';

const LOOKBACK_SECONDS = 72 * 60 * 60;
const MAX_MEDIA_PER_ACCOUNT = 3;
const MAX_PROCESS_PER_SWEEP = 10;

/**
 * The poll runs in the scheduled handler, not in waitUntil, so it has
 * Cloudflare's 15 minutes rather than 30 seconds. It still stops reading
 * after this, which ends a slow sweep before the next one begins. Comments it
 * doesn't reach have no row, so the next sweep picks them up.
 */
export const POLL_BUDGET_MS = 4 * 60 * 1000;

function commentUnix(timestamp: string | undefined): number | undefined {
  if (!timestamp) return undefined;
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return undefined;
  return Math.floor(ms / 1000);
}

/**
 * Instagram webhooks miss collapsed / low-signal comments, and in Development
 * they often never fire at all. Sweep recent comments and queue the ones a
 * rule matches through admitComment, so dedupe and matching are the
 * webhook's. The cron's drain, right after, sends them.
 */
export async function reconcileComments(env: Env, subrequests: Subrequests): Promise<void> {
  const now = nowSeconds();
  const since = now - LOOKBACK_SECONDS;
  const deadline = Date.now() + POLL_BUDGET_MS;
  if (!subrequests.take(1)) return;
  const accounts = await listAccounts(env.DB);
  let processed = 0;
  // Stops with one subrequest left, for recording the sweep.
  const done = () => processed >= MAX_PROCESS_PER_SWEEP || !hasTimeForCall(deadline) || subrequests.left < 2;

  for (const account of accounts) {
    if (account.active !== 1 || done()) continue;
    subrequests.take(1);
    const rules = await listActiveRules(env.DB, account.ig_user_id);
    if (rules.length === 0) continue;

    let token: string;
    try {
      token = await decryptAesGcm(env.TOKEN_ENCRYPTION_KEY, account.token_iv, account.access_token_enc);
    } catch (err) {
      console.error('poll decrypt failed', account.ig_user_id, err instanceof Error ? err.message : err);
      continue;
    }

    const mediaIds: string[] = [];
    for (const rule of rules) {
      if (rule.media_id && !mediaIds.includes(rule.media_id)) mediaIds.push(rule.media_id);
    }
    const anyPost = rules.some((r) => !r.media_id);
    if (anyPost && mediaIds.length < MAX_MEDIA_PER_ACCOUNT) {
      try {
        const recent = await listRecentMedia(token, subrequests);
        for (const item of recent) {
          if (mediaIds.includes(item.id)) continue;
          mediaIds.push(item.id);
          if (mediaIds.length >= MAX_MEDIA_PER_ACCOUNT) break;
        }
      } catch (err) {
        console.error('poll list media failed', account.ig_user_id, err instanceof Error ? err.message : err);
      }
    }

    for (const mediaId of mediaIds.slice(0, MAX_MEDIA_PER_ACCOUNT)) {
      if (done()) break;
      let comments;
      try {
        comments = await listMediaComments(token, mediaId, subrequests);
      } catch (err) {
        console.error('poll list comments failed', mediaId, err instanceof Error ? err.message : err);
        continue;
      }
      const fresh = comments.filter((comment) => {
        const ts = commentUnix(comment.timestamp);
        if (ts != null && (ts < since || now - ts > COMMENT_MAX_AGE_SECONDS)) return false;
        return !isSelfComment(comment.from?.id, account.ig_user_id);
      });
      // One read for the page, rather than one per comment: most of a busy
      // post's comments were handled by the webhook or an earlier sweep.
      if (fresh.length === 0 || done() || !subrequests.take(1)) continue;
      const known = await knownComments(env.DB, fresh.map((c) => c.id));

      for (const comment of fresh) {
        if (done()) break;
        if (known.has(comment.id)) continue;
        const ts = commentUnix(comment.timestamp);
        try {
          // For a boosted post, Instagram lists the ad's comments here along
          // with the post's own, so an ad comment is matched as the post's,
          // the same as the webhook does with `original_media_id`.
          const queued = await admitComment(env, account, rules, {
            id: comment.id,
            commenterId: comment.from?.id ?? null,
            text: comment.text,
            mediaId,
            username: comment.from?.username,
            at: ts,
          }, subrequests);
          // A comment the webhook already has a row for costs nothing, so it
          // mustn't use up the cap and leave real work for the next sweep.
          if (queued) processed += 1;
        } catch (err) {
          console.error('poll process failed', comment.id, err instanceof Error ? err.message : err);
        }
      }
    }
  }

  subrequests.take(1);
  await systemSet(env.DB, 'last_poll_ok_at', String(nowSeconds()));
}
