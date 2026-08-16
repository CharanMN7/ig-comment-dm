import type { Account, Rule, Sent, WebhookEvent } from './types.ts';

export async function systemGet(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM system WHERE key = ?').bind(key).first<{ value: string | null }>();
  return row?.value ?? null;
}

export async function systemSet(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      'INSERT INTO system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .bind(key, value)
    .run();
}

export async function getAccount(db: D1Database, igUserId: string): Promise<Account | null> {
  return await db
    .prepare(
      `SELECT ig_user_id, username, access_token_enc, token_iv, token_expires_at,
              active, connected_at, last_refreshed_at, needs_reconnect
       FROM accounts WHERE ig_user_id = ?`,
    )
    .bind(igUserId)
    .first<Account>();
}

export async function listAccounts(db: D1Database): Promise<Account[]> {
  const { results } = await db
    .prepare(
      `SELECT ig_user_id, username, access_token_enc, token_iv, token_expires_at,
              active, connected_at, last_refreshed_at, needs_reconnect
       FROM accounts ORDER BY username COLLATE NOCASE`,
    )
    .all<Account>();
  return results ?? [];
}

export async function upsertAccount(
  db: D1Database,
  row: {
    ig_user_id: string;
    username: string;
    access_token_enc: string;
    token_iv: string;
    token_expires_at: number;
    connected_at: number;
    last_refreshed_at: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO accounts (
         ig_user_id, username, access_token_enc, token_iv, token_expires_at,
         active, connected_at, last_refreshed_at, needs_reconnect
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)
       ON CONFLICT(ig_user_id) DO UPDATE SET
         username = excluded.username,
         access_token_enc = excluded.access_token_enc,
         token_iv = excluded.token_iv,
         token_expires_at = excluded.token_expires_at,
         active = 1,
         last_refreshed_at = excluded.last_refreshed_at,
         needs_reconnect = 0`,
    )
    .bind(
      row.ig_user_id,
      row.username,
      row.access_token_enc,
      row.token_iv,
      row.token_expires_at,
      row.connected_at,
      row.last_refreshed_at,
    )
    .run();
}

export async function setAccountActive(db: D1Database, igUserId: string, active: number): Promise<void> {
  await db.prepare('UPDATE accounts SET active = ? WHERE ig_user_id = ?').bind(active, igUserId).run();
}

export async function updateAccountToken(
  db: D1Database,
  igUserId: string,
  enc: string,
  iv: string,
  expiresAt: number,
  refreshedAt: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE accounts
       SET access_token_enc = ?, token_iv = ?, token_expires_at = ?,
           last_refreshed_at = ?, needs_reconnect = 0
       WHERE ig_user_id = ?`,
    )
    .bind(enc, iv, expiresAt, refreshedAt, igUserId)
    .run();
}

export async function flagNeedsReconnect(db: D1Database, igUserId: string): Promise<void> {
  await db.prepare('UPDATE accounts SET needs_reconnect = 1 WHERE ig_user_id = ?').bind(igUserId).run();
}

export async function accountsNeedingRefresh(db: D1Database, expiresBefore: number): Promise<Account[]> {
  const { results } = await db
    .prepare(
      `SELECT ig_user_id, username, access_token_enc, token_iv, token_expires_at,
              active, connected_at, last_refreshed_at, needs_reconnect
       FROM accounts
       WHERE active = 1 AND token_expires_at < ?
       ORDER BY token_expires_at ASC`,
    )
    .bind(expiresBefore)
    .all<Account>();
  return results ?? [];
}

export async function listActiveRules(db: D1Database, igUserId: string): Promise<Rule[]> {
  const { results } = await db
    .prepare(
      `SELECT id, ig_user_id, label, keywords, media_id, dm_text, public_reply_text, active, created_at
       FROM rules WHERE ig_user_id = ? AND active = 1 ORDER BY id ASC`,
    )
    .bind(igUserId)
    .all<Rule>();
  return results ?? [];
}

export async function listRules(db: D1Database, igUserId?: string): Promise<Rule[]> {
  if (igUserId) {
    const { results } = await db
      .prepare(
        `SELECT id, ig_user_id, label, keywords, media_id, dm_text, public_reply_text, active, created_at
         FROM rules WHERE ig_user_id = ? ORDER BY id DESC`,
      )
      .bind(igUserId)
      .all<Rule>();
    return results ?? [];
  }
  const { results } = await db
    .prepare(
      `SELECT id, ig_user_id, label, keywords, media_id, dm_text, public_reply_text, active, created_at
       FROM rules ORDER BY id DESC`,
    )
    .all<Rule>();
  return results ?? [];
}

export async function getRule(db: D1Database, id: number): Promise<Rule | null> {
  return await db
    .prepare(
      `SELECT id, ig_user_id, label, keywords, media_id, dm_text, public_reply_text, active, created_at
       FROM rules WHERE id = ?`,
    )
    .bind(id)
    .first<Rule>();
}

export async function insertRule(
  db: D1Database,
  row: {
    ig_user_id: string;
    label: string;
    keywords: string;
    media_id: string | null;
    dm_text: string;
    public_reply_text: string | null;
    created_at: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO rules (ig_user_id, label, keywords, media_id, dm_text, public_reply_text, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .bind(row.ig_user_id, row.label, row.keywords, row.media_id, row.dm_text, row.public_reply_text, row.created_at)
    .run();
}

export async function updateRule(
  db: D1Database,
  id: number,
  row: {
    ig_user_id: string;
    label: string;
    keywords: string;
    media_id: string | null;
    dm_text: string;
    public_reply_text: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE rules
       SET ig_user_id = ?, label = ?, keywords = ?, media_id = ?, dm_text = ?, public_reply_text = ?
       WHERE id = ?`,
    )
    .bind(row.ig_user_id, row.label, row.keywords, row.media_id, row.dm_text, row.public_reply_text, id)
    .run();
}

export async function toggleRule(db: D1Database, id: number): Promise<void> {
  await db.prepare('UPDATE rules SET active = 1 - active WHERE id = ?').bind(id).run();
}

export async function deleteRule(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM rules WHERE id = ?').bind(id).run();
}

export async function tryClaimComment(
  db: D1Database,
  row: {
    comment_id: string;
    ig_user_id: string;
    commenter_id: string | null;
    dm_status: string;
    error: string | null;
    sent_at: number;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO sent (comment_id, ig_user_id, rule_id, commenter_id, dm_status, reply_status, error, sent_at)
       VALUES (?, ?, NULL, ?, ?, NULL, ?, ?)
       ON CONFLICT(comment_id) DO NOTHING`,
    )
    .bind(row.comment_id, row.ig_user_id, row.commenter_id, row.dm_status, row.error, row.sent_at)
    .run();
  const meta = result.meta as { changes?: number; rows_written?: number };
  return (meta.changes ?? meta.rows_written ?? 0) > 0;
}

export async function updateSent(
  db: D1Database,
  commentId: string,
  patch: {
    rule_id: number | null;
    dm_status: string;
    reply_status: string | null;
    error: string | null;
    sent_at: number;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE sent SET rule_id = ?, dm_status = ?, reply_status = ?, error = ?, sent_at = ? WHERE comment_id = ?`,
    )
    .bind(patch.rule_id, patch.dm_status, patch.reply_status, patch.error, patch.sent_at, commentId)
    .run();
}

export async function recentSent(db: D1Database, limit: number): Promise<(Sent & { rule_label: string | null })[]> {
  const { results } = await db
    .prepare(
      `SELECT s.comment_id, s.ig_user_id, s.rule_id, s.commenter_id, s.dm_status, s.reply_status,
              s.error, s.sent_at, r.label AS rule_label
       FROM sent s
       LEFT JOIN rules r ON r.id = s.rule_id
       ORDER BY s.sent_at DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<Sent & { rule_label: string | null }>();
  return results ?? [];
}

export async function todayCounters(
  db: D1Database,
  since: number,
): Promise<{ triggers: number; sends: number; failures: number }> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS triggers,
         SUM(CASE WHEN dm_status = 'ok' THEN 1 ELSE 0 END) AS sends,
         SUM(CASE WHEN dm_status = 'failed' THEN 1 ELSE 0 END) AS failures
       FROM sent WHERE sent_at >= ?`,
    )
    .bind(since)
    .first<{ triggers: number; sends: number | null; failures: number | null }>();
  return {
    triggers: row?.triggers ?? 0,
    sends: row?.sends ?? 0,
    failures: row?.failures ?? 0,
  };
}

export async function insertWebhookEvent(
  db: D1Database,
  row: {
    received_at: number;
    status: string;
    object: string | null;
    preview: string | null;
    error: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO webhook_events (received_at, status, object, preview, error)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(row.received_at, row.status, row.object, row.preview, row.error)
    .run();
}

export async function recentWebhookEvents(db: D1Database, limit: number): Promise<WebhookEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT id, received_at, status, object, preview, error
       FROM webhook_events
       ORDER BY received_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<WebhookEvent>();
  return results ?? [];
}

export async function pruneWebhookEvents(db: D1Database, olderThan: number): Promise<void> {
  await db.prepare('DELETE FROM webhook_events WHERE received_at < ?').bind(olderThan).run();
}

export async function countSentByComment(db: D1Database, commentId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM sent WHERE comment_id = ?')
    .bind(commentId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getSent(db: D1Database, commentId: string): Promise<Sent | null> {
  return await db
    .prepare(
      `SELECT comment_id, ig_user_id, rule_id, commenter_id, dm_status, reply_status, error, sent_at
       FROM sent WHERE comment_id = ?`,
    )
    .bind(commentId)
    .first<Sent>();
}
