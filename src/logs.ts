import type { SentLogCursor, SentLogFilters } from './db.ts';

export const LOGS_PAGE_SIZE = 50;

export const LOG_STATUSES = ['ok', 'failed', 'skipped', 'queued', 'pending', 'retry', 'unsure'] as const;

/** Filter values as the form shows them and page links carry them. */
export type LogsForm = { status: string; ig_user_id: string; rule_id: string; from: string; to: string };

export type LogsQuery = {
  form: LogsForm;
  filters: SentLogFilters;
  cursor: SentLogCursor | null;
  /** Parts of the URL that were ignored, said in words the operator can act on. */
  notes: string[];
};

const ID = /^\d{1,15}$/;

/** Unix seconds at 00:00 UTC on a YYYY-MM-DD day, or null if it is not a real day. */
export function parseDay(raw: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  // Date.UTC rolls 2026-02-30 over into March instead of refusing it.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.getTime() / 1000;
}

export function parseLogsQuery(q: Record<string, string | undefined>): LogsQuery {
  const form: LogsForm = { status: '', ig_user_id: '', rule_id: '', from: '', to: '' };
  const filters: SentLogFilters = {};
  const notes: string[] = [];

  const status = q.status ?? '';
  if ((LOG_STATUSES as readonly string[]).includes(status)) {
    form.status = status;
    filters.status = status;
  }
  const igUserId = (q.ig_user_id ?? '').trim();
  if (igUserId) {
    form.ig_user_id = igUserId;
    filters.ig_user_id = igUserId;
  }
  const ruleId = q.rule_id ?? '';
  if (ID.test(ruleId)) {
    form.rule_id = ruleId;
    filters.rule_id = Number(ruleId);
  }

  for (const [field, name] of [
    ['from', 'From'],
    ['to', 'To'],
  ] as const) {
    const raw = (q[field] ?? '').trim();
    if (!raw) continue;
    const day = parseDay(raw);
    if (day === null) {
      notes.push(`The ${name} date “${raw}” isn’t a real date, so it was left out. Dates look like 2026-10-27.`);
      continue;
    }
    form[field] = raw;
    // "To" names the last day to include, so the bound is the midnight after it.
    filters[field] = field === 'from' ? day : day + 86400;
  }
  if (filters.from !== undefined && filters.to !== undefined && filters.from >= filters.to) {
    notes.push('The From date is after the To date, so nothing can match. Swap them to see that range.');
  }

  let cursor: SentLogCursor | null = null;
  for (const [key, dir] of [
    ['before', 'older'],
    ['after', 'newer'],
  ] as const) {
    const at = q[key];
    const id = q[`${key}_id`];
    if (at === undefined && id === undefined) continue;
    if (at && ID.test(at) && id) cursor = { dir, sent_at: Number(at), comment_id: id };
    else notes.push('That page link was cut short, so this starts from the newest sends.');
    break;
  }

  return { form, filters, cursor, notes };
}

export function logsHref(base: string, form: LogsForm, cursor?: SentLogCursor): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (value) params.set(key, value);
  }
  if (cursor) {
    const key = cursor.dir === 'older' ? 'before' : 'after';
    params.set(key, String(cursor.sent_at));
    params.set(`${key}_id`, cursor.comment_id);
  }
  const qs = params.toString();
  return qs ? `${base}/logs?${qs}` : `${base}/logs`;
}

/** Newer and Older links around a page of sends shown newest first. */
export function pageLinks(
  base: string,
  query: Pick<LogsQuery, 'form' | 'cursor'>,
  sends: { sent_at: number; comment_id: string }[],
  more: boolean,
): { newer: string | null; older: string | null } {
  const first = sends[0];
  const last = sends[sends.length - 1];
  if (!first || !last) return { newer: null, older: null };
  // `more` only covers the direction this page was read in. The other side has
  // rows because the cursor that led here was taken from one of them.
  const dir = query.cursor?.dir;
  const newer = dir === 'newer' ? more : dir === 'older';
  const older = dir === 'newer' ? true : more;
  return {
    newer: newer ? logsHref(base, query.form, { dir: 'newer', sent_at: first.sent_at, comment_id: first.comment_id }) : null,
    older: older ? logsHref(base, query.form, { dir: 'older', sent_at: last.sent_at, comment_id: last.comment_id }) : null,
  };
}
