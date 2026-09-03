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

export function keywordMatches(normalizedComment: string, keyword: string): boolean {
  const k = normalizeCommentText(keyword);
  if (!k) return false;
  const re = new RegExp(`\\b${escapeRegex(k)}\\b`, 'u');
  return re.test(normalizedComment);
}

/** A rule whose keywords matched, but which an exclusion word ruled out. */
export type ExcludedRule = { rule: Rule; keyword: string };

export type MatchOutcome = {
  /** The rule that will act, or null. */
  rule: Rule | null;
  /** Rules that would have matched but were excluded, in the order tried. */
  excluded: ExcludedRule[];
};

/**
 * Media-scoped rules (matching this post) win over rules with no media_id.
 * First match inside that order wins; stop looking.
 *
 * Exclusions are checked per rule, and an excluded rule does not stop the
 * search: matching continues to the next rule. That is the deliberate answer to
 * #22's design question. The alternative -- one rule's exclusion suppressing
 * the whole comment -- would let a narrow rule silently veto every other rule
 * on the account, which is a surprising amount of power for a field presented
 * as "skip these words". Excluding is scoped to the rule that declares it.
 *
 * A rule is excluded only if its keywords matched in the first place, so the
 * caller can report "rule A matched but was skipped because of X" rather than
 * listing every rule that was never in the running.
 */
export function matchRule(
  rules: Rule[],
  commentText: string,
  mediaId: string | undefined,
): MatchOutcome {
  const normalized = normalizeCommentText(commentText);
  const scoped = rules.filter((r) => r.media_id != null && r.media_id !== '' && r.media_id === mediaId);
  const global = rules.filter((r) => r.media_id == null || r.media_id === '');
  const excluded: ExcludedRule[] = [];
  for (const rule of [...scoped, ...global]) {
    const hit = parseKeywords(rule.keywords).some((kw) => keywordMatches(normalized, kw));
    if (!hit) continue;
    const blocker = parseKeywords(rule.exclude_keywords ?? '[]').find((kw) =>
      keywordMatches(normalized, kw),
    );
    if (blocker !== undefined) {
      excluded.push({ rule, keyword: blocker });
      continue;
    }
    return { rule, excluded };
  }
  return { rule: null, excluded };
}

/** The rule that will act, or null. See {@link matchRule} for why one was not chosen. */
export function findMatchingRule(
  rules: Rule[],
  commentText: string,
  mediaId: string | undefined,
): Rule | null {
  return matchRule(rules, commentText, mediaId).rule;
}

export const KEYWORD_TOO_SHORT_MESSAGE =
  "Keywords under 3 characters match inside other words — 'AI' would fire on 'again' and 'email'.";
