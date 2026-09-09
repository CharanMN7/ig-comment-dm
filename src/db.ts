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

/**
 * The four windows the Home page reports on, longest-lived last.
 *
 * `all` starts at 0 rather than at a date, so "all time" needs no special case
 * anywhere below -- it is just a window whose start is before every row.
 */
export const COUNTER_WINDOWS = ['today', 'week', 'month', 'all'] as const;

export type CounterWindow = (typeof COUNTER_WINDOWS)[number];

/**
 * Where each window starts, in unix seconds.
 *
 * The week and month windows are whole days ending with today -- today plus the
 * previous six, and today plus the previous twenty-nine -- rather than 7x86400
 * seconds back from now. An operator reading "last 7 days" at 09:00 means seven
 * days, not six days and nine hours, and day alignment is what makes
 * today <= week <= month <= all hold on the page.
 */
export function counterWindowStarts(now: number): Record<CounterWindow, number> {
  const dayStart = Math.floor(now / 86400) * 86400;
  return {
    today: dayStart,
    week: dayStart - 6 * 86400,
    month: dayStart - 29 * 86400,
    all: 0,
  };
}

export type CounterTotals = {
  triggers: number;
  sends: number;
  skips: number;
  failures: number;
  recipients: number;
};

export type Counters = Record<CounterWindow, CounterTotals>;

export type AccountCounters = { ig_user_id: string; counters: Counters };

/**
 * One aggregate expression per window per metric.
 *
 * Every window is counted in the same pass, so adding a fifth window costs
 * columns rather than a query -- D1 charges per row read, and eight separate
 * range queries would read the same rows eight times.
 *
 * `COUNT(DISTINCT CASE WHEN ... END)` is the one that has to be written this
 * way: recipients cannot be summed across windows or across accounts, because
 * the same commenter appears in more than one.
 */
function counterColumns(): string {
  return COUNTER_WINDOWS.map(
    (w) => `COUNT(CASE WHEN sent_at >= ? THEN 1 END) AS ${w}_triggers,
         COUNT(CASE WHEN sent_at >= ? AND dm_status = 'ok' THEN 1 END) AS ${w}_sends,
         COUNT(CASE WHEN sent_at >= ? AND dm_status = 'skipped' THEN 1 END) AS ${w}_skips,
         COUNT(CASE WHEN sent_at >= ? AND dm_status = 'failed' THEN 1 END) AS ${w}_failures,
         COUNT(DISTINCT CASE WHEN sent_at >= ? THEN commenter_id END) AS ${w}_recipients`,
  ).join(',\n         ');
}

const COUNTER_BINDS_PER_WINDOW = 5;

function counterParams(starts: Record<CounterWindow, number>): number[] {
  return COUNTER_WINDOWS.flatMap((w) =>
    Array.from({ length: COUNTER_BINDS_PER_WINDOW }, () => starts[w]),
  );
}

function readCounters(row: Record<string, number | null> | undefined): Counters {
  const out = {} as Counters;
  for (const w of COUNTER_WINDOWS) {
    out[w] = {
      triggers: row?.[`${w}_triggers`] ?? 0,
      sends: row?.[`${w}_sends`] ?? 0,
      skips: row?.[`${w}_skips`] ?? 0,
      failures: row?.[`${w}_failures`] ?? 0,
      recipients: row?.[`${w}_recipients`] ?? 0,
    };
  }
  return out;
}

/**
 * Totals for every window, overall and per account, in one statement.
 *
 * The per-account rows cannot simply be added up to make the overall row: one
 * commenter may have commented on two accounts, and would be counted twice.
 * So the overall row is aggregated over the whole table, as its own arm of a
 * UNION ALL, and carries a NULL account id.
 */
export async function sendCounters(
  db: D1Database,
  now: number,
): Promise<{ overall: Counters; byAccount: AccountCounters[] }> {
  const starts = counterWindowStarts(now);
  const columns = counterColumns();
  const { results } = await db
    .prepare(
      `SELECT NULL AS ig_user_id,
         ${columns}
       FROM sent
       UNION ALL
       SELECT ig_user_id,
         ${columns}
       FROM sent
       GROUP BY ig_user_id`,
    )
    .bind(...counterParams(starts), ...counterParams(starts))
    .all<Record<string, number | null> & { ig_user_id: string | null }>();

  const rows = results ?? [];
  const overallRow = rows.find((r) => r.ig_user_id === null);
  return {
    overall: readCounters(overallRow),
    // Ordered here rather than in SQL: a compound SELECT only accepts output
    // column names or ordinals in ORDER BY, so `ig_user_id IS NOT NULL` is
    // rejected outright, and one account per connected Instagram account is
    // never a list worth sorting in the database.
    byAccount: rows
      .filter((r): r is typeof r & { ig_user_id: string } => r.ig_user_id !== null)
      .map((r) => ({ ig_user_id: r.ig_user_id, counters: readCounters(r) }))
      .sort((a, b) => b.counters.all.sends - a.counters.all.sends),
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
