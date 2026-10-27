import {
  COMMENT_MAX_AGE_SECONDS,
  decryptAesGcm,
  nowSeconds,
} from './crypto.ts';
import {
  getAccount,
  listActiveRules,
  tryClaimComment,
  updateSent,
} from './db.ts';
import { isSelfComment } from './guard.ts';
import { type MatchVerdict, exclusionSkipReason, matchComment } from './match.ts';
import { type SendResult, hasTimeForCall, sendPrivateReply, sendPublicReply } from './meta.ts';
import { fillPlaceholders } from './placeholders.ts';
import { parsePublicReplies, pickReply } from './replies.ts';
import type { Env } from './types.ts';

/**
 * The webhook answers Meta first and handles the comments in waitUntil, which
 * Cloudflare stops 30 s after the response. A send cut off there leaves its row
 * `pending` until the daily job fails it. A DM and its public reply take up to
 * 10 s each, so every Meta call for one delivery has to end inside this, which
 * leaves the last few seconds for writing the outcome.
 */
export const WEBHOOK_SEND_BUDGET_MS = 25_000;

export const NO_TIME_FOR_PUBLIC_REPLY_ERROR =
  'public reply: no time was left to post it, because Instagram was slow to answer';

/** What the send log says about a DM or public reply that Instagram didn't confirm. */
export function sendError(what: 'DM' | 'public reply', result: SendResult): string {
  if (!('cause' in result)) return `${what}: ${result.body}`;
  const { cause, body } = result;
  if (result.outcome === 'not_started') return `${what}: ${cause}, so it wasn't sent`;
  const detail = body ? ` (${body})` : '';
  return what === 'DM'
    ? `DM: ${cause}, so it may have been delivered. It wasn't sent again, so it can't arrive twice.${detail}`
    : `public reply: ${cause}, so it may have been posted. It wasn't posted again, so it can't appear twice.${detail}`;
}

type CommentValue = {
  id?: string | number;
  comment_id?: string | number;
  text?: string;
  from?: { id?: string | number; username?: string };
  /** `original_media_id` is set only on a comment left on an ad: the post the ad was made from. */
  media?: { id?: string | number; original_media_id?: string | number };
  media_id?: string | number;
};

type Change = { field?: string; value?: CommentValue };

type Entry = {
  id?: string | number;
  time?: number;
  field?: string;
  value?: CommentValue;
  changes?: Change[];
};

type WebhookBody = {
  object?: string;
  entry?: Entry[];
};

function asUnixSeconds(t: number): number {
  return t > 1e12 ? Math.floor(t / 1000) : t;
}

function asId(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  return String(value);
}

/**
 * Meta often sends 17-digit IDs as JSON numbers, which JS cannot represent exactly.
 *
 * Strings are matched first and kept whole. Otherwise a comment like
 * "order: 123456789012345 thanks" had quotes inserted into its text, the
 * result was not JSON, and the fallback below rounded every id in the payload.
 */
export function parseWebhookPayload(raw: string): unknown {
  const quoted = raw.replace(
    /"(?:[^"\\]|\\.)*"|(:\s*)(-?\d{15,})(?=\s*[,}\]])/g,
    (match: string, colon: string | undefined, digits: string | undefined) =>
      digits ? `${colon}"${digits}"` : match,
  );
  try {
    return JSON.parse(quoted);
  } catch {
    return JSON.parse(raw);
  }
}

function commentIdOf(value: CommentValue): string | undefined {
  return asId(value.id) || asId(value.comment_id);
}

function changesOf(entry: Entry): Change[] {
  if (Array.isArray(entry.changes) && entry.changes.length > 0) return entry.changes;
  if (entry.field && entry.value) return [{ field: entry.field, value: entry.value }];
  return [];
}

/**
 * `deadline` (epoch ms) is shared by every comment in the delivery, because
 * waitUntil's limit covers all of them together, not each one.
 */
export async function processWebhook(env: Env, payload: unknown, deadline: number): Promise<void> {
  const bodies = Array.isArray(payload) ? payload : [payload];
  for (const item of bodies) {
    const body = item as WebhookBody;
    const entries = Array.isArray(body.entry) ? body.entry : [];
    for (const entry of entries) {
      for (const change of changesOf(entry)) {
        if (change.field !== 'comments') continue;
        const entryId = asId(entry.id);
        if (!change.value || !entryId) continue;
        try {
          await processComment(env, entryId, entry.time, change.value, deadline);
        } catch (err) {
          console.error('comment processing failed', err instanceof Error ? err.message : err);
        }
      }
    }
  }
}

/**
 * The one place a comment is matched to a rule. The admin Test page calls it
 * too, so a dry run can never name a different rule from the one a real
 * comment fires.
 */
export async function chooseRule(
  db: D1Database,
  igUserId: string,
  text: string,
  mediaId: string | undefined,
  originalMediaId?: string,
): Promise<MatchVerdict> {
  return matchComment(await listActiveRules(db, igUserId), text, mediaId, originalMediaId);
}

/**
 * `deadline` (epoch ms) is when every Meta call for this comment must have
 * ended, so the outcome is written before the runtime stops the Worker.
 *
 * Resolves true when this call claimed the comment, and so sent to it or
 * recorded why not, and false when it left the comment alone. The poll's
 * per-sweep cap counts only the first.
 */
export async function processComment(
  env: Env,
  entryId: string,
  entryTime: number | undefined,
  value: CommentValue,
  deadline: number,
): Promise<boolean> {
  const account = await getAccount(env.DB, entryId);
  if (!account || account.active !== 1) {
    console.error('no active account for webhook entry', entryId);
    return false;
  }

  const commenterId = asId(value.from?.id) ?? null;
  if (isSelfComment(commenterId, account.ig_user_id)) {
    console.log('ignored self-comment', commentIdOf(value));
    return false;
  }

  const commentId = commentIdOf(value);
  if (!commentId) return false;

  const now = nowSeconds();
  const text = value.text ?? '';
  const mediaId = asId(value.media?.id) ?? asId(value.media_id);
  const originalMediaId = asId(value.media?.original_media_id);

  if (entryTime != null) {
    const ts = asUnixSeconds(entryTime);
    if (now - ts > COMMENT_MAX_AGE_SECONDS) {
      return tryClaimComment(env.DB, {
        comment_id: commentId,
        ig_user_id: account.ig_user_id,
        commenter_id: commenterId,
        dm_status: 'skipped',
        error: 'comment older than 7 days — Instagram will not accept a private reply',
        sent_at: now,
      });
    }
  }

  // A claimed comment is never tried again, so claim only one there is time
  // to send. Left unclaimed, it is still open to the 5-minute poll.
  if (!hasTimeForCall(deadline)) {
    console.error('no time left to send; leaving the comment for the poll', commentId);
    return false;
  }

  const claimed = await tryClaimComment(env.DB, {
    comment_id: commentId,
    ig_user_id: account.ig_user_id,
    commenter_id: commenterId,
    dm_status: 'pending',
    error: null,
    sent_at: now,
  });
  if (!claimed) return false;

  const { match, excluded } = await chooseRule(env.DB, account.ig_user_id, text, mediaId, originalMediaId);
  if (!match) {
    // When several rules were excluded, the first in matching order is the one
    // that would have fired, so that is the rule and the reason Home shows.
    const passedOver = excluded[0];
    await updateSent(env.DB, commentId, {
      rule_id: passedOver?.rule.id ?? null,
      dm_status: 'skipped',
      reply_status: null,
      error: passedOver ? exclusionSkipReason(passedOver) : 'no matching rule',
      sent_at: nowSeconds(),
    });
    return true;
  }
  const { rule } = match;

  // Both webhook and poll payloads carry the name on `from`. When Instagram
  // leaves it out, the text still goes, with `{username}` tidied away.
  const username = value.from?.username;
  const dmText = fillPlaceholders(rule.dm_text, username);
  const reply = pickReply(parsePublicReplies(rule.public_reply_text));
  const publicText = reply ? fillPlaceholders(reply, username) : '';

  let token: string;
  try {
    token = await decryptAesGcm(env.TOKEN_ENCRYPTION_KEY, account.token_iv, account.access_token_enc);
  } catch (err) {
    await updateSent(env.DB, commentId, {
      rule_id: rule.id,
      dm_status: 'failed',
      reply_status: publicText ? 'skipped' : null,
      error: `could not decrypt access token: ${err instanceof Error ? err.message : 'unknown'}`,
      sent_at: nowSeconds(),
    });
    return true;
  }

  const dm = await sendPrivateReply(account.ig_user_id, token, commentId, dmText, deadline);
  const dmSent = dm.outcome === 'sent';
  let replyStatus: string | null = null;
  const errors: string[] = [];

  if (!dmSent) errors.push(sendError('DM', dm));

  if (publicText) {
    if (dmSent && !hasTimeForCall(deadline)) {
      // Started anyway, the reply would be cut off with the Worker, leaving
      // the row `pending` with no record that the DM went out.
      replyStatus = 'failed';
      errors.push(NO_TIME_FOR_PUBLIC_REPLY_ERROR);
    } else if (dmSent) {
      const reply = await sendPublicReply(commentId, token, publicText, deadline);
      replyStatus = reply.outcome === 'sent' ? 'ok' : 'failed';
      if (reply.outcome !== 'sent') errors.push(sendError('public reply', reply));
    } else {
      // Public replies are usually "Sent you a DM!". Posting one when no DM
      // arrived tells the commenter, and everyone reading the thread, something
      // false.
      replyStatus = 'skipped';
    }
  }

  await updateSent(env.DB, commentId, {
    rule_id: rule.id,
    dm_status: dmSent ? 'ok' : 'failed',
    reply_status: replyStatus,
    error: errors.length ? errors.join('\n') : null,
    sent_at: nowSeconds(),
  });
  return true;
}
