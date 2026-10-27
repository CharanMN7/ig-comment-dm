import { COMMENT_MAX_AGE_SECONDS, decryptAesGcm, nowSeconds } from './crypto.ts';
import { knownComments, listAccounts, listActiveRules, systemGet, systemSetAll } from './db.ts';
import { isSelfComment } from './guard.ts';
import { hasTimeForCall, listMediaComments, listRecentMedia } from './meta.ts';
import { admitComment } from './queue.ts';
import type { Subrequests } from './subrequests.ts';
import type { Env } from './types.ts';

const LOOKBACK_SECONDS = 72 * 60 * 60;
// Each post read is a subrequest, out of the 50 an invocation is allowed.
export const MAX_MEDIA_PER_ACCOUNT = 3;
// Rules on all posts are polled on the newest ones, which are still collecting comments.
export const RECENT_MEDIA_FOR_ALL_POSTS = 3;
const MAX_PROCESS_PER_SWEEP = 10;

/**
 * The poll runs in the scheduled handler, not in waitUntil, so it has
 * Cloudflare's 15 minutes rather than 30 seconds. It still stops reading
 * after this, which ends a slow sweep before the next one begins. Comments it
 * doesn't reach have no row, so the next sweep picks them up.
 */
export const POLL_BUDGET_MS = 4 * 60 * 1000;

/**
 * The posts one sweep reads, out of all the posts an account's rules cover:
 * every one when they fit, otherwise the next `size` after the post the last
 * sweep finished on, wrapping round. However many rules there are, each post
 * is then read at least every ceil(n / size) sweeps. Taking the first `size`
 * every time left a fourth post never read at all.
 */
export function pollWindow(candidates: readonly string[], after: string | null, size: number): string[] {
  if (candidates.length <= size) return [...candidates];
  // A post that is no longer a candidate (indexOf -1) restarts from the top.
  const start = after == null ? 0 : candidates.indexOf(after) + 1;
  return Array.from({ length: size }, (_, i) => candidates[(start + i) % candidates.length] as string);
}

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
  // Written with last_poll_ok_at in one batch, so moving them costs nothing extra.
  const cursors: Array<[string, string]> = [];
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
    if (rules.some((r) => !r.media_id)) {
      try {
        const recent = await listRecentMedia(token, subrequests);
        for (const item of recent.slice(0, RECENT_MEDIA_FOR_ALL_POSTS)) {
          if (!mediaIds.includes(item.id)) mediaIds.push(item.id);
        }
      } catch (err) {
        console.error('poll list media failed', account.ig_user_id, err instanceof Error ? err.message : err);
      }
    }

    // Kept per account. A post counts as read once its comments have all been
    // looked at, so one cut short by the caps is where the next sweep starts.
    const cursorKey = `poll_cursor:${account.ig_user_id}`;
    const rotating = mediaIds.length > MAX_MEDIA_PER_ACCOUNT;
    const startAfter = rotating && !done() && subrequests.take(1) ? await systemGet(env.DB, cursorKey) : null;
    let lastRead = startAfter;

    for (const mediaId of pollWindow(mediaIds, startAfter, MAX_MEDIA_PER_ACCOUNT)) {
      if (done()) break;
      let comments;
      try {
        comments = await listMediaComments(token, mediaId, subrequests);
      } catch (err) {
        console.error('poll list comments failed', mediaId, err instanceof Error ? err.message : err);
        lastRead = mediaId;
        continue;
      }
      const fresh = comments.filter((comment) => {
        const ts = commentUnix(comment.timestamp);
        if (ts != null && (ts < since || now - ts > COMMENT_MAX_AGE_SECONDS)) return false;
        return !isSelfComment(comment.from?.id, account.ig_user_id);
      });
      if (fresh.length === 0) {
        lastRead = mediaId;
        continue;
      }
      // One read for the page, rather than one per comment: most of a busy
      // post's comments were handled by the webhook or an earlier sweep.
      if (done() || !subrequests.take(1)) continue;
      const known = await knownComments(env.DB, fresh.map((c) => c.id));

      let cutShort = false;
      for (const comment of fresh) {
        if (done()) {
          cutShort = true;
          break;
        }
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
      if (!cutShort) lastRead = mediaId;
    }
    if (rotating && lastRead != null && lastRead !== startAfter) cursors.push([cursorKey, lastRead]);
  }

  subrequests.take(1);
  await systemSetAll(env.DB, [...cursors, ['last_poll_ok_at', String(nowSeconds())]]);
}
