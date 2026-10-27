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

export type HealthSnapshot = {
  lastCronOkAt: number | null;
  lastPollOkAt: number | null;
  firstSeenAt: number | null;
  activeAccounts: number;
  needsReconnect: number;
};

export const HEALTH_FIRST_SEEN_KEY = 'health_first_seen_at';

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
         (SELECT value FROM system WHERE key = ?) AS first_seen_at,
         (SELECT COUNT(*) FROM accounts WHERE active = 1) AS active,
         (SELECT COUNT(*) FROM accounts WHERE needs_reconnect = 1 OR token_expires_at <= ?) AS needs_reconnect`,
    )
    .bind(HEALTH_FIRST_SEEN_KEY, now)
    .first<{
      last_cron_ok_at: string | null;
      last_poll_ok_at: string | null;
      first_seen_at: string | null;
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

/**
 * The same claim as tryClaimComment, per rule: true only for the one caller
 * that wrote the row, so that caller alone posts this rule's public reply.
 */
export async function claimExtraReply(db: D1Database, row: ExtraReply): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO sent_extra_replies (comment_id, rule_id, status, error, sent_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(comment_id, rule_id) DO NOTHING`,
    )
    .bind(row.comment_id, row.rule_id, row.status, row.error, row.sent_at)
    .run();
  const meta = result.meta as { changes?: number; rows_written?: number };
  return (meta.changes ?? meta.rows_written ?? 0) > 0;
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
 * Fails `pending` rows claimed in [claimedFrom, claimedBefore). Only `pending`
 * is touched, so a send that does finish late still records its real outcome.
 * The lower bound keeps this a range read on idx_sent_time: rows older than
 * the last totals snapshot were already swept.
 */
export async function failStalePending(
  db: D1Database,
  claimedFrom: number,
  claimedBefore: number,
  error: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE sent SET dm_status = 'failed', error = ?
       WHERE dm_status = 'pending' AND sent_at >= ? AND sent_at < ?`,
    )
    .bind(error, claimedFrom, claimedBefore)
    .run();
}

export async function recentSent(db: D1Database, limit: number): Promise<(Sent & { rule_label: string | null })[]> {
  const { results } = await db
    .prepare(
      `SELECT s.comment_id, s.ig_user_id, s.rule_id, s.commenter_id, s.dm_status, s.reply_status,
              s.error, s.sent_at, r.label AS rule_label
       FROM sent s
       LEFT JOIN rules r ON r.id = s.rule_id
       ORDER BY s.sent_at DESC, s.comment_id DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<Sent & { rule_label: string | null }>();
  return results ?? [];
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
      `COUNT(CASE WHEN ${inSpan} AND dm_status = 'failed' THEN 1 END) AS failed_${i}`,
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
