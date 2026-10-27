import {
  COMMENT_MAX_AGE_SECONDS,
  QUEUE_EXPIRY_SECONDS,
  SENDS_PER_MINUTE,
  SEND_LEASE_SECONDS,
  decryptAesGcm,
  nowSeconds,
} from './crypto.ts';
import {
  type ClaimedSend,
  type DrainAccount,
  claimDueSends,
  claimQueuedExtraReply,
  extraReplyInsert,
  flagNeedsReconnectStatement,
  insertSend,
  insertSettled,
  holdSendsStatement,
  queuedExtraReplies,
  recordSend,
  refundSendsStatement,
  releaseSendsStatement,
  reserveSends,
  skipQueuedExtraReplies,
  sweepQueue,
  updateExtraReply,
} from './db.ts';
import { exclusionSkipReason, matchComment } from './match.ts';
import { type SendResult, classifyRefusal, hasTimeForCall, sendPrivateReply, sendPublicReply } from './meta.ts';
import { EXTRA_REPLY_NO_DM, EXTRA_REPLY_RULE_GONE, otherRuleSkipReason, planOtherRules } from './other-replies.ts';
import { fillPlaceholders } from './placeholders.ts';
import { parsePublicReplies, pickReply } from './replies.ts';
import { SUBREQUESTS_PER_INVOCATION, type Subrequests } from './subrequests.ts';
import type { Account, Env, Rule } from './types.ts';

/**
 * How long the cron spends sending each minute. Every attempt ends by then,
 * so a minute's sends are done before the next minute's start, and well
 * inside SEND_LEASE_SECONDS of their claim.
 */
export const DRAIN_BUDGET_MS = 40_000;

// What each step can spend, taken before it starts. A send is its DM, its
// public reply and the write of how they went, then, if other rules' replies
// wait on it, reading them and claiming, posting and recording each.
// Sending one straight from the webhook adds reserving its slot, writing its
// row, writing the other rules' rows, and giving the slot back if the DM
// never starts. Per account, the drain reserves slots, claims rows, and gives
// back what it didn't use.
const SEND_COST = 3;
export const SEND_NOW_COST = SEND_COST + 4;
const DRAIN_ACCOUNT_COST = 3;

function sendCost(extraReplies: number): number {
  return SEND_COST + (extraReplies > 0 ? 1 + 3 * extraReplies : 0);
}

export const NO_TIME_FOR_PUBLIC_REPLY_ERROR =
  'public reply: no time was left to post it, because Instagram was slow to answer';
export const OLD_COMMENT_ERROR = 'comment older than 7 days — Instagram will not accept a private reply';
export const ACCOUNT_PAUSED_REASON = 'account paused';
export const EXPIRED_ERROR =
  'Expired: the DM was still waiting its turn when the comment neared Instagram’s 7-day limit for private replies.';
export const LEASE_ERROR =
  "DM: the Worker stopped before this send finished, so it may have been delivered. It wasn't sent again, so it can't arrive twice.";
export const TOKEN_WAIT_NOTE = 'Waiting for Instagram to be reconnected: the access token stopped working.';
export const RULE_DELETED_ERROR = 'Skipped: the rule was deleted before its DM went out.';
export const RULE_OFF_ERROR = 'Skipped: the rule was turned off before its DM went out.';

/**
 * Tries for a DM Instagram turned down for now: rate limits and its own
 * temporary errors. Each waits longer than the last, and the fourth refusal
 * is final.
 */
export const MAX_ATTEMPTS = 4;
export const RETRY_BACKOFF_SECONDS = [60, 5 * 60, 20 * 60];
/** How long an account's DMs are held after Instagram says it's sending too fast, or its token stops working. */
export const PAUSE_SECONDS = 15 * 60;

export function minuteOf(seconds: number): number {
  return Math.floor(seconds / 60);
}

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

export type IncomingComment = {
  id: string;
  commenterId: string | null;
  text: string;
  mediaId: string | undefined;
  /** On a comment left on an ad, the post the ad was made from. */
  originalMediaId?: string;
  username: string | undefined;
  /** When it was made (unix seconds), if Instagram said. */
  at: number | undefined;
};

/**
 * The one way a comment gets a `sent` row. A comment no rule matches gets
 * none, which saves D1's daily write allowance for the comments that matter.
 * With `sendBy` (epoch ms), the DM goes out now if the account has a slot
 * left this minute and there's time before `sendBy`; otherwise the row waits
 * in the queue for the cron. Resolves true when this call wrote the row.
 */
export async function admitComment(
  env: Env,
  account: Account,
  rules: Rule[],
  comment: IncomingComment,
  subrequests: Subrequests,
  sendBy?: number,
): Promise<boolean> {
  const { match, also, excluded } = matchComment(rules, comment.text, comment.mediaId, comment.originalMediaId);
  if (!match && excluded.length === 0) return false;
  // When several rules were excluded, the first in matching order is the one
  // that would have fired, so that is the rule and the reason Home shows.
  const passedOver = excluded[0];
  const now = nowSeconds();
  const at = comment.at ?? now;
  const row = { comment_id: comment.id, ig_user_id: account.ig_user_id, commenter_id: comment.commenterId, now };

  // Paused means a matching comment gets no reply, not a late one. Without a
  // row, the poll would answer it, up to its 72-hour reach, as soon as the
  // account is resumed.
  const skip =
    now - at > COMMENT_MAX_AGE_SECONDS
      ? OLD_COMMENT_ERROR
      : account.active !== 1
        ? ACCOUNT_PAUSED_REASON
        : match
          ? null
          : exclusionSkipReason(passedOver!);
  if (skip || !match) {
    if (!subrequests.take(1)) return false;
    return insertSettled(env.DB, {
      ...row,
      rule_id: match?.rule.id ?? passedOver?.rule.id ?? null,
      dm_status: 'skipped',
      reply_status: null,
      error: skip ?? exclusionSkipReason(passedOver!),
    });
  }
  const { rule } = match;
  // Planned now, while the comment's text is at hand, and recorded with the
  // comment's row: `queued` for each reply that waits for the DM, `skipped`
  // with the reason for the rest.
  const others = planOtherRules(also);
  const posting = others.filter((o) => o.posts).length;
  const otherRows = (noDm: boolean) =>
    others.map((o) => {
      const reason = otherRuleSkipReason(o) ?? (noDm ? EXTRA_REPLY_NO_DM : null);
      return extraReplyInsert(env.DB, { comment_id: comment.id, rule_id: o.rule.id, status: reason ? 'skipped' : 'queued', error: reason, sent_at: now });
    });

  let token: string | null = null;
  if (sendBy !== undefined && hasTimeForCall(sendBy) && subrequests.take(SEND_NOW_COST - SEND_COST + sendCost(posting))) {
    try {
      token = await decryptAesGcm(env.TOKEN_ENCRYPTION_KEY, account.token_iv, account.access_token_enc);
    } catch (err) {
      const settled = await insertSettled(env.DB, {
        ...row,
        rule_id: rule.id,
        dm_status: 'failed',
        reply_status: rule.public_reply_text ? 'skipped' : null,
        error: `could not decrypt access token: ${err instanceof Error ? err.message : 'unknown'}`,
      });
      if (settled && others.length) await env.DB.batch(otherRows(true));
      return settled;
    }
  } else if (!subrequests.take(others.length ? 2 : 1)) {
    return false;
  }

  const minute = minuteOf(nowSeconds());
  const slot = token !== null && (await reserveSends(env.DB, account.ig_user_id, minute, 1, SENDS_PER_MINUTE, now)) === 1;
  const claimed = await insertSend(env.DB, {
    ...row,
    rule_id: rule.id,
    username: comment.username ?? null,
    comment_at: at,
    dm_status: slot ? 'pending' : 'queued',
    leaseUntil: now + SEND_LEASE_SECONDS,
  });
  if (claimed && others.length) await env.DB.batch(otherRows(false));
  if (slot && token !== null) {
    const called =
      claimed &&
      (await deliver(env.DB, token, {
        comment_id: comment.id,
        ig_user_id: account.ig_user_id,
        rule_id: rule.id,
        username: comment.username ?? null,
        comment_at: at,
        dm_text: rule.dm_text,
        public_reply_text: rule.public_reply_text,
        rule_active: rule.active,
        extra_replies: posting,
        attempts: 0,
      }, sendBy!)).called;
    if (!called) await refundSendsStatement(env.DB, account.ig_user_id, minute, 1).run();
  }
  return claimed;
}

/**
 * Whether the DM call was made, which is what the budget counts, and
 * whether Instagram's answer means the account should send nothing more for
 * now.
 */
type Delivery = { called: boolean; stop: boolean };

/**
 * Sends the DM, and the public reply after it, for a row the caller moved to
 * `pending`, and records how it went. A refusal that proves Instagram didn't
 * act, and that might not hold later, puts the row back in the queue to try
 * again; anything that leaves it unsure whether the DM went out never does.
 */
async function deliver(db: D1Database, token: string, row: ClaimedSend, deadline: number): Promise<Delivery> {
  const now = nowSeconds();
  const skip =
    row.dm_text == null
      ? RULE_DELETED_ERROR
      : row.rule_active !== 1
        ? RULE_OFF_ERROR
        : row.comment_at != null && now - row.comment_at > QUEUE_EXPIRY_SECONDS
          ? EXPIRED_ERROR
          : null;
  if (skip || row.dm_text == null) {
    await recordSend(db, row.comment_id, { dm_status: 'skipped', reply_status: null, error: skip, attempted: false, next_attempt_at: null, now });
    if (row.extra_replies > 0) await skipQueuedExtraReplies(db, row.comment_id, EXTRA_REPLY_NO_DM, now);
    return { called: false, stop: false };
  }

  // Both webhook and poll payloads carry the name on `from`, and the queue
  // keeps it. When Instagram leaves it out, the text still goes, with
  // `{username}` tidied away.
  const username = row.username ?? undefined;
  const dmText = fillPlaceholders(row.dm_text, username);
  const reply = pickReply(parsePublicReplies(row.public_reply_text));
  const publicText = reply ? fillPlaceholders(reply, username) : '';

  const dm = await sendPrivateReply(row.ig_user_id, token, row.comment_id, dmText, deadline);
  if (dm.outcome === 'not_started') {
    await releaseSendsStatement(db, [row.comment_id], nowSeconds()).run();
    return { called: false, stop: false };
  }
  const tries = row.attempts + 1;
  let gaveUp = false;
  if (dm.outcome === 'refused') {
    const refusal = classifyRefusal(dm.status, dm.body);
    const at = nowSeconds();
    if (refusal === 'token') {
      // Not counted as a try, since the token failed, not the send. It goes
      // back where it was, the account is held until it's reconnected, and
      // the queue's expiry still applies.
      await recordSend(db, row.comment_id, {
        dm_status: row.attempts > 0 ? 'retry' : 'queued',
        reply_status: null,
        error: `${TOKEN_WAIT_NOTE}\n${sendError('DM', dm)}`,
        attempted: false,
        next_attempt_at: row.comment_at ?? at,
        now: at,
      });
      await db.batch([flagNeedsReconnectStatement(db, row.ig_user_id), holdSendsStatement(db, row.ig_user_id, at + PAUSE_SECONDS, 'token')]);
      return { called: true, stop: true };
    }
    if ((refusal === 'rate' || refusal === 'transient') && tries < MAX_ATTEMPTS) {
      await recordSend(db, row.comment_id, {
        dm_status: 'retry',
        reply_status: null,
        error: sendError('DM', dm),
        attempted: true,
        next_attempt_at: at + RETRY_BACKOFF_SECONDS[tries - 1]!,
        now: at,
      });
      if (refusal === 'rate') await holdSendsStatement(db, row.ig_user_id, at + PAUSE_SECONDS, 'rate').run();
      return { called: true, stop: refusal === 'rate' };
    }
    gaveUp = refusal !== 'final';
  }

  const dmSent = dm.outcome === 'sent';
  let replyStatus: string | null = null;
  const errors: string[] = [];
  if (gaveUp) errors.push(`DM: Instagram turned it down ${MAX_ATTEMPTS} times, so it was given up on.`);
  if (!dmSent) errors.push(sendError('DM', dm));

  if (publicText) {
    if (dmSent && !hasTimeForCall(deadline)) {
      // Started anyway, the reply would be cut off with the Worker, leaving
      // the row `pending` with no record that the DM went out.
      replyStatus = 'failed';
      errors.push(NO_TIME_FOR_PUBLIC_REPLY_ERROR);
    } else if (dmSent) {
      const posted = await sendPublicReply(row.comment_id, token, publicText, deadline);
      replyStatus = posted.outcome === 'sent' ? 'ok' : 'failed';
      if (posted.outcome !== 'sent') errors.push(sendError('public reply', posted));
    } else {
      // Public replies are usually "Sent you a DM!". Posting one when no DM
      // arrived tells the commenter, and everyone reading the thread, something
      // false.
      replyStatus = 'skipped';
    }
  }

  await recordSend(db, row.comment_id, {
    dm_status: dmSent ? 'ok' : dm.outcome === 'unknown' ? 'unsure' : 'failed',
    reply_status: replyStatus,
    error: errors.length ? errors.join('\n') : null,
    attempted: true,
    next_attempt_at: null,
    now: nowSeconds(),
  });
  if (row.extra_replies > 0) await replyForOtherRules(db, row, dmSent ? token : null, deadline);
  return { called: true, stop: false };
}

/**
 * Runs after the comment's own row is final, so a Worker stopped here can't
 * leave a DM that went out looking unsent. `token` is null unless Instagram
 * confirmed the DM, and then nothing is posted, for the same reason the DM
 * rule's own reply isn't. A reply is posted only by whoever moves its row
 * from `queued` to `pending`, in one attempt, never again.
 */
async function replyForOtherRules(db: D1Database, row: ClaimedSend, token: string | null, deadline: number): Promise<void> {
  if (token === null) {
    await skipQueuedExtraReplies(db, row.comment_id, EXTRA_REPLY_NO_DM, nowSeconds());
    return;
  }
  for (const other of await queuedExtraReplies(db, row.comment_id)) {
    const reply = other.active === 1 ? pickReply(parsePublicReplies(other.public_reply_text)) : null;
    const settle = (status: string, error: string | null) =>
      updateExtraReply(db, row.comment_id, other.rule_id, { status, error, sent_at: nowSeconds() });
    if (reply === null) {
      await settle('skipped', EXTRA_REPLY_RULE_GONE);
      continue;
    }
    if (!hasTimeForCall(deadline)) {
      await settle('failed', NO_TIME_FOR_PUBLIC_REPLY_ERROR);
      continue;
    }
    if (!(await claimQueuedExtraReply(db, row.comment_id, other.rule_id, nowSeconds()))) continue;
    const result = await sendPublicReply(row.comment_id, token, fillPlaceholders(reply, row.username ?? undefined), deadline);
    await settle(result.outcome === 'sent' ? 'ok' : 'failed', result.outcome === 'sent' ? null : sendError('public reply', result));
  }
}

/**
 * The cron's work each minute: give up on sends whose Worker was stopped,
 * skip queued sends too close to Instagram's 7-day limit, then send what's
 * due, oldest comment first, within each account's slots for the minute,
 * `subrequests`, and DRAIN_BUDGET_MS.
 */
export async function drainQueue(env: Env, subrequests: Subrequests): Promise<void> {
  const deadline = Date.now() + DRAIN_BUDGET_MS;
  const now = nowSeconds();
  if (!subrequests.take(1)) return;
  const accounts = await sweepQueue(env.DB, now, now - QUEUE_EXPIRY_SECONDS, {
    lease: LEASE_ERROR,
    expired: EXPIRED_ERROR,
    paused: ACCOUNT_PAUSED_REASON,
  });
  const waiting = accounts.filter((a) => a.active === 1 && a.due === 1 && (a.paused_until ?? 0) <= now);
  // Each minute starts with a different account, and each gets an even share
  // of what's left, so one busy account can't take every minute's sends.
  const first = waiting.length ? minuteOf(now) % waiting.length : 0;
  const turns = [...waiting.slice(first), ...waiting.slice(0, first)];
  for (const [i, account] of turns.entries()) {
    if (!hasTimeForCall(deadline)) break;
    const share = Math.floor(subrequests.left / (turns.length - i));
    try {
      await drainAccount(env, account, subrequests, share, deadline);
    } catch (err) {
      console.error('drain failed', account.ig_user_id, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * How many queued DMs a minute sends per account, while `accounts` accounts
 * all have some waiting: each account's 12, or its share of the minute's
 * subrequests if that's less. A poll minute, or other rules' public replies
 * waiting on the DMs, make it fewer.
 */
export function drainRatePerMinute(accounts: number): number {
  const share = (SUBREQUESTS_PER_INVOCATION - 1) / Math.max(1, accounts);
  return Math.max(0, Math.min(SENDS_PER_MINUTE, Math.floor((share - DRAIN_ACCOUNT_COST) / SEND_COST)));
}

async function drainAccount(
  env: Env,
  account: DrainAccount,
  subrequests: Subrequests,
  share: number,
  deadline: number,
): Promise<void> {
  // Read just before reserving, not once for the whole run: a run can reach
  // its last account 40 seconds in, when the minute has moved on.
  const now = nowSeconds();
  const minute = minuteOf(now);
  // A minute later than this one means another Worker's clock is ahead: wait for it.
  if ((account.budget_minute ?? 0) > minute) return;
  const used = account.budget_minute === minute ? (account.budget_used ?? 0) : 0;
  const want = Math.min(SENDS_PER_MINUTE - used, Math.floor((share - DRAIN_ACCOUNT_COST) / SEND_COST));
  if (want <= 0) return;

  let token: string;
  try {
    token = await decryptAesGcm(env.TOKEN_ENCRYPTION_KEY, account.token_iv, account.access_token_enc);
  } catch (err) {
    // Left queued: a key set wrong can be put right, and the rows expire
    // on their own if it never is.
    console.error('drain decrypt failed', account.ig_user_id, err instanceof Error ? err.message : err);
    return;
  }

  subrequests.take(DRAIN_ACCOUNT_COST);
  const granted = await reserveSends(env.DB, account.ig_user_id, minute, want, SENDS_PER_MINUTE, now);
  if (granted === 0) return;
  let claimed: ClaimedSend[] = [];
  let started = 0;
  let calls = 0;
  try {
    claimed = await claimDueSends(env.DB, account.ig_user_id, now, granted, now + SEND_LEASE_SECONDS);
    for (const row of claimed) {
      if (!hasTimeForCall(deadline) || !subrequests.take(sendCost(row.extra_replies))) break;
      started++;
      // The call is counted before it's made: if anything below throws, it
      // may have gone out, and its slot stays used.
      calls++;
      const delivery = await deliver(env.DB, token, row, deadline);
      if (!delivery.called) calls--;
      // Instagram asked this account to slow down, or its token died: the
      // rest wait in the queue, without spending a call each to hear it again.
      if (delivery.stop) break;
    }
  } finally {
    // Whatever stopped the loop, a row it never started goes straight back
    // to the queue, rather than waiting for its lease to call it possibly
    // delivered. A row whose send threw stays `pending` for the lease: the
    // DM may have gone out.
    const unstarted = claimed.slice(started).map((r) => r.comment_id);
    const tidy = [];
    if (granted > calls) tidy.push(refundSendsStatement(env.DB, account.ig_user_id, minute, granted - calls));
    if (unstarted.length) tidy.push(releaseSendsStatement(env.DB, unstarted, nowSeconds()));
    if (tidy.length) await env.DB.batch(tidy);
  }
}
