import type { Rule } from './types.ts';

export function normalizeCommentText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/[\uFE0F\u200D]/g, ' ')
    .replace(/\p{P}/gu, ' ')
    .replace(/\p{S}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseKeywords(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === 'string');
  } catch {
    return [];
  }
}

/**
 * A character that would make the keyword part of a longer word: any Unicode
 * letter or digit.
 *
 * This replaces `\b`, which JavaScript defines as a boundary against
 * `[A-Za-z0-9_]` and does **not** widen under the `u` flag. For a keyword in
 * any non-Latin script both sides of the boundary are non-ASCII, so `\b` never
 * asserted and the match failed silently.
 */
/**
 * Scripts written without spaces between words.
 *
 * A word boundary is not merely a weaker signal in these scripts — it does not
 * exist. `指南` inside `请发指南给我` is a normal, correct occurrence with a
 * letter hard against it on both sides, so requiring a boundary there rejects
 * every real comment. A character from one of these scripts therefore does not
 * count as swallowing the keyword into a longer word.
 *
 * The consequence is deliberate and worth stating: a Japanese keyword `ガイド`
 * also matches inside `ガイドライン`. That is the same trade-off
 * `KEYWORD_TOO_SHORT_MESSAGE` already warns about for short Latin keywords, and
 * the alternative — matching nothing at all — is the bug being fixed.
 */
const SEPARATORLESS_CLASS =
  '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}' +
  '\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}]';

/**
 * What may sit against the keyword without swallowing it into a longer word:
 * the start or end of the text, a non-word character, or a character from a
 * script that does not separate its words.
 *
 * Expressed as an allowlist rather than as a negated `[\p{L}\p{N}]` because the
 * exclusion needs set subtraction, and the `v` flag that provides it is newer
 * than the runtimes this has to work on.
 */
const BOUNDARY_BEFORE = `(?<=^|[^\\p{L}\\p{N}]|${SEPARATORLESS_CLASS})`;
const BOUNDARY_AFTER = `(?=$|[^\\p{L}\\p{N}]|${SEPARATORLESS_CLASS})`;

export function keywordMatches(normalizedComment: string, keyword: string): boolean {
  const k = normalizeCommentText(keyword);
  if (!k) return false;
  // Lookaround rather than `\b`, so the boundary is decided by the Unicode
  // properties of the neighbouring characters instead of by the ASCII range.
  const re = new RegExp(`${BOUNDARY_BEFORE}${escapeRegex(k)}${BOUNDARY_AFTER}`, 'u');
  return re.test(normalizedComment);
}

/**
 * Media-scoped rules (matching this post) win over rules with no media_id.
 * First match inside that order wins; stop looking.
 */
export function findMatchingRule(
  rules: Rule[],
  commentText: string,
  mediaId: string | undefined,
): Rule | null {
  const normalized = normalizeCommentText(commentText);
  const scoped = rules.filter((r) => r.media_id != null && r.media_id !== '' && r.media_id === mediaId);
  const global = rules.filter((r) => r.media_id == null || r.media_id === '');
  for (const rule of [...scoped, ...global]) {
    for (const kw of parseKeywords(rule.keywords)) {
      if (keywordMatches(normalized, kw)) return rule;
    }
  }
  return null;
}

export const KEYWORD_TOO_SHORT_MESSAGE =
  "Keywords under 3 characters match inside other words — 'AI' would fire on 'again' and 'email'.";
