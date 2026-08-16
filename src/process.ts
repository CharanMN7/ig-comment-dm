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
import { findMatchingRule } from './match.ts';
import { sendPrivateReply, sendPublicReply } from './meta.ts';
import type { Env } from './types.ts';

type CommentValue = {
  id?: string | number;
  comment_id?: string | number;
  text?: string;
  from?: { id?: string | number; username?: string };
  media?: { id?: string | number };
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

/** Meta often sends 17-digit IDs as JSON numbers, which JS cannot represent exactly. */
export function parseWebhookPayload(raw: string): unknown {
  const quoted = raw.replace(/:\s*(-?\d{15,})([,}\s])/g, ':"$1"$2');
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

export async function processWebhook(env: Env, payload: unknown): Promise<void> {
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
          await processComment(env, entryId, entry.time, change.value);
        } catch (err) {
          console.error('comment processing failed', err instanceof Error ? err.message : err);
        }
      }
    }
  }
}

export async function processComment(
  env: Env,
  entryId: string,
  entryTime: number | undefined,
  value: CommentValue,
): Promise<void> {
  const account = await getAccount(env.DB, entryId);
  if (!account || account.active !== 1) {
    console.error('no active account for webhook entry', entryId);
    return;
  }

  const commenterId = asId(value.from?.id) ?? null;
  if (isSelfComment(commenterId, account.ig_user_id)) {
    console.log('ignored self-comment', commentIdOf(value));
    return;
  }

  const commentId = commentIdOf(value);
  if (!commentId) return;

  const now = nowSeconds();
  const text = value.text ?? '';
  const mediaId = asId(value.media?.id);

  if (entryTime != null) {
    const ts = asUnixSeconds(entryTime);
    if (now - ts > COMMENT_MAX_AGE_SECONDS) {
      await tryClaimComment(env.DB, {
        comment_id: commentId,
        ig_user_id: account.ig_user_id,
        commenter_id: commenterId,
        dm_status: 'skipped',
        error: 'comment older than 7 days — Instagram will not accept a private reply',
        sent_at: now,
      });
      return;
    }
  }

  const claimed = await tryClaimComment(env.DB, {
    comment_id: commentId,
    ig_user_id: account.ig_user_id,
    commenter_id: commenterId,
    dm_status: 'pending',
    error: null,
    sent_at: now,
  });
  if (!claimed) return;

  const rules = await listActiveRules(env.DB, account.ig_user_id);
  const rule = findMatchingRule(rules, text, mediaId);
  if (!rule) {
    await updateSent(env.DB, commentId, {
      rule_id: null,
      dm_status: 'skipped',
      reply_status: null,
      error: 'no matching rule',
      sent_at: nowSeconds(),
    });
    return;
  }

  let token: string;
  try {
    token = await decryptAesGcm(env.TOKEN_ENCRYPTION_KEY, account.token_iv, account.access_token_enc);
  } catch (err) {
    await updateSent(env.DB, commentId, {
      rule_id: rule.id,
      dm_status: 'failed',
      reply_status: null,
      error: `could not decrypt access token: ${err instanceof Error ? err.message : 'unknown'}`,
      sent_at: nowSeconds(),
    });
    return;
  }

  const dm = await sendPrivateReply(account.ig_user_id, token, commentId, rule.dm_text);
  let replyStatus: string | null = null;
  const errors: string[] = [];

  if (!dm.ok) errors.push(`DM: ${dm.body}`);

  const publicText = rule.public_reply_text?.trim();
  if (publicText) {
    const reply = await sendPublicReply(commentId, token, publicText);
    replyStatus = reply.ok ? 'ok' : 'failed';
    if (!reply.ok) errors.push(`public reply: ${reply.body}`);
  }

  await updateSent(env.DB, commentId, {
    rule_id: rule.id,
    dm_status: dm.ok ? 'ok' : 'failed',
    reply_status: replyStatus,
    error: errors.length ? errors.join('\n') : null,
    sent_at: nowSeconds(),
  });
}
