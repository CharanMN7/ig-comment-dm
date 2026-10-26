import { env } from 'cloudflare:workers';
import { decryptAesGcm, encryptAesGcm } from '../../src/crypto.ts';
import { insertRule, setAccountActive, toggleRule, tryClaimComment, updateSent, upsertAccount } from '../../src/db.ts';
import type { Account, Rule, Sent } from '../../src/types.ts';

export const FROZEN_NOW_MS = Date.UTC(2026, 9, 1, 12, 0, 0);
export const NOW = Math.floor(FROZEN_NOW_MS / 1000);
export const DAY = 24 * 60 * 60;

export const IG_USER = '17841400000000001';
export const ACCESS_TOKEN = 'IGAA-test-access-token';

// Seeding goes through the production write helpers, so a migration that
// changes a table is exercised the way the Worker itself writes to it.

export async function seedAccount(
  opts: {
    igUserId?: string;
    username?: string;
    token?: string;
    expiresAt?: number;
    connectedAt?: number;
    lastRefreshedAt?: number;
    active?: boolean;
    encryptionKey?: string;
  } = {},
): Promise<string> {
  const igUserId = opts.igUserId ?? IG_USER;
  const enc = await encryptAesGcm(opts.encryptionKey ?? env.TOKEN_ENCRYPTION_KEY, opts.token ?? ACCESS_TOKEN);
  await upsertAccount(env.DB, {
    ig_user_id: igUserId,
    username: opts.username ?? 'creator',
    access_token_enc: enc.ciphertext,
    token_iv: enc.iv,
    token_expires_at: opts.expiresAt ?? NOW + 50 * DAY,
    connected_at: opts.connectedAt ?? NOW - 5 * DAY,
    last_refreshed_at: opts.lastRefreshedAt ?? NOW - 5 * DAY,
  });
  if (opts.active === false) await setAccountActive(env.DB, igUserId, 0);
  return igUserId;
}

export async function seedRule(
  opts: {
    igUserId?: string;
    label?: string;
    keywords?: string[];
    mediaId?: string | null;
    dmText?: string;
    publicReply?: string | null;
    active?: boolean;
  } = {},
): Promise<number> {
  await insertRule(env.DB, {
    ig_user_id: opts.igUserId ?? IG_USER,
    label: opts.label ?? 'Free guide',
    keywords: JSON.stringify(opts.keywords ?? ['guide']),
    media_id: opts.mediaId ?? null,
    dm_text: opts.dmText ?? 'Here is your guide: https://example.com/guide',
    public_reply_text: opts.publicReply ?? null,
    created_at: NOW,
  });
  const row = await env.DB.prepare('SELECT MAX(id) AS id FROM rules').first<{ id: number }>();
  const id = row!.id;
  if (opts.active === false) await toggleRule(env.DB, id);
  return id;
}

/** A logged comment, claimed then settled the way the pipeline writes one. */
export async function seedSent(opts: {
  commentId: string;
  igUserId?: string;
  ruleId?: number | null;
  status?: string;
  replyStatus?: string | null;
  error?: string | null;
  sentAt?: number;
}): Promise<void> {
  const sentAt = opts.sentAt ?? NOW;
  await tryClaimComment(env.DB, {
    comment_id: opts.commentId,
    ig_user_id: opts.igUserId ?? IG_USER,
    commenter_id: '9100000000000001',
    dm_status: 'pending',
    error: null,
    sent_at: sentAt,
  });
  await updateSent(env.DB, opts.commentId, {
    rule_id: opts.ruleId ?? null,
    dm_status: opts.status ?? 'ok',
    reply_status: opts.replyStatus ?? null,
    error: opts.error ?? null,
    sent_at: sentAt,
  });
}

// Compare rows with toMatchObject, not toEqual: a migration that adds a column
// should not have to touch tests that never look at it.
export async function sentRows(): Promise<Sent[]> {
  const { results } = await env.DB.prepare('SELECT * FROM sent ORDER BY comment_id').all<Sent>();
  return results;
}

export async function sentRow(commentId: string): Promise<Sent | null> {
  return env.DB.prepare('SELECT * FROM sent WHERE comment_id = ?').bind(commentId).first<Sent>();
}

export async function ruleRows(): Promise<Rule[]> {
  const { results } = await env.DB.prepare('SELECT * FROM rules ORDER BY id').all<Rule>();
  return results;
}

export async function accountRow(igUserId = IG_USER): Promise<Account | null> {
  return env.DB.prepare('SELECT * FROM accounts WHERE ig_user_id = ?').bind(igUserId).first<Account>();
}

export async function storedToken(igUserId = IG_USER): Promise<string> {
  const account = await accountRow(igUserId);
  if (!account) throw new Error(`no account ${igUserId}`);
  return decryptAesGcm(env.TOKEN_ENCRYPTION_KEY, account.token_iv, account.access_token_enc);
}

export async function systemValue(key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM system WHERE key = ?').bind(key).first<{ value: string | null }>();
  return row?.value ?? null;
}

export async function webhookEvents(): Promise<Array<{ status: string; object: string | null; preview: string | null; error: string | null }>> {
  const { results } = await env.DB.prepare('SELECT status, object, preview, error FROM webhook_events ORDER BY id').all<{
    status: string;
    object: string | null;
    preview: string | null;
    error: string | null;
  }>();
  return results;
}
