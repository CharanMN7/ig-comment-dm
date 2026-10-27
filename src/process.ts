import { getAccount, listActiveRules } from './db.ts';
import { isSelfComment } from './guard.ts';
import { type MatchVerdict, matchComment } from './match.ts';
import { SEND_NOW_COST, admitComment } from './queue.ts';
import { Subrequests } from './subrequests.ts';
import type { Account, Env, Rule } from './types.ts';

/**
 * The webhook answers Meta first and handles the comments in waitUntil, which
 * Cloudflare stops 30 s after the response. A send cut off there leaves its row
 * `pending` until its lease runs out. A DM and its public reply take up to
 * 10 s each, so every Meta call for one delivery has to end inside this, which
 * leaves the last few seconds for writing the outcome.
 */
export const WEBHOOK_SEND_BUDGET_MS = 25_000;

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
 * waitUntil's limit covers all of them together, not each one. So are the
 * invocation's subrequests, and the account and its rules, which every
 * comment in a delivery usually shares.
 */
export async function processWebhook(env: Env, payload: unknown, deadline: number): Promise<void> {
  const comments: Array<{ entryId: string; time: number | undefined; value: CommentValue }> = [];
  const bodies = Array.isArray(payload) ? payload : [payload];
  for (const item of bodies) {
    const body = item as WebhookBody;
    const entries = Array.isArray(body.entry) ? body.entry : [];
    for (const entry of entries) {
      const entryId = asId(entry.id);
      for (const change of changesOf(entry)) {
        if (change.field === 'comments' && change.value && entryId) comments.push({ entryId, time: entry.time, value: change.value });
      }
    }
  }

  const subrequests = new Subrequests();
  const accounts = new Map<string, { account: Account; rules: Rule[] } | null>();
  for (const [i, { entryId, time, value }] of comments.entries()) {
    try {
      if (!accounts.has(entryId)) {
        if (!subrequests.take(2)) {
          console.error('no subrequests left; leaving the rest of the delivery to the poll');
          return;
        }
        accounts.set(entryId, await accountAndRules(env.DB, entryId));
      }
      const known = accounts.get(entryId);
      if (!known) {
        console.error('no account for webhook entry', entryId);
        continue;
      }
      // A large delivery sends its first comments now and queues the rest,
      // keeping a subrequest for each comment still to come so every one of
      // them gets its row.
      const later = comments.length - i - 1;
      const sendBy = subrequests.left - later >= SEND_NOW_COST ? deadline : undefined;
      await processComment(env, known.account, known.rules, time, value, subrequests, sendBy);
    } catch (err) {
      console.error('comment processing failed', err instanceof Error ? err.message : err);
    }
  }
}

async function accountAndRules(db: D1Database, igUserId: string): Promise<{ account: Account; rules: Rule[] } | null> {
  const account = await getAccount(db, igUserId);
  if (!account) return null;
  return { account, rules: await listActiveRules(db, igUserId) };
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
 * `sendBy` (epoch ms) is when every Meta call for this comment must have
 * ended, so the outcome is written before the runtime stops the Worker.
 * Without it, or without the time or a slot to send now, the comment waits
 * in the queue.
 */
async function processComment(
  env: Env,
  account: Account,
  rules: Rule[],
  entryTime: number | undefined,
  value: CommentValue,
  subrequests: Subrequests,
  sendBy: number | undefined,
): Promise<void> {
  const commenterId = asId(value.from?.id) ?? null;
  if (isSelfComment(commenterId, account.ig_user_id)) {
    console.log('ignored self-comment', commentIdOf(value));
    return;
  }
  const commentId = commentIdOf(value);
  if (!commentId) return;
  await admitComment(env, account, rules, {
    id: commentId,
    commenterId,
    text: value.text ?? '',
    mediaId: asId(value.media?.id) ?? asId(value.media_id),
    originalMediaId: asId(value.media?.original_media_id),
    username: value.from?.username,
    at: entryTime == null ? undefined : asUnixSeconds(entryTime),
  }, subrequests, sendBy);
}
