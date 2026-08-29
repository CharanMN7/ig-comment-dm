import type { Rule } from './types.ts';

/**
 * Drop diacritics from Latin letters only, leaving every other script alone.
 *
 * A blanket `NFD` + strip-every-`\p{Diacritic}` corrupts more than it fixes:
 * Cyrillic `й` becomes `и` and Japanese `が` becomes `か` — different letters,
 * not accented ones — while in Devanagari, Thai and Arabic the combining marks
 * are load-bearing vowels rather than decoration.
 *
 * So the mark is only dropped when the base character it attaches to is a
 * Basic Latin letter. `NFD` puts that base immediately before the mark, which
 * is what makes the test a single lookbehind.
 */
function foldLatinDiacritics(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/(?<=[A-Za-z])\p{Diacritic}/gu, '')
      // Back to composed form, so what leaves here is canonical rather than
      // half-decomposed. Matching would work either way — both sides run
      // through this — but the untouched scripts should come out exactly as
      // they went in.
      .normalize('NFC')
  );
}

export function normalizeCommentText(text: string): string {
  return foldLatinDiacritics(text)
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

export function keywordMatches(normalizedComment: string, keyword: string): boolean {
  const k = normalizeCommentText(keyword);
  if (!k) return false;
  const re = new RegExp(`\\b${escapeRegex(k)}\\b`, 'u');
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
