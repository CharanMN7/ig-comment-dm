import type { Account, ExtraReply, MatchMode, Rule, Sent, WebhookEvent } from './types.ts';

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

/** Writes several `system` keys as one D1 batch, which counts as one query. */
export async function systemSetAll(db: D1Database, entries: ReadonlyArray<readonly [string, string]>): Promise<void> {
  const upsert = db.prepare('INSERT INTO system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  await db.batch(entries.map(([key, value]) => upsert.bind(key, value)));
}

export type HealthSnapshot = {
  lastCronOkAt: number | null;
  lastPollOkAt: number | null;
  firstSeenAt: number | null;
  lastWebhookAt: number | null;
  activeAccounts: number;
  needsReconnect: number;
};

export const HEALTH_FIRST_SEEN_KEY = 'health_first_seen_at';
export const LAST_WEBHOOK_KEY = 'last_webhook_received_at';

/**
 * Everything `/health` reports, in one statement, so a monitor polling every
 * 30 seconds costs one D1 read. `needs_reconnect` counts what the admin
 * banner counts: flagged by the nightly job, or already expired.
 */
export async function healthSnapshot(db: D1Database, now: number): Promise<HealthSnapshot> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT value FROM system WHERE key = 'last_cron_ok_at') AS last_cron_ok_at,
         (SELECT value FROM system WHERE key = 'last_poll_ok_at') AS last_poll_ok_at,
         (SELECT value FROM system WHERE key = ?1) AS first_seen_at,
         (SELECT value FROM system WHERE key = ?3) AS last_webhook_at,
         (SELECT COUNT(*) FROM accounts WHERE active = 1) AS active,
         (SELECT COUNT(*) FROM accounts WHERE needs_reconnect = 1 OR token_expires_at <= ?2) AS needs_reconnect`,
    )
    .bind(HEALTH_FIRST_SEEN_KEY, now, LAST_WEBHOOK_KEY)
    .first<{
      last_cron_ok_at: string | null;
      last_poll_ok_at: string | null;
      first_seen_at: string | null;
      last_webhook_at: string | null;
      active: number;
      needs_reconnect: number;
    }>();
  const int = (value: string | null | undefined): number | null => {
    const n = Number.parseInt(value ?? '', 10);
    return Number.isFinite(n) ? n : null;
  };
  return {
    lastCronOkAt: int(row?.last_cron_ok_at),
    lastPollOkAt: int(row?.last_poll_ok_at),
    firstSeenAt: int(row?.first_seen_at),
    lastWebhookAt: int(row?.last_webhook_at),
    activeAccounts: row?.active ?? 0,
    needsReconnect: row?.needs_reconnect ?? 0,
  };
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
  // A new token is what a send held back by a dead one was waiting for. A
  // rate-limit pause stays: the account sent just as fast with the old token.
  await db.prepare('UPDATE send_budget SET token_held_until = 0 WHERE ig_user_id = ?').bind(row.ig_user_id).run();
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
  await flagNeedsReconnectStatement(db, igUserId).run();
}

export function flagNeedsReconnectStatement(db: D1Database, igUserId: string): D1PreparedStatement {
  return db.prepare('UPDATE accounts SET needs_reconnect = 1 WHERE ig_user_id = ?').bind(igUserId);
}

export async function accountsNeedingRefresh(db: D1Database, expiresBefore: number): Promise<Account[]> {
  const { results } = await db
    .prepare(
      `SELECT ig_user_id, username, access_token_enc, token_iv, token_expires_at,
              active, connected_at, last_refreshed_at, needs_reconnect
       FROM accounts
       WHERE token_expires_at < ?
       ORDER BY token_expires_at ASC`,
    )
    .bind(expiresBefore)
    .all<Account>();
  return results ?? [];
}

// Every reader selects the same columns, so a migration that adds one to
// `rules` is a one-line change here rather than four that can drift apart.
const RULE_COLUMNS =
  'id, ig_user_id, label, keywords, match_mode, exclude_keywords, match_all, reply_without_dm, media_id, dm_text, public_reply_text, active, created_at';

export async function listActiveRules(db: D1Database, igUserId: string): Promise<Rule[]> {
  const { results } = await db
    .prepare(
      `SELECT ${RULE_COLUMNS} FROM rules WHERE ig_user_id = ? AND active = 1 ORDER BY id ASC`,
    )
    .bind(igUserId)
    .all<Rule>();
  return results ?? [];
}

export async function listRules(db: D1Database, igUserId?: string): Promise<Rule[]> {
  if (igUserId) {
    const { results } = await db
      .prepare(
        `SELECT ${RULE_COLUMNS} FROM rules WHERE ig_user_id = ? ORDER BY id DESC`,
      )
      .bind(igUserId)
      .all<Rule>();
    return results ?? [];
  }
  const { results } = await db
    .prepare(
      `SELECT ${RULE_COLUMNS} FROM rules ORDER BY id DESC`,
    )
    .all<Rule>();
  return results ?? [];
}

export async function getRule(db: D1Database, id: number): Promise<Rule | null> {
  return await db
    .prepare(
      `SELECT ${RULE_COLUMNS} FROM rules WHERE id = ?`,
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
    match_mode: MatchMode;
    exclude_keywords: string;
    match_all: number;
    reply_without_dm: number;
    media_id: string | null;
    dm_text: string;
    public_reply_text: string | null;
    created_at: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO rules (
         ig_user_id, label, keywords, match_mode, exclude_keywords, match_all, reply_without_dm, media_id, dm_text,
         public_reply_text, active, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .bind(
      row.ig_user_id,
      row.label,
      row.keywords,
      row.match_mode,
      row.exclude_keywords,
      row.match_all,
      row.reply_without_dm,
      row.media_id,
      row.dm_text,
      row.public_reply_text,
      row.created_at,
    )
    .run();
}

export async function updateRule(
  db: D1Database,
  id: number,
  row: {
    ig_user_id: string;
    label: string;
    keywords: string;
    match_mode: MatchMode;
    exclude_keywords: string;
    match_all: number;
    reply_without_dm: number;
    media_id: string | null;
    dm_text: string;
    public_reply_text: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE rules
       SET ig_user_id = ?, label = ?, keywords = ?, match_mode = ?, exclude_keywords = ?, match_all = ?,
           reply_without_dm = ?, media_id = ?, dm_text = ?, public_reply_text = ?
       WHERE id = ?`,
    )
    .bind(
      row.ig_user_id,
      row.label,
      row.keywords,
      row.match_mode,
      row.exclude_keywords,
      row.match_all,
      row.reply_without_dm,
      row.media_id,
      row.dm_text,
      row.public_reply_text,
      id,
    )
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
  return changedRows(result) > 0;
}

function changedRows(result: D1Result): number {
  const meta = result.meta as { changes?: number; rows_written?: number };
  return meta.changes ?? meta.rows_written ?? 0;
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

/**
 * The same claim as tryClaimComment, per rule: true only for the one caller
 * that wrote the row, so that caller alone posts this rule's public reply.
 */
export async function claimExtraReply(db: D1Database, row: ExtraReply): Promise<boolean> {
  return changedRows(await extraReplyInsert(db, row).run()) > 0;
}

export function extraReplyInsert(db: D1Database, row: ExtraReply): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sent_extra_replies (comment_id, rule_id, status, error, sent_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(comment_id, rule_id) DO NOTHING`,
    )
    .bind(row.comment_id, row.rule_id, row.status, row.error, row.sent_at);
}

/** A comment's other rules still waiting for its DM, with each rule's reply as it is now. */
export async function queuedExtraReplies(
  db: D1Database,
  commentId: string,
): Promise<Array<{ rule_id: number; public_reply_text: string | null; active: number | null }>> {
  const { results } = await db
    .prepare(
      `SELECT e.rule_id, r.public_reply_text, r.active
       FROM sent_extra_replies e
       LEFT JOIN rules r ON r.id = e.rule_id
       WHERE e.comment_id = ? AND e.status = 'queued'
       ORDER BY e.rowid`,
    )
    .bind(commentId)
    .all<{ rule_id: number; public_reply_text: string | null; active: number | null }>();
  return results ?? [];
}

/** Moves one waiting reply to `pending`; true only for the caller whose statement did. */
export async function claimQueuedExtraReply(db: D1Database, commentId: string, ruleId: number, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE sent_extra_replies SET status = 'pending', sent_at = ?
       WHERE comment_id = ? AND rule_id = ? AND status = 'queued'`,
    )
    .bind(now, commentId, ruleId)
    .run();
  return changedRows(result) > 0;
}

/** Settles every reply still waiting on a comment whose DM won't be confirmed. */
export async function skipQueuedExtraReplies(db: D1Database, commentId: string, error: string, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE sent_extra_replies SET status = 'skipped', error = ?, sent_at = ?
       WHERE comment_id = ? AND status = 'queued'`,
    )
    .bind(error, now, commentId)
    .run();
}

export async function updateExtraReply(
  db: D1Database,
  commentId: string,
  ruleId: number,
  patch: { status: string; error: string | null; sent_at: number },
): Promise<void> {
  await db
    .prepare('UPDATE sent_extra_replies SET status = ?, error = ?, sent_at = ? WHERE comment_id = ? AND rule_id = ?')
    .bind(patch.status, patch.error, patch.sent_at, commentId, ruleId)
    .run();
}

/**
 * The other matching rules for these comments, in matching order. A lookup
 * per comment on the primary key, so Home reads only these rows.
 */
export async function extraRepliesFor(
  db: D1Database,
  commentIds: string[],
): Promise<(ExtraReply & { rule_label: string | null })[]> {
  if (commentIds.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT e.comment_id, e.rule_id, e.status, e.error, e.sent_at, r.label AS rule_label
       FROM sent_extra_replies e
       LEFT JOIN rules r ON r.id = e.rule_id
       WHERE e.comment_id IN (${commentIds.map(() => '?').join(', ')})
       ORDER BY e.rowid`,
    )
    .bind(...commentIds)
    .all<ExtraReply & { rule_label: string | null }>();
  return results ?? [];
}

/**
 * Gives up on `pending` rows claimed in [claimedFrom, claimedBefore), as
 * `unsure`: the DM may have gone out. Only `pending`
 * is touched, so a send that does finish late still records its real outcome.
 * The lower bound keeps this a range read on idx_sent_time: rows older than
 * the last totals snapshot were already swept. A row the queue claimed keeps
 * the sent_at of when it was queued, so one whose lease hasn't run out is
 * still being sent and is left alone.
 */
export async function failStalePending(
  db: D1Database,
  claimedFrom: number,
  claimedBefore: number,
  now: number,
  error: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE sent SET dm_status = 'unsure', error = ?
       WHERE dm_status = 'pending' AND sent_at >= ? AND sent_at < ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
    )
    .bind(error, claimedFrom, claimedBefore, now)
    .run();
}

export async function recentSent(db: D1Database, limit: number): Promise<(Sent & { rule_label: string | null })[]> {
  const { results } = await db
    .prepare(
      `SELECT s.comment_id, s.ig_user_id, s.rule_id, s.commenter_id, s.dm_status, s.reply_status,
              s.error, s.sent_at, s.attempts, s.next_attempt_at, s.comment_at, s.username, r.label AS rule_label
       FROM sent s
       LEFT JOIN rules r ON r.id = s.rule_id
       ORDER BY s.sent_at DESC, s.comment_id DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<Sent & { rule_label: string | null }>();
  return results ?? [];
}

export type SentLogFilters = {
  status?: string;
  ig_user_id?: string;
  rule_id?: number;
  /** Inclusive, unix seconds. */
  from?: number;
  /** Exclusive, unix seconds. */
  to?: number;
};

/**
 * Where a logs page starts: just past one send, going older or newer. The
 * comment id breaks ties because sent_at is whole seconds, and a burst of
 * comments shares one. Paging on sent_at alone skips the rest of that second.
 */
export type SentLogCursor = { dir: 'older' | 'newer'; sent_at: number; comment_id: string };

export function sentLogQuery(
  filters: SentLogFilters,
  cursor: SentLogCursor | null,
  limit: number,
): { sql: string; bindings: (string | number)[] } {
  const conditions: string[] = [];
  const bindings: (string | number)[] = [];
  if (filters.status) {
    conditions.push('s.dm_status = ?');
    bindings.push(filters.status);
  }
  if (filters.ig_user_id) {
    conditions.push('s.ig_user_id = ?');
    bindings.push(filters.ig_user_id);
  }
  if (filters.rule_id !== undefined) {
    conditions.push('s.rule_id = ?');
    bindings.push(filters.rule_id);
  }
  if (filters.from !== undefined) {
    conditions.push('s.sent_at >= ?');
    bindings.push(filters.from);
  }
  if (filters.to !== undefined) {
    conditions.push('s.sent_at < ?');
    bindings.push(filters.to);
  }
  if (cursor) {
    const cmp = cursor.dir === 'older' ? '<' : '>';
    // The plain range is implied by the OR, but D1's SQLite only seeks the
    // index on a plain range. Without it, a page deep in the history reads
    // every row in front of it, and D1 bills each one.
    conditions.push(`s.sent_at ${cmp}= ?`, `(s.sent_at ${cmp} ? OR (s.sent_at = ? AND s.comment_id ${cmp} ?))`);
    bindings.push(cursor.sent_at, cursor.sent_at, cursor.sent_at, cursor.comment_id);
  }
  // Newer pages read oldest first, so LIMIT keeps the rows next to the cursor
  // rather than the newest rows in the table.
  const order = cursor?.dir === 'newer' ? 'ASC' : 'DESC';
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return {
    sql: `SELECT s.comment_id, s.ig_user_id, s.rule_id, s.commenter_id, s.dm_status, s.reply_status,
              s.error, s.sent_at, s.attempts, s.next_attempt_at, s.comment_at, s.username, r.label AS rule_label
       FROM sent s
       LEFT JOIN rules r ON r.id = s.rule_id
       ${where}
       ORDER BY s.sent_at ${order}, s.comment_id ${order}
       LIMIT ?`,
    bindings: [...bindings, limit],
  };
}

/** One page of sends, newest first, and whether another page lies beyond it. */
export async function paginatedSent(
  db: D1Database,
  filters: SentLogFilters,
  cursor: SentLogCursor | null,
  limit: number,
): Promise<{ sends: (Sent & { rule_label: string | null })[]; more: boolean }> {
  const { sql, bindings } = sentLogQuery(filters, cursor, limit + 1);
  const { results } = await db
    .prepare(sql)
    .bind(...bindings)
    .all<Sent & { rule_label: string | null }>();
  const rows = results ?? [];
  const sends = rows.slice(0, limit);
  if (cursor?.dir === 'newer') sends.reverse();
  return { sends, more: rows.length > limit };
}

export type SendTotals = { sent: number; skipped: number; failed: number; reached: number };

export const NO_SENDS: SendTotals = { sent: 0, skipped: 0, failed: 0, reached: 0 };

export function addTotals(a: SendTotals, b: SendTotals): SendTotals {
  return { sent: a.sent + b.sent, skipped: a.skipped + b.skipped, failed: a.failed + b.failed, reached: a.reached + b.reached };
}

/**
 * The rows with `from <= sent_at < to`. With `firstReach`, people reached
 * counts only commenters with no DM before `from`, which is what lets the
 * span be added to a snapshot of everything before `from` without counting
 * anyone twice.
 */
export type Span = { from: number; to?: number; firstReach?: boolean };

type TotalsRow = Record<string, number | string | null>;

/**
 * One column per status per span, in one statement, read through a range on
 * sent_at so the cost follows the widest span rather than the table.
 *
 * People reached counts each commenter once, from rows where a DM went out.
 * Someone whose comment was skipped, or whose DM failed, was not reached.
 *
 * Per account, the IN list makes SQLite read idx_sent_account_time one
 * account at a time. With a bare GROUP BY it walks that whole index in
 * account order instead, because without ANALYZE statistics it values
 * skipping the sort over skipping the history.
 */
function totalsQuery(spans: Span[], perAccount: boolean): { sql: string; binds: number[] } {
  const binds: number[] = [];
  const param = (value: number) => {
    binds.push(value);
    return `?${binds.length}`;
  };
  const ends = spans.map((s) => s.to);
  let range = `sent_at >= ${param(Math.min(...spans.map((s) => s.from)))}`;
  if (ends.every((to) => to != null)) range += ` AND sent_at < ${param(Math.max(...ends))}`;
  const sameAccount = perAccount ? ' AND p.ig_user_id = sent.ig_user_id' : '';
  const columns = spans.flatMap((span, i) => {
    const from = param(span.from);
    let inSpan = `sent_at >= ${from}`;
    if (span.to != null) inSpan += ` AND sent_at < ${param(span.to)}`;
    // From 0 there is nothing earlier, so skip a lookup per row that can't match.
    const firstTime =
      span.firstReach && span.from > 0
        ? ` AND NOT EXISTS (SELECT 1 FROM sent p WHERE p.commenter_id = sent.commenter_id${sameAccount}
             AND p.dm_status = 'ok' AND p.sent_at < ${from})`
        : '';
    return [
      `COUNT(CASE WHEN ${inSpan} AND dm_status = 'ok' THEN 1 END) AS sent_${i}`,
      `COUNT(CASE WHEN ${inSpan} AND dm_status = 'skipped' THEN 1 END) AS skipped_${i}`,
      `COUNT(CASE WHEN ${inSpan} AND dm_status IN ('failed', 'unsure') THEN 1 END) AS failed_${i}`,
      `COUNT(DISTINCT CASE WHEN ${inSpan} AND dm_status = 'ok'${firstTime} THEN commenter_id END) AS reached_${i}`,
    ];
  });
  const sql = perAccount
    ? `SELECT ig_user_id, ${columns.join(', ')} FROM sent
       WHERE ig_user_id IN (SELECT ig_user_id FROM accounts) AND ${range}
       GROUP BY ig_user_id`
    : `SELECT ${columns.join(', ')} FROM sent WHERE ${range}`;
  return { sql, binds };
}

function readTotals(row: TotalsRow | undefined, spans: number): SendTotals[] {
  const n = (key: string) => Number(row?.[key] ?? 0);
  return Array.from({ length: spans }, (_, i) => ({
    sent: n(`sent_${i}`),
    skipped: n(`skipped_${i}`),
    failed: n(`failed_${i}`),
    reached: n(`reached_${i}`),
  }));
}

/** Totals for each span, in one statement. */
export async function sendTotals(db: D1Database, spans: Span[]): Promise<SendTotals[]> {
  const { sql, binds } = totalsQuery(spans, false);
  const { results } = await db.prepare(sql).bind(...binds).all<TotalsRow>();
  return readTotals(results?.[0], spans.length);
}

/**
 * The same totals per connected account, also in one statement. Accounts with
 * no rows in any span are absent.
 */
export async function sendTotalsByAccount(db: D1Database, spans: Span[]): Promise<Map<string, SendTotals[]>> {
  const { sql, binds } = totalsQuery(spans, true);
  const { results } = await db.prepare(sql).bind(...binds).all<TotalsRow>();
  return new Map((results ?? []).map((row) => [String(row.ig_user_id), readTotals(row, spans.length)]));
}

/** How many rows `sent` has, counting no further than `limit`. */
export async function countSentUpTo(db: D1Database, limit: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM sent LIMIT ?)')
    .bind(limit)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Every row with sent_at before `cutoff`, counted. Those rows can no longer
 * change, so Home adds a live count of the rows since `cutoff` to this rather
 * than reading the whole history on every visit.
 */
export type TotalsSnapshot = { cutoff: number; all: SendTotals; accounts: Record<string, SendTotals> };

export const TOTALS_SNAPSHOT_KEY = 'send_totals_snapshot';

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

function asTotals(value: unknown): SendTotals | null {
  if (typeof value !== 'object' || value === null) return null;
  const { sent, skipped, failed, reached } = value as Record<string, unknown>;
  return isCount(sent) && isCount(skipped) && isCount(failed) && isCount(reached) ? { sent, skipped, failed, reached } : null;
}

/** The stored snapshot, or null when there is none or it can't be read, which both mean "count again". */
export async function readTotalsSnapshot(db: D1Database): Promise<TotalsSnapshot | null> {
  const raw = await systemGet(db, TOTALS_SNAPSHOT_KEY);
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { cutoff, all, accounts } = parsed as Record<string, unknown>;
  const total = asTotals(all);
  if (!isCount(cutoff) || !total) return null;
  if (typeof accounts !== 'object' || accounts === null) return null;
  const byAccount: Record<string, SendTotals> = {};
  for (const [id, value] of Object.entries(accounts)) {
    const t = asTotals(value);
    if (!t) return null;
    byAccount[id] = t;
  }
  return { cutoff, all: total, accounts: byAccount };
}

export async function writeTotalsSnapshot(db: D1Database, snapshot: TotalsSnapshot): Promise<void> {
  await systemSet(db, TOTALS_SNAPSHOT_KEY, JSON.stringify(snapshot));
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

/**
 * Logs a delivery that passed the signature check, and keeps its time in
 * `system` as well. The nightly job prunes webhook_events after 7 days, so on
 * a quiet deployment the rows alone can't tell "Meta has never reached us"
 * from "nobody has commented this week".
 */
export async function logVerifiedWebhook(db: D1Database, now: number, object: string | null, preview: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO webhook_events (received_at, status, object, preview, error)
         VALUES (?, 'received', ?, ?, NULL)`,
      )
      .bind(now, object, preview),
    db
      .prepare('INSERT INTO system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(LAST_WEBHOOK_KEY, String(now)),
  ]);
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

const BAD_SIG_LOG_SECONDS = 60;

/**
 * Logs a POST whose signature matched neither app secret, unless one was
 * logged in the last minute. Anyone can send these, and a row each would let
 * them spend D1's daily write allowance, after which sends fail too. One a
 * minute is still enough to show Meta retrying with a secret we don't have.
 *
 * The minute is checked in D1, not in a module variable: Cloudflare runs many
 * isolates at once, and each would keep its own. The check is one indexed
 * read, a refused insert writes nothing, and the statement is atomic, so a
 * burst still logs one row.
 */
export async function logBadSignature(db: D1Database, now: number, preview: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO webhook_events (received_at, status, object, preview, error)
       SELECT ?1, 'bad_sig', NULL, ?2, 'signature did not match Instagram or Facebook app secret'
       WHERE NOT EXISTS (SELECT 1 FROM webhook_events WHERE status = 'bad_sig' AND received_at > ?1 - ?3)`,
    )
    .bind(now, preview, BAD_SIG_LOG_SECONDS)
    .run();
}

/**
 * The newest deliveries that carried a signature, newest first. Unsigned
 * POSTs are no longer logged, but older rows stay until the weekly prune.
 */
export async function latestSignedWebhookStatuses(db: D1Database, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT status FROM webhook_events
       WHERE status IN ('received', 'bad_sig')
       ORDER BY received_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<{ status: string }>();
  return (results ?? []).map((r) => r.status);
}

/**
 * Deletes an account with its rules, its sends, and the logged webhooks that
 * name it. Only selftest's fake account is ever removed this way: a real one
 * keeps its history when it's paused.
 */
export async function purgeAccount(db: D1Database, igUserId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM sent WHERE ig_user_id = ?').bind(igUserId),
    db.prepare('DELETE FROM rules WHERE ig_user_id = ?').bind(igUserId),
    db.prepare('DELETE FROM accounts WHERE ig_user_id = ?').bind(igUserId),
    // The preview is the body's first 200 characters, and entry[0].id falls
    // well inside them.
    db.prepare('DELETE FROM webhook_events WHERE instr(preview, ?) > 0').bind(`"id":"${igUserId}"`),
  ]);
}

export async function pruneWebhookEvents(db: D1Database, olderThan: number): Promise<void> {
  await db.prepare('DELETE FROM webhook_events WHERE received_at < ?').bind(olderThan).run();
}

/** Which of these comments already have a row. */
export async function knownComments(db: D1Database, commentIds: string[]): Promise<Set<string>> {
  if (commentIds.length === 0) return new Set();
  const { results } = await db
    .prepare('SELECT comment_id FROM sent WHERE comment_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(commentIds))
    .all<{ comment_id: string }>();
  return new Set((results ?? []).map((r) => r.comment_id));
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
      `SELECT comment_id, ig_user_id, rule_id, commenter_id, dm_status, reply_status, error, sent_at,
              attempts, next_attempt_at, comment_at, username
       FROM sent WHERE comment_id = ?`,
    )
    .bind(commentId)
    .first<Sent>();
}

// --- The send queue ----------------------------------------------------------

// Repeated word for word wherever the queue is read: SQLite only uses a
// partial index (idx_sent_queue) when the query's WHERE has the index's own
// condition in it.
const IN_QUEUE = "dm_status IN ('queued', 'retry')";

/**
 * A row its caller has just moved to `pending`, with what sending its DM
 * needs: its rule's text as it is now, or nulls once the rule is deleted,
 * and how many other rules' public replies wait for the DM.
 */
export type ClaimedSend = {
  comment_id: string;
  ig_user_id: string;
  rule_id: number | null;
  username: string | null;
  comment_at: number | null;
  dm_text: string | null;
  public_reply_text: string | null;
  rule_active: number | null;
  extra_replies: number;
  attempts: number;
};

/**
 * Writes the row for a comment a rule matched, unless the comment has one.
 * As `pending`, the insert is the caller's claim: it holds a budget slot and
 * sends now, before `leaseUntil`. As `queued`, it waits for the cron, in
 * order of when the comment was made. Resolves true when this call wrote it.
 */
export async function insertSend(
  db: D1Database,
  row: {
    comment_id: string;
    ig_user_id: string;
    commenter_id: string | null;
    rule_id: number;
    username: string | null;
    comment_at: number;
    dm_status: 'pending' | 'queued';
    now: number;
    leaseUntil: number;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO sent (comment_id, ig_user_id, rule_id, commenter_id, dm_status, reply_status, error, sent_at,
                         attempts, next_attempt_at, comment_at, username)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 0, ?, ?, ?)
       ON CONFLICT(comment_id) DO NOTHING`,
    )
    .bind(
      row.comment_id,
      row.ig_user_id,
      row.rule_id,
      row.commenter_id,
      row.dm_status,
      row.now,
      row.dm_status === 'pending' ? row.leaseUntil : row.comment_at,
      row.comment_at,
      row.username,
    )
    .run();
  return changedRows(result) > 0;
}

/** Records a matched comment that gets no DM, and why, unless the comment already has a row. */
export async function insertSettled(
  db: D1Database,
  row: {
    comment_id: string;
    ig_user_id: string;
    commenter_id: string | null;
    rule_id: number | null;
    dm_status: 'skipped' | 'failed';
    reply_status: string | null;
    error: string;
    now: number;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO sent (comment_id, ig_user_id, rule_id, commenter_id, dm_status, reply_status, error, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(comment_id) DO NOTHING`,
    )
    .bind(row.comment_id, row.ig_user_id, row.rule_id, row.commenter_id, row.dm_status, row.reply_status, row.error, row.now)
    .run();
  return changedRows(result) > 0;
}

/**
 * Takes up to `want` of an account's DM calls in `minute` (minutes since the
 * epoch), never more than `cap` in one minute, and none while Instagram has
 * the account paused. Resolves how many it took. The window only moves
 * forward, so a Worker whose clock is a moment behind can't reopen a minute
 * that's already over. The read and the write are one batch, which D1 runs
 * with no other write in between.
 */
export async function reserveSends(
  db: D1Database,
  igUserId: string,
  minute: number,
  want: number,
  cap: number,
  now: number,
): Promise<number> {
  if (want <= 0) return 0;
  const [before, after] = await db.batch<{ minute: number; used: number }>([
    db.prepare('SELECT minute, used FROM send_budget WHERE ig_user_id = ?').bind(igUserId),
    db
      .prepare(
        `INSERT INTO send_budget (ig_user_id, minute, used) VALUES (?1, ?2, MIN(?3, ?4))
         ON CONFLICT(ig_user_id) DO UPDATE SET
           used = MIN(?4, CASE WHEN minute = excluded.minute THEN used ELSE 0 END + ?3),
           minute = excluded.minute
         WHERE paused_until <= ?5 AND token_held_until <= ?5
           AND (excluded.minute > minute OR (excluded.minute = minute AND used < ?4))
         RETURNING minute, used`,
      )
      .bind(igUserId, minute, want, cap, now),
  ]);
  const taken = after?.results?.[0];
  if (!taken) return 0;
  const previous = before?.results?.[0];
  return taken.used - (previous && previous.minute === minute ? previous.used : 0);
}

/** Gives back slots for DM calls that were never made, while their minute is still the account's current one. */
export function refundSendsStatement(db: D1Database, igUserId: string, minute: number, n: number): D1PreparedStatement {
  return db
    .prepare('UPDATE send_budget SET used = MAX(0, used - ?) WHERE ig_user_id = ? AND minute = ?')
    .bind(n, igUserId, minute);
}

/**
 * Claims up to `limit` of an account's queued sends that are due, oldest
 * comment first, and returns exactly the rows this statement moved to
 * `pending`. One statement, so two Workers draining at once can never both
 * get the same comment. The rules come back with the rows, saving the drain
 * a query per account.
 *
 * sent_at moves only when a row reaches ok, failed or skipped, the states
 * the totals count, so the claim and a release leave it, and its two
 * indexes, alone. Each row's final write still moves it past the totals
 * snapshot's cutoff, so nothing is counted twice or missed.
 */
export async function claimDueSends(
  db: D1Database,
  igUserId: string,
  now: number,
  limit: number,
  leaseUntil: number,
): Promise<ClaimedSend[]> {
  if (limit <= 0) return [];
  const { results } = await db
    .prepare(
      `UPDATE sent SET dm_status = 'pending', next_attempt_at = ?1
       WHERE comment_id IN (
         SELECT comment_id FROM sent
         WHERE ig_user_id = ?3 AND ${IN_QUEUE} AND next_attempt_at <= ?2
         ORDER BY next_attempt_at
         LIMIT ?4
       ) AND ${IN_QUEUE}
       RETURNING comment_id, ig_user_id, rule_id, username, comment_at, attempts,
                 (SELECT dm_text FROM rules WHERE rules.id = sent.rule_id) AS dm_text,
                 (SELECT public_reply_text FROM rules WHERE rules.id = sent.rule_id) AS public_reply_text,
                 (SELECT active FROM rules WHERE rules.id = sent.rule_id) AS rule_active,
                 (SELECT COUNT(*) FROM sent_extra_replies e
                  WHERE e.comment_id = sent.comment_id AND e.status = 'queued') AS extra_replies`,
    )
    .bind(leaseUntil, now, igUserId, limit)
    .all<ClaimedSend>();
  return (results ?? []).sort((a, b) => (a.comment_at ?? 0) - (b.comment_at ?? 0));
}

/**
 * Writes how a claimed send ended. Only a row still `pending` is touched, so
 * a send that outlived its lease leaves the lease's verdict in place.
 */
export async function recordSend(
  db: D1Database,
  commentId: string,
  patch: {
    dm_status: string;
    reply_status: string | null;
    error: string | null;
    /** Whether this was one of the comment's tries: a DM call whatever the answer, except a dead token. */
    attempted: boolean;
    next_attempt_at: number | null;
    now: number;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE sent SET dm_status = ?, reply_status = ?, error = ?, sent_at = ?, next_attempt_at = ?,
                       attempts = attempts + ?
       WHERE comment_id = ? AND dm_status = 'pending'`,
    )
    .bind(patch.dm_status, patch.reply_status, patch.error, patch.now, patch.next_attempt_at, patch.attempted ? 1 : 0, commentId)
    .run();
}

/** Puts claimed sends whose DM was never started back in the queue, in their old place. */
export function releaseSendsStatement(db: D1Database, commentIds: string[], now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE sent SET dm_status = CASE WHEN attempts > 0 THEN 'retry' ELSE 'queued' END,
                       next_attempt_at = COALESCE(comment_at, ?1)
       WHERE comment_id IN (SELECT value FROM json_each(?2)) AND dm_status = 'pending'`,
    )
    .bind(now, JSON.stringify(commentIds));
}

/** An account as the drain sees it: its token, its budget this minute, and whether anything is due. */
export type DrainAccount = Account & {
  budget_minute: number | null;
  budget_used: number | null;
  paused_until: number | null;
  due: number;
};

/**
 * The drain's first step, in one batch: gives up on sends whose lease ran
 * out (the Worker sending them was stopped, so the DM may have gone out and
 * is never sent again), skips queued sends for comments made before
 * `cutoff`, and those of paused accounts, which get no late replies, then
 * lists the accounts.
 *
 * A queued row waits until its comment's own time, and a retry until later
 * than that, so the expiry's range on idx_sent_queue holds every such row
 * and nothing else. A retry whose comment is older than its next try is
 * caught when it's claimed. The IN list has SQLite read that index one
 * account at a time rather than all of it.
 */
export async function sweepQueue(
  db: D1Database,
  now: number,
  cutoff: number,
  errors: { lease: string; expired: string; paused: string },
): Promise<DrainAccount[]> {
  const results = await db.batch<DrainAccount>([
    db
      .prepare(
        `UPDATE sent SET dm_status = 'unsure', error = ?1, next_attempt_at = NULL, attempts = attempts + 1, sent_at = ?2
         WHERE dm_status = 'pending' AND next_attempt_at <= ?2`,
      )
      .bind(errors.lease, now),
    db
      .prepare(
        `UPDATE sent SET dm_status = 'skipped', error = ?1, next_attempt_at = NULL, sent_at = ?2
         WHERE ig_user_id IN (SELECT ig_user_id FROM accounts) AND ${IN_QUEUE} AND next_attempt_at < ?3`,
      )
      .bind(errors.expired, now, cutoff),
    db
      .prepare(
        `UPDATE sent SET dm_status = 'skipped', error = ?1, next_attempt_at = NULL, sent_at = ?2
         WHERE ig_user_id IN (SELECT ig_user_id FROM accounts WHERE active <> 1) AND ${IN_QUEUE}`,
      )
      .bind(errors.paused, now),
    db
      .prepare(
        `SELECT a.ig_user_id, a.username, a.access_token_enc, a.token_iv, a.token_expires_at,
                a.active, a.connected_at, a.last_refreshed_at, a.needs_reconnect,
                b.minute AS budget_minute, b.used AS budget_used,
                MAX(COALESCE(b.paused_until, 0), COALESCE(b.token_held_until, 0)) AS paused_until,
                EXISTS (
                  SELECT 1 FROM sent
                  WHERE sent.ig_user_id = a.ig_user_id AND ${IN_QUEUE} AND next_attempt_at <= ?
                ) AS due
         FROM accounts a
         LEFT JOIN send_budget b ON b.ig_user_id = a.ig_user_id
         ORDER BY a.username COLLATE NOCASE`,
      )
      .bind(now),
  ]);
  return results[3]?.results ?? [];
}

/**
 * Holds an account's DMs back until `until`, or longer if it's already held:
 * `rate` after Instagram says it's sending too fast, `token` after its token
 * stopped working, which reconnecting lifts.
 */
export function holdSendsStatement(db: D1Database, igUserId: string, until: number, why: 'rate' | 'token'): D1PreparedStatement {
  const column = why === 'rate' ? 'paused_until' : 'token_held_until';
  return db
    .prepare(
      `INSERT INTO send_budget (ig_user_id, minute, used, ${column}) VALUES (?, 0, 0, ?)
       ON CONFLICT(ig_user_id) DO UPDATE SET ${column} = MAX(${column}, excluded.${column})`,
    )
    .bind(igUserId, until);
}

/**
 * Puts a send Instagram never confirmed back in the queue, because the
 * operator checked that the DM didn't arrive, with a fresh set of tries.
 * Only an `unsure` row, so a second press, or one on a row that has moved
 * on, does nothing.
 *
 * Home counts the row as failed until now. sent_at moves to now, so its next
 * outcome is counted after any totals snapshot's cutoff, and if the snapshot
 * already counted it as failed, that count comes off in the same batch.
 * changes() is the UPDATE's own count, so a second press takes nothing off.
 */
export async function retryUnsureSend(db: D1Database, commentId: string, now: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT ig_user_id, sent_at FROM sent WHERE comment_id = ? AND dm_status = 'unsure'")
    .bind(commentId)
    .first<{ ig_user_id: string; sent_at: number }>();
  if (!row) return false;
  const [result] = await db.batch([
    db
      .prepare(
        `UPDATE sent SET dm_status = 'retry', attempts = 0, next_attempt_at = ?1, sent_at = ?1, error = NULL, reply_status = NULL
         WHERE comment_id = ?2 AND dm_status = 'unsure'`,
      )
      .bind(now, commentId),
    db
      .prepare(
        `UPDATE system SET value = json_replace(value,
           '$.all.failed', MAX(0, json_extract(value, '$.all.failed') - 1),
           ?1, MAX(0, json_extract(value, ?1) - 1))
         WHERE key = ?2 AND changes() = 1 AND json_extract(value, '$.cutoff') > ?3`,
      )
      .bind(`$.accounts."${row.ig_user_id}".failed`, TOTALS_SNAPSHOT_KEY, row.sent_at),
  ]);
  return changedRows(result!) > 0;
}

/** What Home's Sending card shows for one account. */
export type QueueOverview = {
  ig_user_id: string;
  queued: number;
  retrying: number;
  oldest_comment_at: number | null;
  next_retry_at: number | null;
  calls_last_hour: number;
  paused_until: number;
};

/**
 * The queue per account, in one batch. Reads every waiting row, through
 * idx_sent_queue, and the last hour of sends, through idx_sent_account_time:
 * the backlog, not the history. A send's DM calls in the last hour are
 * counted once per row, which is close: a row is retried minutes apart at
 * the soonest.
 */
export async function queueOverview(db: D1Database, now: number): Promise<QueueOverview[]> {
  const [waiting, recent, budgets] = await db.batch<Record<string, number | string | null>>([
    db.prepare(
      `SELECT ig_user_id,
              COUNT(CASE WHEN dm_status = 'queued' THEN 1 END) AS queued,
              COUNT(CASE WHEN dm_status = 'retry' THEN 1 END) AS retrying,
              MIN(comment_at) AS oldest_comment_at,
              MIN(CASE WHEN dm_status = 'retry' THEN next_attempt_at END) AS next_retry_at
       FROM sent
       WHERE ig_user_id IN (SELECT ig_user_id FROM accounts) AND ${IN_QUEUE}
       GROUP BY ig_user_id`,
    ),
    db
      .prepare(
        `SELECT ig_user_id, COUNT(*) AS calls
         FROM sent
         WHERE ig_user_id IN (SELECT ig_user_id FROM accounts) AND sent_at >= ? AND attempts > 0
           AND dm_status IN ('ok', 'failed', 'unsure', 'retry')
         GROUP BY ig_user_id`,
      )
      .bind(now - 60 * 60),
    db.prepare('SELECT ig_user_id, paused_until FROM send_budget WHERE paused_until > ?').bind(now),
  ]);
  const byId = new Map<string, QueueOverview>();
  const get = (id: string) => {
    let o = byId.get(id);
    if (!o) {
      o = { ig_user_id: id, queued: 0, retrying: 0, oldest_comment_at: null, next_retry_at: null, calls_last_hour: 0, paused_until: 0 };
      byId.set(id, o);
    }
    return o;
  };
  const num = (v: number | string | null | undefined) => (v == null ? null : Number(v));
  for (const r of waiting?.results ?? []) {
    Object.assign(get(String(r.ig_user_id)), {
      queued: num(r.queued) ?? 0,
      retrying: num(r.retrying) ?? 0,
      oldest_comment_at: num(r.oldest_comment_at),
      next_retry_at: num(r.next_retry_at),
    });
  }
  for (const r of recent?.results ?? []) get(String(r.ig_user_id)).calls_last_hour = num(r.calls) ?? 0;
  for (const r of budgets?.results ?? []) get(String(r.ig_user_id)).paused_until = num(r.paused_until) ?? 0;
  return [...byId.values()];
}
