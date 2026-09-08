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

/** How a rule's keywords are matched against a comment. */
export type MatchMode = 'word' | 'contains';

/**
 * `word` is the default everywhere: it is what stops `AI` firing on `again`.
 * Anything unrecognised falls back to it, so a bad value read from an older
 * row or a hand-edited database cannot quietly widen a rule's reach.
 */
export function parseMatchMode(raw: unknown): MatchMode {
  return raw === 'contains' ? 'contains' : 'word';
}

export function keywordMatches(
  normalizedComment: string,
  keyword: string,
  mode: MatchMode = 'word',
): boolean {
  const k = normalizeCommentText(keyword);
  if (!k) return false;
  if (mode === 'contains') {
    // No word boundaries, so `launch` catches `#launch2026` and `guide` catches
    // `guides`. `#` is stripped by normalisation, which is why the hashtag case
    // works at all. The 3-character floor still applies at the form, and matters
    // more here: a 2-character substring would match almost every comment.
    return normalizedComment.includes(k);
  }
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
    const mode = parseMatchMode(rule.match_mode);
    for (const kw of parseKeywords(rule.keywords)) {
      if (keywordMatches(normalized, kw, mode)) return rule;
    }
  }
  return null;
}

export const KEYWORD_TOO_SHORT_MESSAGE =
  "Keywords under 3 characters match inside other words — 'AI' would fire on 'again' and 'email'.";
