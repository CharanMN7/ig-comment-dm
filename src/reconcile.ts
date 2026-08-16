import { COMMENT_MAX_AGE_SECONDS, decryptAesGcm, nowSeconds } from './crypto.ts';
import { countSentByComment, listAccounts, listActiveRules, systemSet } from './db.ts';
import { isSelfComment } from './guard.ts';
import { findMatchingRule } from './match.ts';
import { listMediaComments, listRecentMedia } from './meta.ts';
import { processComment } from './process.ts';
import type { Env } from './types.ts';

const LOOKBACK_SECONDS = 72 * 60 * 60;
const MAX_MEDIA_PER_ACCOUNT = 3;
const MAX_PROCESS_PER_SWEEP = 10;

function commentUnix(timestamp: string | undefined): number | undefined {
  if (!timestamp) return undefined;
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return undefined;
  return Math.floor(ms / 1000);
}

/**
 * Instagram webhooks miss collapsed / low-signal comments, and in Development
 * they often never fire at all. Sweep recent comments and reuse processComment
 * so dedupe and sends match the webhook path.
 */
export async function reconcileComments(env: Env): Promise<void> {
  const now = nowSeconds();
  const since = now - LOOKBACK_SECONDS;
  const accounts = await listAccounts(env.DB);
  let processed = 0;

  for (const account of accounts) {
    if (account.active !== 1 || processed >= MAX_PROCESS_PER_SWEEP) continue;
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
        const recent = await listRecentMedia(token);
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
      if (processed >= MAX_PROCESS_PER_SWEEP) break;
      let comments;
      try {
        comments = await listMediaComments(token, mediaId);
      } catch (err) {
        console.error('poll list comments failed', mediaId, err instanceof Error ? err.message : err);
        continue;
      }

      for (const comment of comments) {
        if (processed >= MAX_PROCESS_PER_SWEEP) break;
        const ts = commentUnix(comment.timestamp);
        if (ts != null && (ts < since || now - ts > COMMENT_MAX_AGE_SECONDS)) continue;
        if (isSelfComment(comment.from?.id, account.ig_user_id)) continue;
        if (!findMatchingRule(rules, comment.text, mediaId)) continue;
        if ((await countSentByComment(env.DB, comment.id)) > 0) continue;
        try {
          await processComment(env, account.ig_user_id, ts, {
            id: comment.id,
            text: comment.text,
            from: comment.from,
            media: { id: mediaId },
          });
          processed += 1;
        } catch (err) {
          console.error('poll process failed', comment.id, err instanceof Error ? err.message : err);
        }
      }
    }
  }

  await systemSet(env.DB, 'last_poll_ok_at', String(nowSeconds()));
}
