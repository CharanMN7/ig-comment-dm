import type { MatchMode, Rule } from './types.ts';

// These letters are single code points with no NFD decomposition, so stripping
// combining marks never reaches them: `dien` would not match `điện` otherwise.
const STROKE_LETTER_FOLD: Readonly<Record<string, string>> = {
  'đ': 'd', 'Đ': 'D', // U+0111, U+0110
  'ð': 'd', 'Ð': 'D', // U+00F0, U+00D0: Icelandic eth, not the Đ above
  'ł': 'l', 'Ł': 'L',
  'ø': 'o', 'Ø': 'O',
  'ß': 'ss', 'ẞ': 'SS',
  'þ': 'th', 'Þ': 'TH',
};
const STROKE_LETTER = new RegExp(`[${Object.keys(STROKE_LETTER_FOLD).join('')}]`, 'g');

export function normalizeCommentText(text: string): string {
  return text
    .normalize('NFD')
    // Before the mark strip, so ǿ (ø plus a combining acute) loses its acute too.
    .replace(STROKE_LETTER, (c) => STROKE_LETTER_FOLD[c] ?? c)
    .replace(/([A-Za-z])\p{Diacritic}+/gu, '$1')
    .normalize('NFC')
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
 * This replaces `\b`, which JavaScript defines as a boundary against
 * `[A-Za-z0-9_]` and does **not** widen under the `u` flag. For a keyword in
 * any non-Latin script both sides of the boundary are non-ASCII, so `\b` never
 * asserted and the match failed silently.
 *
 * Expressed as an allowlist rather than as a negated `[\p{L}\p{N}]` because the
 * exclusion needs set subtraction, and the `v` flag that provides it is newer
 * than the runtimes this has to work on.
 */
const BOUNDARY_BEFORE = `(?<=^|[^\\p{L}\\p{N}]|${SEPARATORLESS_CLASS})`;
const BOUNDARY_AFTER = `(?=$|[^\\p{L}\\p{N}]|${SEPARATORLESS_CLASS})`;

/**
 * `re` is the whole-word pattern. A `contains` keyword needs no pattern, only
 * its normalised text, so its `re` is always null.
 */
export type CompiledKeyword = { normalized: string; re: RegExp | null };

/**
 * Every comment is matched against every keyword, and a keyword compiles to the
 * same pattern each time, so each distinct keyword is normalised and compiled
 * once per isolate rather than once per comment.
 *
 * Bounded because the keys are whatever operators type, and an isolate can
 * outlive many rule edits. Clearing past the cap is cruder than LRU but costs
 * nothing per lookup, and a real rule set is far smaller than the cap.
 */
export const KEYWORD_CACHE_MAX = 2000;
const keywordCache = new Map<string, CompiledKeyword>();

export function compileKeyword(keyword: string, mode: MatchMode = 'word'): CompiledKeyword {
  // The mode prefix is from a fixed set and ends at the first colon, so no
  // keyword in one mode can collide with a different keyword in the other.
  const key = `${mode}:${keyword}`;
  const cached = keywordCache.get(key);
  if (cached) return cached;
  if (keywordCache.size >= KEYWORD_CACHE_MAX) keywordCache.clear();
  const normalized = normalizeCommentText(keyword);
  // Lookaround rather than `\b`, so the boundary is decided by the Unicode
  // properties of the neighbouring characters instead of by the ASCII range.
  // Never add the `g` or `y` flag: this one RegExp is shared by every comment,
  // and `test()` on either advances `lastIndex`, so a match would depend on
  // which comment came before it.
  const re = normalized && mode === 'word'
    ? new RegExp(`${BOUNDARY_BEFORE}${escapeRegex(normalized)}${BOUNDARY_AFTER}`, 'u')
    : null;
  const entry = { normalized, re };
  keywordCache.set(key, entry);
  return entry;
}

/**
 * Both sides are normalised the same way, so in `contains` mode `#launch2026`
 * is already `launch2026` here and a plain substring test is the whole match.
 */
export function keywordMatches(normalizedComment: string, keyword: string, mode: MatchMode = 'word'): boolean {
  const { normalized, re } = compileKeyword(keyword, mode);
  if (mode === 'contains') return normalized !== '' && normalizedComment.includes(normalized);
  return re !== null && re.test(normalizedComment);
}

export function isMatchMode(value: string): value is MatchMode {
  return value === 'word' || value === 'contains';
}

/** `keyword` is null when the rule replies to every comment on its post. */
export type RuleMatch = { rule: Rule; keyword: string | null };

/** A rule whose keyword matched, passed over because one of its exclusions matched too. */
export type RuleExclusion = { rule: Rule; keyword: string | null; exclusion: string };

export type MatchVerdict = { match: RuleMatch | null; excluded: RuleExclusion[] };

function firstMatching(normalizedComment: string, keywords: string[], mode: MatchMode): string | null {
  for (const keyword of keywords) {
    if (keywordMatches(normalizedComment, keyword, mode)) return keyword;
  }
  return null;
}

/**
 * The one matcher. The webhook, the 5-minute sweep and the Test page all go
 * through it, so a comment can never be skipped by one and answered by another.
 *
 * A comment on a boosted post's ad carries the ad's own media id, which no
 * rule names: the post picker lists organic posts. `originalMediaId` is the
 * post the ad was made from, so a rule scoped to that post still answers the
 * traffic the boost paid for. Its rules go before any scoped to the ad's id,
 * since the original is the post the operator picked.
 *
 * Order: keyword rules scoped to this post, then keyword rules for all posts,
 * then rules that reply to every comment on this post. The first to match
 * fires. A match-all rule comes last so a specific keyword on the same post,
 * or an account-wide keyword rule, still gets its own message out. A match-all
 * rule with no post is never considered: account-wide it would DM every
 * commenter on every post, and the admin form refuses to save one.
 *
 * Exclusions belong to their rule, not to the account, and apply to match-all
 * rules too. A rule whose keyword matches but whose exclusion also matches is
 * passed over, and matching carries on in the same order, so a later rule
 * without that exclusion can still fire. That keeps a rule's effect readable
 * from its own form: adding "how much" to the guide rule cannot silently mute
 * the launch rule. Every rule passed over is returned, so a skip can say which
 * exclusion caused it.
 */
export function matchComment(
  rules: Rule[],
  commentText: string,
  mediaId: string | undefined,
  originalMediaId?: string,
): MatchVerdict {
  const normalized = normalizeCommentText(commentText);
  const hasPost = (r: Rule) => r.media_id != null && r.media_id !== '';
  const posts = [...new Set([originalMediaId, mediaId])].filter((id): id is string => id != null && id !== '');
  const scoped = posts.flatMap((post) => rules.filter((r) => hasPost(r) && r.media_id === post));
  const global = rules.filter((r) => !hasPost(r));
  const ordered = [
    ...scoped.filter((r) => r.match_all !== 1),
    ...global.filter((r) => r.match_all !== 1),
    ...scoped.filter((r) => r.match_all === 1),
  ];
  const excluded: RuleExclusion[] = [];
  for (const rule of ordered) {
    const matchAll = rule.match_all === 1;
    const keyword = matchAll ? null : firstMatching(normalized, parseKeywords(rule.keywords), rule.match_mode);
    if (!matchAll && keyword === null) continue;
    const exclusion = firstMatching(normalized, parseKeywords(rule.exclude_keywords), rule.match_mode);
    if (exclusion !== null) {
      excluded.push({ rule, keyword, exclusion });
      continue;
    }
    return { match: { rule, keyword }, excluded };
  }
  return { match: null, excluded };
}

/**
 * Recorded on the skipped `sent` row. A skip is final, like any other outcome,
 * so the sweep never reconsiders it, and Home shows the operator why a comment
 * that mentioned a keyword got nothing.
 */
export function exclusionSkipReason(excluded: RuleExclusion): string {
  return `Skipped: matched exclusion “${excluded.exclusion}”`;
}

/**
 * An exclusion found inside a keyword's own text excludes every comment that
 * keyword could ever match, so the keyword is dead on arrival. Caught at save
 * time because at match time it looks exactly like a working exclusion.
 */
export function keywordSwallowedBy(
  keywords: string[],
  exclusions: string[],
  mode: MatchMode,
): { keyword: string; exclusion: string } | null {
  for (const keyword of keywords) {
    const exclusion = firstMatching(normalizeCommentText(keyword), exclusions, mode);
    if (exclusion !== null) return { keyword, exclusion };
  }
  return null;
}

export const KEYWORD_MIN_LENGTH = 3;

/**
 * Chinese and Japanese write most words in two characters (`指南` is "guide",
 * `链接` is "link"), and the 3-character floor refused them. The floor is there
 * so a short keyword doesn't fire inside longer words, but these scripts have
 * no word edges, so a keyword fires inside longer words at any length (see
 * SEPARATORLESS_CLASS). Each of their characters is a whole syllable or
 * morpheme, so two already make a word; a lone one turns up inside far too
 * many words to mean anything.
 *
 * Thai, Lao, Khmer and Myanmar have no word edges either, but keep the floor:
 * their vowels and tone marks are code points of their own, so two code points
 * are often a single syllable. `ดี` ("good") would fire inside `สวัสดี`
 * ("hello"). A mixed keyword like `a指` keeps it too: the exemption is for
 * words in these scripts, not for a Latin letter attached to one.
 */
export const CJK_KEYWORD_MIN_LENGTH = 2;

const ALL_CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u;

export const KEYWORD_TOO_SHORT_MESSAGE =
  "Keywords need at least 3 characters, or 2 in Chinese and Japanese. Shorter ones match inside other words — 'AI' would fire on 'again' and 'email'.";

export const EXCLUSION_TOO_SHORT_MESSAGE =
  'Exclusions have the same minimum length as keywords: 3 characters, or 2 in Chinese and Japanese. Try a short phrase instead, like “no thanks”.';

const HAS_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

/**
 * Measured on the normalised keyword, because that is the text that gets
 * matched: `AI!!` is four characters as typed and two once punctuation goes.
 * Counted in code points so a character outside the BMP counts once.
 *
 * Normalising drops emoji and punctuation, so `🔥🔥🔥` or `!!!` would pass a
 * raw length check and then never match anything. A stray combining mark can
 * survive normalising without being a letter, hence the explicit test rather
 * than only checking for an empty string.
 */
export function keywordProblem(keyword: string, tooShortMessage = KEYWORD_TOO_SHORT_MESSAGE): string | null {
  const normalized = normalizeCommentText(keyword);
  if (!HAS_LETTER_OR_NUMBER.test(normalized)) {
    return `“${keyword}” has no letters or numbers. Emoji and punctuation are ignored when matching, so it could never match. Use a word instead.`;
  }
  const min = ALL_CJK.test(normalized) ? CJK_KEYWORD_MIN_LENGTH : KEYWORD_MIN_LENGTH;
  if ([...normalized].length < min) return tooShortMessage;
  return null;
}
