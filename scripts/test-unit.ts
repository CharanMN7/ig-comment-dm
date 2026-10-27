import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DM_TEXT_MAX,
  PUBLIC_REPLY_MAX,
  hmacSha256Hex,
  randomIndex,
  timingSafeEqualString,
  verifyHmacSha256Hex,
  verifyMetaSignature,
  verifyMetaSignatureAny,
} from '../src/crypto.ts';
import { findConfigProblems } from '../src/config.ts';
import { FREE_ATTEMPTS, describeLock, lockRemaining, lockSecondsFor } from '../src/throttle.ts';
import type { Env } from '../src/types.ts';
import {
  META_CALL_MAX_MS,
  META_MIN_ATTEMPT_MS,
  META_TIMEOUT_MS,
  attemptTimeoutMs,
  authorizeUrl,
  oauthRedirectUri,
} from '../src/meta.ts';
import { STALE_PENDING_SECONDS } from '../src/cron.ts';
import { isSelfComment } from '../src/guard.ts';
import { sentLogQuery } from '../src/db.ts';
import { logsHref, pageLinks, parseDay, parseLogsQuery } from '../src/logs.ts';
import { WEBHOOK_SEND_BUDGET_MS, parseWebhookPayload } from '../src/process.ts';
import { POLL_BUDGET_MS } from '../src/reconcile.ts';
import {
  EXCLUSION_TOO_SHORT_MESSAGE,
  KEYWORD_CACHE_MAX,
  KEYWORD_TOO_SHORT_MESSAGE,
  compileKeyword,
  escapeRegex,
  exclusionSkipReason,
  isMatchMode,
  keywordMatches,
  keywordProblem,
  keywordSwallowedBy,
  matchComment,
  normalizeCommentText,
} from '../src/match.ts';
import {
  USERNAME_GROWTH,
  cleanUsername,
  countUsernameTokens,
  fillPlaceholders,
  worstCaseLength,
} from '../src/placeholders.ts';
import { parsePublicReplies, pickReply, serializePublicReplies } from '../src/replies.ts';
import { MATCH_ALL_NEEDS_POST_MESSAGE, readRuleFields } from '../src/routes/admin.ts';
import { LINK_MARKER, TEMPLATES, findTemplate, placeholderLinkIn, type RuleTemplate } from '../src/templates.ts';
import type { Rule } from '../src/types.ts';

function rule(partial: Partial<Rule> & Pick<Rule, 'id' | 'keywords' | 'label'>): Rule {
  return {
    ig_user_id: 'acct',
    match_mode: 'word',
    exclude_keywords: '[]',
    match_all: 0,
    media_id: null,
    dm_text: 'hello',
    public_reply_text: null,
    active: 1,
    created_at: 0,
    ...partial,
  };
}

describe('isSelfComment', () => {
  it('returns true when from.id equals the account ig_user_id', () => {
    assert.equal(isSelfComment('17841400000', '17841400000'), true);
  });

  it('returns false when the commenter is someone else', () => {
    assert.equal(isSelfComment('111', '17841400000'), false);
  });

  it('returns false when the commenter id is missing', () => {
    assert.equal(isSelfComment(undefined, '17841400000'), false);
    assert.equal(isSelfComment(null, '17841400000'), false);
    assert.equal(isSelfComment('', '17841400000'), false);
  });

  it('does not treat similar-but-different ids as self', () => {
    assert.equal(isSelfComment('17841400000', '17841400001'), false);
  });
});

describe('normalizeCommentText', () => {
  it('lowercases, strips emoji and punctuation, collapses whitespace', () => {
    assert.equal(normalizeCommentText('  Guide PLEASE!!! 🙌  '), 'guide please');
  });

  it('folds Latin diacritics but preserves non-Latin combining marks', () => {
    assert.equal(normalizeCommentText('PREÇO café über'), 'preco cafe uber');
    assert.equal(normalizeCommentText('й が क़ ไทย'), 'й が क़ ไทย');
  });
});

describe('normalizeCommentText: stroke and bar letters', () => {
  // NFD has nothing to split in these, so the combining-mark fold alone left
  // them as they were. Escapes keep the two look-alike capitals apart.
  const letters: Array<[string, string, string]> = [
    ['\u0111', 'd', 'đ U+0111'],
    ['\u0110', 'd', 'Đ U+0110 (Vietnamese, Croatian)'],
    ['\u0142', 'l', 'ł U+0142'],
    ['\u0141', 'l', 'Ł U+0141'],
    ['\u00F8', 'o', 'ø U+00F8'],
    ['\u00D8', 'o', 'Ø U+00D8'],
    ['\u00DF', 'ss', 'ß U+00DF'],
    ['\u1E9E', 'ss', 'ẞ U+1E9E'],
    ['\u00F0', 'd', 'ð U+00F0'],
    ['\u00D0', 'd', 'Ð U+00D0 (Icelandic eth)'],
    ['\u00FE', 'th', 'þ U+00FE'],
    ['\u00DE', 'th', 'Þ U+00DE'],
  ];

  for (const [letter, folded, name] of letters) {
    it(`folds ${name} to ${folded}`, () => {
      assert.equal(normalizeCommentText(letter), folded);
    });
  }

  it('folds a precomposed letter whose NFD base is a stroke letter', () => {
    // ǿ decomposes to ø plus a combining acute, so the acute only goes if ø
    // has already become o by the time combining marks are stripped.
    assert.equal(normalizeCommentText('\u01FF'), 'o');
    assert.equal(normalizeCommentText('\u01FE'), 'o');
  });

  it('folds whole words in Latin-script languages', () => {
    assert.equal(normalizeCommentText('Điện thoại'), 'dien thoai');
    assert.equal(normalizeCommentText('Đà Nẵng, tiếng Việt'), 'da nang tieng viet');
    assert.equal(normalizeCommentText('Smørrebrød i København'), 'smorrebrod i kobenhavn');
    assert.equal(normalizeCommentText('ØL'), 'ol');
    assert.equal(normalizeCommentText('Łódź'), 'lodz');
    assert.equal(normalizeCommentText('STRAẞE Straße'), 'strasse strasse');
    assert.equal(normalizeCommentText('Þórður'), 'thordur');
  });

  it('leaves non-Latin letters and their combining marks untouched', () => {
    const unchanged: Array<[string, string]> = [
      ['Cyrillic й (и plus breve)', 'й'],
      ['Cyrillic ђ (looks like đ)', 'ђорђе'],
      ['Devanagari nukta and virama', 'ज़रूर नमस्ते'],
      ['Thai tone marks', 'คู่มือ ภาษาไทย'],
      ['Japanese dakuten and handakuten', 'ガイドください パン'],
      ['Greek tonos', 'οδηγός ελληνικά'],
      ['Arabic harakat', 'مَرْحَبًا الدليل'],
    ];
    for (const [name, text] of unchanged) {
      assert.equal(normalizeCommentText(text), text, name);
    }
  });
});

describe('keyword matching', () => {
  it('matches a whole word after normalize', () => {
    const n = normalizeCommentText('Please send the GUIDE!');
    assert.equal(keywordMatches(n, 'guide'), true);
  });

  it('does not match inside other words', () => {
    const n = normalizeCommentText('email me again');
    assert.equal(keywordMatches(n, 'AI'), false);
    assert.equal(keywordMatches(n, 'mail'), false);
  });

  it('matches across stroke and bar letters in either direction', () => {
    const pairs: Array<[string, string]> = [
      ['dien', 'Điện thoại mới'],
      ['lodz', 'jadę do Łodzi, łódź'],
      ['strasse', 'in der Straße 5'],
      ['thing', 'ÞING'],
    ];
    for (const [plain, accented] of pairs) {
      assert.equal(keywordMatches(normalizeCommentText(accented), plain), true, `${plain} in ${accented}`);
    }
    assert.equal(keywordMatches(normalizeCommentText('dien thoai moi'), 'điện'), true);
    assert.equal(keywordMatches(normalizeCommentText('lodz please'), 'łódź'), true);
    assert.equal(keywordMatches(normalizeCommentText('Straße'), 'strasse'), true);
    assert.equal(keywordMatches(normalizeCommentText('strasse'), 'Straße'), true);
    assert.equal(keywordMatches(normalizeCommentText('thing'), 'ÞING'), true);
  });

  it('escapes regex metacharacters in keywords', () => {
    assert.equal(escapeRegex('c++'), 'c\\+\\+');
    const n = normalizeCommentText('love c++ here');
    // punctuation stripped, so c++ becomes c
    assert.equal(normalizeCommentText('love c++ here'), 'love c here');
    assert.equal(keywordMatches(n, 'c++'), true);
  });
});

describe('keyword matching across scripts', () => {
  // Every one of these silently failed before: `` is defined against
  // [A-Za-z0-9_] and does not widen under the `u` flag, so for a keyword whose
  // edges are non-ASCII the boundary never asserted.
  const spaceUsing: Array<[string, string, string]> = [
    ['Cyrillic', 'гид', 'нужен гид пожалуйста'],
    ['Arabic', 'الدليل', 'أريد الدليل'],
    ['Korean', '가이드', '가이드 주세요'],
    ['Devanagari', 'मार्गदर्शन', 'मुझे मार्गदर्शन चाहिए'],
    ['Greek', 'οδηγός', 'θέλω τον οδηγός'],
  ];

  for (const [script, keyword, comment] of spaceUsing) {
    it(`matches a ${script} keyword`, () => {
      assert.equal(keywordMatches(normalizeCommentText(comment), keyword), true);
    });
  }

  // Scripts with no spaces between words. A boundary does not exist here, so
  // requiring one rejects every real comment.
  const separatorless: Array<[string, string, string]> = [
    ['Chinese', '指南', '请发指南给我'],
    ['Japanese', 'ガイド', 'ガイドください'],
    ['Thai', 'คู่มือ', 'ขอคู่มือหน่อย'],
  ];

  for (const [script, keyword, comment] of separatorless) {
    it(`matches a ${script} keyword with no separator around it`, () => {
      assert.equal(keywordMatches(normalizeCommentText(comment), keyword), true);
    });
  }

  it('still refuses a substring in a script that does use spaces', () => {
    // The boundary is widened, not removed.
    assert.equal(keywordMatches(normalizeCommentText('нужен гидроцикл'), 'гид'), false);
    assert.equal(keywordMatches(normalizeCommentText('가이드북 주세요'), '가이드'), false);
    assert.equal(keywordMatches(normalizeCommentText('guidebook here'), 'guide'), false);
  });

  it('accepts a separatorless neighbour around a Latin keyword', () => {
    // Japanese runs Latin words straight into kana with no space, so treating a
    // kana neighbour as word-forming would reject the ordinary case.
    assert.equal(
      keywordMatches(normalizeCommentText('新しいiphoneケースが欲しい'), 'iphoneケース'),
      true,
    );
  });

  it('records that a separatorless keyword matches inside a longer word', () => {
    // Deliberate, not an oversight: there is no boundary available to consult.
    // The same trade-off KEYWORD_TOO_SHORT_MESSAGE describes for short Latin
    // keywords, and far better than matching nothing at all.
    assert.equal(keywordMatches(normalizeCommentText('ガイドライン'), 'ガイド'), true);
  });

  it('matches at the very start and end of the text', () => {
    assert.equal(keywordMatches(normalizeCommentText('гид'), 'гид'), true);
    assert.equal(keywordMatches(normalizeCommentText('指南'), '指南'), true);
  });
});

describe('compiled keyword cache', () => {
  it('normalises and compiles a keyword once, then hands back the same entry', () => {
    const first = compileKeyword('Free GUIDE!');
    assert.equal(first.normalized, 'free guide');
    assert.equal(compileKeyword('Free GUIDE!'), first);
    keywordMatches('free guide please', 'Free GUIDE!');
    assert.equal(compileKeyword('Free GUIDE!'), first);
  });

  it('keeps the shared RegExp stateless, so a match never depends on the comment before it', () => {
    assert.equal(compileKeyword('guide').re?.flags, 'u');
    // A `g` or `y` flag would make the second call resume from lastIndex and miss.
    const n = normalizeCommentText('guide please');
    assert.equal(keywordMatches(n, 'guide'), true);
    assert.equal(keywordMatches(n, 'guide'), true);
    assert.equal(keywordMatches(normalizeCommentText('the guide'), 'guide'), true);
  });

  it('caches contains mode separately, with its normalised text and no pattern', () => {
    const contains = compileKeyword('#Launch', 'contains');
    assert.deepEqual(contains, { normalized: 'launch', re: null });
    assert.equal(compileKeyword('#Launch', 'contains'), contains);
    keywordMatches('launch2026', '#Launch', 'contains');
    assert.equal(compileKeyword('#Launch', 'contains'), contains);
    assert.notEqual(compileKeyword('#Launch', 'word'), contains);
    assert.ok(compileKeyword('#Launch', 'word').re);
  });

  it('caches a keyword that normalises to nothing as one that never matches', () => {
    assert.deepEqual(compileKeyword('🙏!!'), { normalized: '', re: null });
    assert.equal(keywordMatches('anything at all', '🙏!!'), false);
  });

  it('starts over past the cap instead of growing without limit', () => {
    const first = compileKeyword('cap-test-0');
    for (let i = 1; i <= KEYWORD_CACHE_MAX; i++) compileKeyword(`cap-test-${i}`);
    const again = compileKeyword('cap-test-0');
    assert.notEqual(again, first);
    assert.deepEqual(again, first);
  });
});

describe('contains mode', () => {
  const contains = (comment: string, keyword: string) =>
    keywordMatches(normalizeCommentText(comment), keyword, 'contains');

  it('finds a keyword inside a hashtag or a longer word', () => {
    assert.equal(contains('So ready for #launch2026!', 'launch'), true);
    assert.equal(contains('Send me the guides', 'guide'), true);
    assert.equal(contains('#LAUNCHDAY', 'launch'), true);
  });

  it('is the trade-off the form warns about', () => {
    assert.equal(contains('where do I start', 'art'), true);
  });

  it('leaves whole-word mode as strict as before', () => {
    assert.equal(keywordMatches(normalizeCommentText('So ready for #launch2026!'), 'launch', 'word'), false);
    assert.equal(keywordMatches(normalizeCommentText('Send me the guides'), 'guide', 'word'), false);
    assert.equal(keywordMatches(normalizeCommentText('Send me the guides'), 'guide'), false);
    assert.equal(keywordMatches(normalizeCommentText('Send me the guide'), 'guide', 'word'), true);
  });

  it('normalises the keyword and the comment the same way', () => {
    assert.equal(contains('PREÇOS por favor', 'preco'), true);
    assert.equal(contains('in der Straßenbahn', 'strasse'), true);
    assert.equal(contains('free-guide-pack', 'Free Guide'), true);
  });

  it('matches inside longer words in non-Latin scripts too', () => {
    // Whole-word mode refuses each of these; contains mode is the opt-in.
    const pairs: Array<[string, string]> = [
      ['гид', 'нужен гидроцикл'],
      ['가이드', '가이드북 주세요'],
      ['الدليل', '#الدليل2026'],
      ['οδηγ', 'θέλω τον οδηγό'],
    ];
    for (const [keyword, comment] of pairs) {
      assert.equal(contains(comment, keyword), true, `${keyword} in ${comment}`);
      assert.equal(keywordMatches(normalizeCommentText(comment), keyword, 'word'), false, `${keyword} as a word in ${comment}`);
    }
    assert.equal(contains('请发指南给我', '指南'), true);
  });

  it('does not match across a space the keyword lacks', () => {
    assert.equal(contains('free guide', 'freeguide'), false);
  });

  it('never matches a keyword that normalises to nothing', () => {
    assert.equal(contains('anything 🙏 at all', '🙏!!'), false);
  });
});

describe('isMatchMode', () => {
  it('accepts the two modes and nothing else', () => {
    assert.equal(isMatchMode('word'), true);
    assert.equal(isMatchMode('contains'), true);
    for (const value of ['', 'Word', 'regex', 'partial']) assert.equal(isMatchMode(value), false, value);
  });
});

describe('keywordProblem', () => {
  it('accepts a keyword with at least 3 characters once normalised', () => {
    for (const keyword of ['guide', 'Free guide', 'гид', 'ガイド', 'été']) {
      assert.equal(keywordProblem(keyword), null, keyword);
    }
  });

  it('measures the normalised keyword, not what was typed', () => {
    assert.equal(keywordProblem('AI'), KEYWORD_TOO_SHORT_MESSAGE);
    assert.equal(keywordProblem('AI!!'), KEYWORD_TOO_SHORT_MESSAGE);
    assert.equal(keywordProblem('#ai'), KEYWORD_TOO_SHORT_MESSAGE);
    assert.equal(keywordProblem('c++'), KEYWORD_TOO_SHORT_MESSAGE);
    assert.equal(keywordProblem('ai🔥'), KEYWORD_TOO_SHORT_MESSAGE);
  });

  it('refuses a keyword with no letter or number, which could never match', () => {
    for (const keyword of ['🔥🔥🔥', '!!!', '#️⃣#️⃣#️⃣', '...', '\u0301\u0301\u0301']) {
      assert.match(keywordProblem(keyword) ?? '', /has no letters or numbers/, JSON.stringify(keyword));
    }
  });

  it('can name the field in its too-short message', () => {
    assert.equal(keywordProblem('no', EXCLUSION_TOO_SHORT_MESSAGE), EXCLUSION_TOO_SHORT_MESSAGE);
    assert.equal(keywordProblem('no thanks', EXCLUSION_TOO_SHORT_MESSAGE), null);
  });

  it('counts digits as characters', () => {
    assert.equal(keywordProblem('2026'), null);
    assert.equal(keywordProblem('#42'), KEYWORD_TOO_SHORT_MESSAGE);
  });

  it('accepts two characters in Chinese and Japanese', () => {
    for (const keyword of ['指南', '链接', 'メモ', 'いい', '指南!!', '#指南']) {
      assert.equal(keywordProblem(keyword), null, keyword);
    }
    assert.equal(keywordProblem('指南', EXCLUSION_TOO_SHORT_MESSAGE), null);
  });

  it('still refuses a single Chinese or Japanese character', () => {
    for (const keyword of ['指', 'メ', '指!!', '指🔥']) {
      assert.equal(keywordProblem(keyword), KEYWORD_TOO_SHORT_MESSAGE, keyword);
    }
    assert.equal(keywordProblem('不', EXCLUSION_TOO_SHORT_MESSAGE), EXCLUSION_TOO_SHORT_MESSAGE);
  });

  it('holds Thai and the other scripts whose marks are code points to 3, since 2 is often one syllable', () => {
    // ดี ("good") is ด plus a vowel mark, and would fire inside สวัสดี ("hello").
    for (const keyword of ['ดี', 'ลด', 'ก', 'ໄປ']) {
      assert.equal(keywordProblem(keyword), KEYWORD_TOO_SHORT_MESSAGE, keyword);
    }
    for (const keyword of ['ฟรี', 'คู่มือ']) {
      assert.equal(keywordProblem(keyword), null, keyword);
    }
  });

  it('holds a keyword that mixes in any other script to 3 characters', () => {
    for (const keyword of ['a指', '指1', '指ก', 'ai']) {
      assert.equal(keywordProblem(keyword), KEYWORD_TOO_SHORT_MESSAGE, keyword);
    }
    for (const keyword of ['ai指', '指南a']) {
      assert.equal(keywordProblem(keyword), null, keyword);
    }
  });
});

describe('matchComment', () => {
  const global = rule({ id: 1, label: 'global', keywords: JSON.stringify(['guide']), dm_text: 'global-dm' });
  const scoped = rule({
    id: 2,
    label: 'scoped',
    keywords: JSON.stringify(['guide']),
    media_id: 'MEDIA1',
    dm_text: 'scoped-dm',
  });

  it('prefers a media-scoped rule over a global rule', () => {
    const hit = matchComment([global, scoped], 'guide please', 'MEDIA1').match;
    assert.equal(hit?.rule.id, 2);
    assert.equal(hit?.rule.dm_text, 'scoped-dm');
  });

  it('falls back to a global rule on other posts', () => {
    const hit = matchComment([global, scoped], 'guide please', 'OTHER').match;
    assert.equal(hit?.rule.id, 1);
  });

  it('returns the first matching rule and stops', () => {
    const a = rule({ id: 10, label: 'a', keywords: JSON.stringify(['hello']) });
    const b = rule({ id: 11, label: 'b', keywords: JSON.stringify(['hello']) });
    const hit = matchComment([a, b], 'hello there', undefined).match;
    assert.equal(hit?.rule.id, 10);
  });

  it('returns null when nothing matches', () => {
    assert.deepEqual(matchComment([global], 'nice photo', undefined), { match: null, excluded: [] });
  });

  it('names the keyword that matched, as the operator typed it', () => {
    const r = rule({ id: 3, label: 'launch', keywords: JSON.stringify(['Guide', 'LAUNCH']), match_mode: 'contains' });
    assert.deepEqual(matchComment([r], 'so ready for #launch2026', undefined), {
      match: { rule: r, keyword: 'LAUNCH' },
      excluded: [],
    });
  });

  it('uses each rule\'s own match mode', () => {
    const word = rule({ id: 4, label: 'word', keywords: JSON.stringify(['launch']) });
    const contains = rule({ id: 5, label: 'contains', keywords: JSON.stringify(['launch']), match_mode: 'contains' });
    assert.equal(matchComment([word, contains], '#launch2026', undefined).match?.rule.id, 5);
    assert.equal(matchComment([word, contains], 'launch day', undefined).match?.rule.id, 4);
    assert.equal(matchComment([word], '#launch2026', undefined).match, null);
  });
});

describe('exclusions', () => {
  const guide = rule({
    id: 20,
    label: 'guide',
    keywords: JSON.stringify(['guide']),
    exclude_keywords: JSON.stringify(['how much', 'already have']),
  });

  it('stops a rule whose keyword matched, and says which exclusion did it', () => {
    assert.deepEqual(matchComment([guide], 'How much is the GUIDE??', undefined), {
      match: null,
      excluded: [{ rule: guide, keyword: 'guide', exclusion: 'how much' }],
    });
  });

  it('leaves the rule alone when no exclusion matches', () => {
    assert.equal(matchComment([guide], 'guide please', undefined).match?.rule.id, 20);
  });

  it('only counts a rule as excluded when its keyword matched', () => {
    assert.deepEqual(matchComment([guide], 'how much for a shoutout', undefined), { match: null, excluded: [] });
  });

  it('uses the same normalisation as keywords', () => {
    assert.equal(matchComment([guide], 'I ALREADY-HAVE the guide 🙏', undefined).match, null);
    const accented = rule({ id: 21, label: 'preco', keywords: JSON.stringify(['guia']), exclude_keywords: JSON.stringify(['preco']) });
    assert.equal(matchComment([accented], 'qual o PREÇO do guia?', undefined).match, null);
  });

  it("uses the rule's own match mode", () => {
    const word = rule({ id: 22, label: 'word', keywords: JSON.stringify(['guide']), exclude_keywords: JSON.stringify(['price']) });
    const contains = { ...word, id: 23, match_mode: 'contains' as const };
    // "prices" is not the whole word "price", so only the contains rule is stopped.
    assert.equal(matchComment([word], 'guide prices?', undefined).match?.rule.id, 22);
    assert.deepEqual(matchComment([contains], 'guide prices?', undefined).excluded.map((e) => e.exclusion), ['price']);
  });

  it('works in non-Latin scripts', () => {
    const cyrillic = rule({ id: 24, label: 'гид', keywords: JSON.stringify(['гид']), exclude_keywords: JSON.stringify(['сколько']) });
    assert.equal(matchComment([cyrillic], 'Сколько стоит гид?', undefined).match, null);
    assert.equal(matchComment([cyrillic], 'нужен гид', undefined).match?.rule.id, 24);
  });

  it('is per rule: a later rule without that exclusion still fires', () => {
    const scoped = { ...guide, id: 25, label: 'scoped guide', media_id: 'MEDIA1' };
    const fallback = rule({ id: 26, label: 'any guide', keywords: JSON.stringify(['guide']) });
    const verdict = matchComment([fallback, scoped], 'how much is the guide', 'MEDIA1');
    assert.equal(verdict.match?.rule.id, 26);
    assert.deepEqual(verdict.excluded, [{ rule: scoped, keyword: 'guide', exclusion: 'how much' }]);
  });

  it('lists every rule passed over, in matching order, when none fires', () => {
    const other = rule({ id: 27, label: 'other', keywords: JSON.stringify(['guide']), exclude_keywords: JSON.stringify(['how much']) });
    const verdict = matchComment([guide, other], 'how much is the guide', undefined);
    assert.equal(verdict.match, null);
    assert.deepEqual(verdict.excluded.map((e) => e.rule.id), [20, 27]);
  });

  it('treats a rule saved before exclusions existed as having none', () => {
    const old = rule({ id: 28, label: 'old', keywords: JSON.stringify(['guide']), exclude_keywords: '' });
    assert.equal(matchComment([old], 'how much is the guide', undefined).match?.rule.id, 28);
  });

  it('writes the skip reason the operator sees on Home', () => {
    assert.equal(
      exclusionSkipReason({ rule: guide, keyword: 'guide', exclusion: 'how much' }),
      'Skipped: matched exclusion “how much”',
    );
  });
});

describe('match-all rules', () => {
  const giveaway = rule({ id: 30, label: 'giveaway', keywords: '[]', match_all: 1, media_id: 'REEL1' });

  it('match every comment on their post, with no keyword', () => {
    assert.deepEqual(matchComment([giveaway], 'love this 😍', 'REEL1'), { match: { rule: giveaway, keyword: null }, excluded: [] });
    assert.equal(matchComment([giveaway], '🔥', 'REEL1').match?.rule.id, 30);
    assert.equal(matchComment([giveaway], '', 'REEL1').match?.rule.id, 30);
  });

  it('ignore any keywords stored on the rule', () => {
    const stale = { ...giveaway, keywords: JSON.stringify(['guide']) };
    assert.equal(matchComment([stale], 'love this', 'REEL1').match?.rule.id, 30);
  });

  it('never fire on other posts, or when the post is unknown', () => {
    assert.equal(matchComment([giveaway], 'love this', 'REEL2').match, null);
    assert.equal(matchComment([giveaway], 'love this', undefined).match, null);
  });

  it('never fire without a post, even if one reached the database', () => {
    const accountWide = { ...giveaway, media_id: null };
    assert.deepEqual(matchComment([accountWide], 'love this', 'REEL1'), { match: null, excluded: [] });
    assert.deepEqual(matchComment([{ ...giveaway, media_id: '' }], 'love this', 'REEL1'), { match: null, excluded: [] });
  });

  it('come after every keyword rule: post keyword, then all-posts keyword, then match-all', () => {
    const postKeyword = rule({ id: 31, label: 'post keyword', keywords: JSON.stringify(['guide']), media_id: 'REEL1' });
    const allPostsKeyword = rule({ id: 32, label: 'all posts keyword', keywords: JSON.stringify(['guide', 'price']) });
    // Listed match-all first and oldest, to show precedence is not row order.
    const rules = [giveaway, allPostsKeyword, postKeyword];
    assert.equal(matchComment(rules, 'guide please', 'REEL1').match?.rule.id, 31);
    assert.equal(matchComment(rules, 'price?', 'REEL1').match?.rule.id, 32);
    assert.equal(matchComment(rules, 'love it', 'REEL1').match?.rule.id, 30);
  });

  it('honour their own exclusions, as whole words', () => {
    const picky = { ...giveaway, exclude_keywords: JSON.stringify(['spam']) };
    assert.deepEqual(matchComment([picky], 'this is SPAM', 'REEL1'), {
      match: null,
      excluded: [{ rule: picky, keyword: null, exclusion: 'spam' }],
    });
    assert.equal(matchComment([picky], 'no spammers here', 'REEL1').match?.rule.id, 30);
  });

  it("are not stopped by another rule's exclusion", () => {
    const strict = rule({ id: 33, label: 'strict', keywords: JSON.stringify(['guide']), exclude_keywords: JSON.stringify(['how much']), media_id: 'REEL1' });
    const verdict = matchComment([strict, giveaway], 'how much is the guide', 'REEL1');
    assert.equal(verdict.match?.rule.id, 30);
    assert.deepEqual(verdict.excluded.map((e) => e.rule.id), [33]);
  });
});

describe('readRuleFields', () => {
  const valid = {
    ig_user_id: 'acct',
    label: 'Giveaway',
    keywords: '',
    match_mode: 'word',
    exclude_keywords: '',
    media_id: 'REEL1',
    dm_text: 'You are in!',
    public_reply_text: '',
  };

  it('rejects a match-all rule with no post', () => {
    assert.deepEqual(readRuleFields({ ...valid, match_all: '1', media_id: '' }), { error: MATCH_ALL_NEEDS_POST_MESSAGE });
    assert.deepEqual(readRuleFields({ ...valid, match_all: '1', media_id: '   ' }), { error: MATCH_ALL_NEEDS_POST_MESSAGE });
  });

  it('accepts a match-all rule on one post without keywords, and keeps none', () => {
    const read = readRuleFields({ ...valid, match_all: '1', keywords: 'AI\n🔥', match_mode: 'contains' });
    assert.ok('row' in read);
    assert.deepEqual(
      { keywords: read.row.keywords, match_mode: read.row.match_mode, match_all: read.row.match_all, media_id: read.row.media_id },
      { keywords: '[]', match_mode: 'word', match_all: 1, media_id: 'REEL1' },
    );
  });

  it('still checks the exclusions of a match-all rule', () => {
    assert.deepEqual(readRuleFields({ ...valid, match_all: '1', exclude_keywords: 'no' }), { error: EXCLUSION_TOO_SHORT_MESSAGE });
  });

  it('needs keywords when the box is not ticked, and stores match_all 0', () => {
    assert.deepEqual(readRuleFields(valid), { error: 'Add at least one keyword, one per line.' });
    const read = readRuleFields({ ...valid, keywords: 'guide', media_id: '' });
    assert.ok('row' in read);
    assert.equal(read.row.match_all, 0);
    assert.equal(read.row.media_id, null);
  });
});

describe('keywordSwallowedBy', () => {
  it('finds a keyword that one of its exclusions would always stop', () => {
    assert.deepEqual(keywordSwallowedBy(['free guide', 'pdf'], ['guide'], 'word'), { keyword: 'free guide', exclusion: 'guide' });
    assert.deepEqual(keywordSwallowedBy(['GUIDE!'], ['guide'], 'word'), { keyword: 'GUIDE!', exclusion: 'guide' });
    assert.deepEqual(keywordSwallowedBy(['guidebook'], ['guide'], 'contains'), { keyword: 'guidebook', exclusion: 'guide' });
  });

  it('allows exclusions that only sometimes overlap', () => {
    assert.equal(keywordSwallowedBy(['guide'], ['how much', 'guidebook'], 'word'), null);
    assert.equal(keywordSwallowedBy(['guidebook'], ['guide'], 'word'), null);
    assert.equal(keywordSwallowedBy(['guide'], [], 'word'), null);
  });
});

describe('fillPlaceholders: with a username', () => {
  it('puts the name in for every {username}', () => {
    assert.equal(fillPlaceholders('Hey {username}! Enjoy, {username}.', 'sarah'), 'Hey sarah! Enjoy, sarah.');
  });

  it('matches the token in any capitalisation', () => {
    assert.equal(fillPlaceholders('{Username} / {USERNAME} / {uSeRnAmE}', 'sarah'), 'sarah / sarah / sarah');
  });

  it('leaves unknown tokens, {link} and near-misses exactly as typed', () => {
    const text = 'Get it at {link} {foo} { username } {user name} {username';
    assert.equal(fillPlaceholders(text, 'sarah'), text);
    assert.equal(fillPlaceholders(text, null), text);
  });

  it('keeps an @ the creator typed, so @{username} becomes a mention', () => {
    assert.equal(fillPlaceholders('Thanks @{username}!', 'sarah.k_99'), 'Thanks @sarah.k_99!');
  });

  it('drops an @ Instagram put on the name, so it never doubles', () => {
    assert.equal(fillPlaceholders('Hi {username}', '@sarah'), 'Hi sarah');
  });

  it('does not read $ patterns in the name as replacement syntax', () => {
    assert.equal(cleanUsername('$&'), null);
    assert.equal(fillPlaceholders('Hi {username}', 'a$b'), 'Hi');
  });
});

describe('fillPlaceholders: with no usable username', () => {
  for (const [why, value] of [
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['not a string', 12345 as unknown as string],
    ['longer than Instagram allows', 'a'.repeat(31)],
    ['outside the username alphabet', 'sarah <b>'],
  ] as const) {
    it(`removes the token cleanly when the name is ${why}`, () => {
      const out = fillPlaceholders('Hey {username}, here is the guide', value);
      assert.equal(out, 'Hey, here is the guide');
      assert.doesNotMatch(out, /undefined|null|[{}]/);
    });
  }

  it('accepts a name of exactly 30 characters', () => {
    assert.equal(fillPlaceholders('Hi {username}', 'a'.repeat(30)), `Hi ${'a'.repeat(30)}`);
  });

  for (const [text, expected] of [
    ['Hey {username}, here you go', 'Hey, here you go'],
    ['Hey {username}! Here you go', 'Hey! Here you go'],
    ['Hey {username}. Here you go', 'Hey. Here you go'],
    ['Hey {username}', 'Hey'],
    ['Hey {username} here you go', 'Hey here you go'],
    ['Thanks, {username}!', 'Thanks!'],
    ['Thanks, {username}', 'Thanks'],
    ['Hi, {username}, here you go', 'Hi, here you go'],
    ['Hi @{username} welcome', 'Hi welcome'],
    ['Thanks @{username}!', 'Thanks!'],
    ['{username}, here you go', 'here you go'],
    ['{username} here you go', 'here you go'],
    ['¡Hola {username}!', '¡Hola!'],
    ['Merci {username} !', 'Merci !'],
    ['Hey{username} you', 'Hey you'],
    ['Hey {username}{username} you', 'Hey you'],
  ] as const) {
    it(`tidies only around the token: ${JSON.stringify(text)}`, () => {
      assert.equal(fillPlaceholders(text, null), expected);
    });
  }

  it('leaves every other space and line break the creator typed exactly as it was', () => {
    const text = '  Hi  there,\n\n\tHey {username}, the  guide:\nhttps://example.com  \n\n\nBye ';
    assert.equal(fillPlaceholders(text, null), '  Hi  there,\n\n\tHey, the  guide:\nhttps://example.com  \n\n\nBye ');
  });

  it('removes a line that held only the token, with its line break', () => {
    assert.equal(fillPlaceholders('Hi\n{username}\nHere you go', null), 'Hi\nHere you go');
    assert.equal(fillPlaceholders('{username}\nHere you go', null), 'Here you go');
    assert.equal(fillPlaceholders('Here you go\n@{username}', null), 'Here you go');
  });

  it('removes a paragraph that held only the token without leaving a double gap', () => {
    assert.equal(fillPlaceholders('Hi\n\n{username}\n\nHere you go', null), 'Hi\n\nHere you go');
    assert.equal(fillPlaceholders('{username}\n\nHere you go', null), 'Here you go');
    assert.equal(fillPlaceholders('Here you go\n\n{username}', null), 'Here you go');
    assert.equal(fillPlaceholders('Hi\r\n\r\n{username}\r\n\r\nThere', null), 'Hi\r\n\r\nThere');
  });

  it('can leave nothing at all, which the form refuses to save', () => {
    assert.equal(fillPlaceholders('{username}', null), '');
  });
});

describe('placeholder length', () => {
  it('counts every {username}, in any capitalisation', () => {
    assert.equal(countUsernameTokens('{username} {Username} {link} {foo}'), 2);
  });

  it('assumes each {username} grows to a 30-character name', () => {
    assert.equal(USERNAME_GROWTH, 20);
    assert.equal(worstCaseLength('plain'), 5);
    assert.equal(worstCaseLength('Hi {username} and @{USERNAME}'), 29 + 2 * 20);
    const longest = fillPlaceholders('Hi {username} and @{USERNAME}', 'a'.repeat(30));
    assert.equal(longest.length, worstCaseLength('Hi {username} and @{USERNAME}'));
  });
});

describe('parsePublicReplies', () => {
  it('reads no reply as an empty list', () => {
    assert.deepEqual(parsePublicReplies(null), []);
    assert.deepEqual(parsePublicReplies(undefined), []);
    assert.deepEqual(parsePublicReplies('  \n '), []);
  });

  it('reads a JSON array of non-empty strings as variations', () => {
    assert.deepEqual(parsePublicReplies('["Sent you a DM!","Check your inbox 📩"]'), ['Sent you a DM!', 'Check your inbox 📩']);
    assert.deepEqual(parsePublicReplies('["Line one\\nline two"," padded "]'), ['Line one\nline two', 'padded']);
  });

  it('reads a legacy multi-line reply as one reply, whole', () => {
    const legacy = 'Sent you a DM!\nCheck your message requests\n\n— Sam';
    assert.deepEqual(parsePublicReplies(legacy), [legacy]);
  });

  for (const stored of ['[]', '[""]', '["ok", "  "]', '["ok", 2]', '[["nested"]]', '[unclosed', '[see bio] for the link', '{"a":"b"}', 'null', '"quoted"']) {
    it(`never drops a configured reply that is not a clean array: ${stored}`, () => {
      assert.deepEqual(parsePublicReplies(stored), [stored]);
    });
  }
});

describe('serializePublicReplies', () => {
  it('stores nothing for no replies, and ignores blanks', () => {
    assert.equal(serializePublicReplies([]), null);
    assert.equal(serializePublicReplies(['', '  ']), null);
  });

  it('stores one reply as plain text, exactly as before variations', () => {
    assert.equal(serializePublicReplies(['', 'Sent you a DM!', ' ']), 'Sent you a DM!');
    assert.equal(serializePublicReplies(['Line one\n\nline two']), 'Line one\n\nline two');
  });

  it('stores two or more as a JSON array, in order', () => {
    assert.equal(serializePublicReplies(['One', '', 'Two', 'Three']), '["One","Two","Three"]');
  });

  for (const replies of [['One'], ['One', 'Two'], ['["a","b"]'], ['[]'], ['Hi\n[1]'], ['["a"]', 'b']]) {
    it(`reads back what it stored: ${JSON.stringify(replies)}`, () => {
      assert.deepEqual(parsePublicReplies(serializePublicReplies(replies)), replies);
    });
  }
});

describe('pickReply', () => {
  it('uses the random source to choose among variations', () => {
    const replies = ['a', 'b', 'c'];
    assert.equal(pickReply(replies, () => 0), 'a');
    assert.equal(pickReply(replies, () => 2), 'c');
    const asked: number[] = [];
    pickReply(replies, (n) => (asked.push(n), 1));
    assert.deepEqual(asked, [3]);
  });

  it('returns a lone reply without drawing, and nothing when there is none', () => {
    const never = () => assert.fail('no draw needed');
    assert.equal(pickReply(['only'], never), 'only');
    assert.equal(pickReply([], never), null);
  });

  it('defaults to crypto randomness and only ever picks a real variation', () => {
    const replies = ['a', 'b', 'c', 'd', 'e'];
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(pickReply(replies) ?? 'none');
    assert.deepEqual([...seen].sort(), replies);
  });
});

describe('randomIndex', () => {
  it('stays in range and reaches every index', () => {
    const counts = [0, 0, 0];
    for (let i = 0; i < 3000; i++) counts[randomIndex(3)]! += 1;
    assert.ok(counts.every((c) => c > 800), `uneven: ${counts.join(', ')}`);
    assert.equal(randomIndex(1), 0);
  });

  it('refuses a count it cannot draw from', () => {
    assert.throws(() => randomIndex(0), RangeError);
    assert.throws(() => randomIndex(2.5), RangeError);
  });
});

describe('rule templates', () => {
  const LINK = 'https://ana.studio/free-guide';
  const fill = (text: string, link: string) => text.replaceAll(LINK_MARKER, link);

  /** What the new-rule form posts for a template, with the creator's link put in. */
  function templateForm(t: RuleTemplate, link: string): Record<string, string> {
    const [main = '', ...more] = t.publicReplies;
    return {
      ig_user_id: 'acct',
      label: t.name,
      keywords: t.keywords.join('\n'),
      match_mode: 'word',
      exclude_keywords: t.exclusions.join('\n'),
      ...(t.matchAll ? { match_all: '1' } : {}),
      media_id: t.matchAll ? 'REEL1' : '',
      dm_text: fill(t.dm, link),
      public_reply_text: fill(main, link),
      ...Object.fromEntries(more.map((r, i) => [`public_reply_text_${String(i + 2)}`, fill(r, link)])),
    };
  }

  function templateRule(t: RuleTemplate): Rule {
    return rule({
      id: 1,
      label: t.name,
      keywords: JSON.stringify(t.keywords),
      exclude_keywords: JSON.stringify(t.exclusions),
      match_all: t.matchAll ? 1 : 0,
      media_id: t.matchAll ? 'REEL1' : null,
    });
  }

  it('offers six to eight, each with its own id', () => {
    assert.ok(TEMPLATES.length >= 6 && TEMPLATES.length <= 8, `${TEMPLATES.length} templates`);
    assert.equal(new Set(TEMPLATES.map((t) => t.id)).size, TEMPLATES.length);
    assert.equal(findTemplate('guide')?.name, 'Free guide');
    assert.equal(findTemplate('nope'), undefined);
    assert.equal(findTemplate(undefined), undefined);
  });

  for (const t of TEMPLATES) {
    it(`${t.id}: passes the rule form's checks once the link is put in, and saves as written`, () => {
      const read = readRuleFields(templateForm(t, LINK));
      assert.ok('row' in read, 'error' in read ? read.error : '');
      assert.deepEqual(
        {
          label: read.row.label,
          keywords: read.row.keywords,
          exclude_keywords: read.row.exclude_keywords,
          match_all: read.row.match_all,
          dm_text: read.row.dm_text,
          replies: parsePublicReplies(read.row.public_reply_text),
        },
        {
          label: t.name,
          keywords: JSON.stringify(t.keywords),
          exclude_keywords: JSON.stringify(t.exclusions),
          match_all: t.matchAll ? 1 : 0,
          dm_text: fill(t.dm, LINK),
          replies: t.publicReplies.map((r) => fill(r, LINK)),
        },
      );
    });

    it(`${t.id}: can't be saved with the link marker still in it`, () => {
      assert.ok(t.dm.includes(LINK_MARKER));
      const read = readRuleFields(templateForm(t, LINK_MARKER));
      assert.ok('error' in read);
      assert.match(read.error, new RegExp(`still says ${LINK_MARKER}`));
    });

    it(`${t.id}: fits Instagram's limits with a 30-character name and a 200-character link`, () => {
      const longLink = `https://${'x'.repeat(192)}`;
      assert.ok(worstCaseLength(fill(t.dm, longLink)) <= DM_TEXT_MAX);
      assert.ok(t.publicReplies.length >= 2 && t.publicReplies.length <= 5);
      for (const reply of t.publicReplies) assert.ok(worstCaseLength(fill(reply, longLink)) <= PUBLIC_REPLY_MAX);
    });
  }

  it('never share a keyword, so two rules from templates never compete for a comment', () => {
    const owner = new Map<string, string>();
    for (const t of TEMPLATES) {
      for (const k of t.keywords) {
        const key = normalizeCommentText(k);
        assert.equal(owner.get(key), undefined, `“${k}” is in both ${owner.get(key) ?? ''} and ${t.id}`);
        owner.set(key, t.id);
      }
    }
  });

  it('use no everyday words that would message people who never asked', () => {
    const everyday = ['send', 'link', 'call', 'book', 'join', 'early', 'food', 'order', 'info', 'yes', 'want', 'need', 'please', 'me'];
    for (const t of TEMPLATES) {
      for (const k of t.keywords) assert.ok(!everyday.includes(normalizeCommentText(k)), `${t.id}: “${k}”`);
    }
  });

  it('answer the free guide in English, Spanish and Hindi', () => {
    const guide = templateRule(findTemplate('guide')!);
    for (const comment of ['Guide please!', '¿Me pasas la guía? 🙏', 'Quero o guia', 'गाइड चाहिए', 'मुझे भी गाइड भेजो']) {
      assert.ok(matchComment([guide], comment, 'REEL9').match, comment);
    }
    assert.equal(matchComment([guide], 'community guidelines', 'REEL9').match, null);
  });

  it('skip people who say they are already on the waitlist', () => {
    const waitlist = templateRule(findTemplate('waitlist')!);
    assert.equal(matchComment([waitlist], 'waitlist please', undefined).match?.rule.id, 1);
    const verdict = matchComment([waitlist], 'Already on the waitlist!!', undefined);
    assert.equal(verdict.match, null);
    assert.equal(verdict.excluded[0]?.exclusion, 'already on the waitlist');
  });

  it('only the giveaway replies to every comment, and it needs its post', () => {
    assert.deepEqual(TEMPLATES.filter((t) => t.matchAll).map((t) => t.id), ['giveaway']);
    const giveaway = findTemplate('giveaway')!;
    assert.deepEqual(readRuleFields({ ...templateForm(giveaway, LINK), media_id: '' }), { error: MATCH_ALL_NEEDS_POST_MESSAGE });
  });
});

describe('placeholderLinkIn', () => {
  it('finds the template marker, however it is capitalised', () => {
    assert.equal(placeholderLinkIn(`Here: ${LINK_MARKER}`), LINK_MARKER);
    assert.equal(placeholderLinkIn('Here: paste-your-link-here'), LINK_MARKER);
  });

  it('finds sample addresses, with or without the scheme, as they were typed', () => {
    const cases: Array<[string, string]> = [
      ['Here it is: https://example.com/guide.', 'https://example.com/guide'],
      ['example.org', 'example.org'],
      ['Grab it at www.example.net/x!', 'www.example.net/x'],
      ['Mail hello@example.co.uk', 'example.co.uk'],
      ['Book: https://calendly.com/example/30min', 'https://calendly.com/example/30min'],
      ['linktr.ee/your-name', 'linktr.ee/your-name'],
      ['(https://YourWebsite.com/guide)', 'https://YourWebsite.com/guide'],
      ['http://shop.test/item', 'http://shop.test/item'],
    ];
    for (const [text, found] of cases) assert.equal(placeholderLinkIn(text), found, text);
  });

  it('leaves real links and ordinary text alone', () => {
    for (const text of [
      'Here it is: https://ana.studio/guide',
      'calendly.com/ana-coaching/intro',
      'https://www.instagram.com/p/abc/',
      'Doors open at 7.30, e.g. bring a mat.',
      'More examples on my page: https://examples.shop/x',
      'Your guide is on the way',
    ]) {
      assert.equal(placeholderLinkIn(text), null, text);
    }
  });

  it('stops a rule being saved with one, in the message or any reply, and names it', () => {
    const form = { ig_user_id: 'acct', label: 'Guide', keywords: 'guide', dm_text: 'Here: https://ana.studio/g', public_reply_text: 'Sent!' };
    assert.deepEqual(readRuleFields({ ...form, dm_text: 'Here: https://example.com/guide' }), {
      error: 'The DM links to “https://example.com/guide”, a sample address that isn’t yours. Replace it with your own link before saving.',
    });
    assert.deepEqual(readRuleFields({ ...form, public_reply_text: `Also at ${LINK_MARKER}` }), {
      error: `The public reply still says ${LINK_MARKER}. Replace it with your own link, or delete it, before saving.`,
    });
    const third = readRuleFields({ ...form, public_reply_text_2: 'Sent', public_reply_text_3: 'see yourshop.com' });
    assert.ok('error' in third);
    assert.match(third.error, /^Reply 3 links to “yourshop\.com”/);
    assert.ok('row' in readRuleFields(form));
  });
});

describe('oauthRedirectUri', () => {
  it('uses the request host, not PUBLIC_BASE_URL', () => {
    assert.equal(
      oauthRedirectUri(
        'https://ig-comment-dm.ig-comment-dm.workers.dev/connect',
        'https://example.com',
      ),
      'https://ig-comment-dm.ig-comment-dm.workers.dev/connect/callback',
    );
  });

  it('forces https except localhost', () => {
    assert.equal(
      oauthRedirectUri('http://ig-comment-dm.ig-comment-dm.workers.dev/a/secret/accounts'),
      'https://ig-comment-dm.ig-comment-dm.workers.dev/connect/callback',
    );
    assert.equal(
      oauthRedirectUri('http://localhost:8787/connect'),
      'http://localhost:8787/connect/callback',
    );
  });
});

describe('authorizeUrl', () => {
  it('matches Instagram Business Login required params', () => {
    const url = new URL(
      authorizeUrl({
        clientId: '990602627938098',
        redirectUri: 'https://ig-comment-dm.ig-comment-dm.workers.dev/connect/callback',
        state: 'abc',
        forceReauth: false,
      }),
    );
    assert.equal(url.origin + url.pathname, 'https://www.instagram.com/oauth/authorize');
    assert.equal(url.searchParams.get('client_id'), '990602627938098');
    assert.equal(
      url.searchParams.get('redirect_uri'),
      'https://ig-comment-dm.ig-comment-dm.workers.dev/connect/callback',
    );
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('enable_fb_login'), 'false');
    assert.equal(url.searchParams.get('force_reauth'), null);
  });
});

describe('stale pending sends', () => {
  it('bounds one Meta call by three timeouts plus the longest backoffs', () => {
    assert.equal(META_TIMEOUT_MS, 10_000);
    assert.equal(META_CALL_MAX_MS, 3 * 10_000 + 750 + 1_500);
  });

  it('waits far longer than the slowest possible send before calling a pending row abandoned', () => {
    const slowestSendMs = 2 * META_CALL_MAX_MS;
    assert.ok(STALE_PENDING_SECONDS * 1000 >= 10 * slowestSendMs, `${STALE_PENDING_SECONDS}s vs ${slowestSendMs}ms`);
  });
});

describe('send time budget', () => {
  const deadline = Date.UTC(2026, 9, 1, 12, 0, 25);

  it('gives an attempt its usual timeout when no deadline is set or the deadline is far off', () => {
    assert.equal(attemptTimeoutMs(undefined, deadline + 60_000), META_TIMEOUT_MS);
    assert.equal(attemptTimeoutMs(deadline, deadline - 25_000), META_TIMEOUT_MS);
    assert.equal(attemptTimeoutMs(deadline, deadline - META_TIMEOUT_MS), META_TIMEOUT_MS);
  });

  it('cuts an attempt down to the time left before the deadline', () => {
    assert.equal(attemptTimeoutMs(deadline, deadline - META_TIMEOUT_MS + 1), META_TIMEOUT_MS - 1);
    assert.equal(attemptTimeoutMs(deadline, deadline - 3_500), 3_500);
    assert.equal(attemptTimeoutMs(deadline, deadline - META_MIN_ATTEMPT_MS), META_MIN_ATTEMPT_MS);
  });

  it('starts no attempt with less than the minimum left, or once the deadline has passed', () => {
    assert.equal(attemptTimeoutMs(deadline, deadline - META_MIN_ATTEMPT_MS + 1), 0);
    assert.equal(attemptTimeoutMs(deadline, deadline), 0);
    assert.equal(attemptTimeoutMs(deadline, deadline + 5_000), 0);
  });

  it('ends a webhook\'s Meta calls with seconds to spare before Cloudflare stops waitUntil', () => {
    const waitUntilLimitMs = 30_000;
    assert.ok(waitUntilLimitMs - WEBHOOK_SEND_BUDGET_MS >= 5_000, `${WEBHOOK_SEND_BUDGET_MS}ms`);
    // Enough for two full attempts and the backoff between them, so the
    // budget only bites on a send that was already going badly.
    assert.ok(WEBHOOK_SEND_BUDGET_MS > 2 * META_TIMEOUT_MS + 750, `${WEBHOOK_SEND_BUDGET_MS}ms`);
  });

  it('ends a sweep before the next one starts, even with one more Instagram read begun at its deadline', () => {
    assert.ok(POLL_BUDGET_MS + META_CALL_MAX_MS < 5 * 60 * 1000, `${POLL_BUDGET_MS}ms`);
  });
});

describe('parseWebhookPayload', () => {
  it('quotes oversized numeric ids so they stay exact', () => {
    const parsed = parseWebhookPayload(
      '{"entry":[{"id":17841464780021342,"changes":[{"value":{"id":18074865634493149}}]}]}',
    ) as { entry: Array<{ id: string; changes: Array<{ value: { id: string } }> }> };
    assert.equal(parsed.entry[0]?.id, '17841464780021342');
    assert.equal(parsed.entry[0]?.changes[0]?.value.id, '18074865634493149');
  });

  it('leaves numbers inside strings alone, so comment text cannot break the quoting', () => {
    const parsed = parseWebhookPayload(
      '{"entry":[{"id":17841464780021342,"changes":[{"value":{"id":18074865634493149,"text":"order: 123456789012345 ok \\"x\\": 123456789012345678}"}}]}]}',
    ) as { entry: Array<{ id: string; changes: Array<{ value: { id: string; text: string } }> }> };
    assert.equal(parsed.entry[0]?.id, '17841464780021342');
    assert.equal(parsed.entry[0]?.changes[0]?.value.id, '18074865634493149');
    assert.equal(parsed.entry[0]?.changes[0]?.value.text, 'order: 123456789012345 ok "x": 123456789012345678}');
  });
});

describe('webhook HMAC', () => {
  it('verifies a matching signature and rejects a bad one', async () => {
    const secret = 'app-secret';
    const body = '{"object":"instagram"}';
    const hex = await hmacSha256Hex(secret, body);
    assert.equal(await verifyHmacSha256Hex(secret, body, hex), true);
    assert.equal(await verifyHmacSha256Hex(secret, body, '00'.repeat(32)), false);
    assert.equal(await verifyMetaSignature(secret, body, `sha256=${hex}`), true);
    assert.equal(await verifyMetaSignature(secret, body, `sha256=${'aa'.repeat(32)}`), false);
    assert.equal(await verifyMetaSignature(secret, body, null), false);
    assert.equal(await verifyMetaSignature(secret, body, hex), false);
  });

  it('accepts a signature from either of two secrets', async () => {
    const instagram = 'instagram-secret';
    const facebook = 'facebook-secret';
    const body = '{"object":"instagram"}';
    const fbHex = await hmacSha256Hex(facebook, body);
    assert.equal(
      await verifyMetaSignatureAny([facebook, instagram], body, `sha256=${fbHex}`),
      true,
    );
    assert.equal(
      await verifyMetaSignatureAny([facebook, instagram], body, `sha256=${'aa'.repeat(32)}`),
      false,
    );
    assert.equal(await verifyMetaSignatureAny([instagram], body, `sha256=${fbHex}`), false);
  });
});

function env(overrides: Partial<Env> = {}): Env {
  const key32 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const other32 = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
  return {
    DB: null as unknown as D1Database,
    META_APP_ID: '1234567890',
    META_APP_SECRET: 'ig-secret',
    FACEBOOK_APP_SECRET: 'fb-secret',
    WEBHOOK_VERIFY_TOKEN: 'verify',
    TOKEN_ENCRYPTION_KEY: key32,
    SESSION_SIGNING_KEY: other32,
    ADMIN_URL_SECRET: 'a'.repeat(32),
    PUBLIC_BASE_URL: 'https://worker.example.workers.dev',
    ...overrides,
  };
}

function problemSecrets(overrides: Partial<Env>): string[] {
  return findConfigProblems(env(overrides)).map((p) => p.secret);
}

describe('timingSafeEqualString', () => {
  it('matches identical strings and rejects everything else', () => {
    assert.equal(timingSafeEqualString('abc123', 'abc123'), true);
    assert.equal(timingSafeEqualString('abc123', 'abc124'), false);
    assert.equal(timingSafeEqualString('abc123', 'abc1234'), false);
    assert.equal(timingSafeEqualString('', ''), true);
    assert.equal(timingSafeEqualString('abc', ''), false);
  });

  it('handles multi-byte characters without throwing', () => {
    assert.equal(timingSafeEqualString('日本語', '日本語'), true);
    assert.equal(timingSafeEqualString('日本語', '日本誤'), false);
  });
});

describe('findConfigProblems', () => {
  it('reports nothing when every secret is well formed', () => {
    assert.deepEqual(findConfigProblems(env()), []);
  });

  it('flags a missing FACEBOOK_APP_SECRET, the usual cause of silence', () => {
    assert.deepEqual(problemSecrets({ FACEBOOK_APP_SECRET: '' }), ['FACEBOOK_APP_SECRET']);
  });

  it('flags a key that does not decode to 32 bytes', () => {
    // Valid base64, decodes to 9 bytes. Deliberately zero-entropy: a realistic
    // random-looking fixture here is indistinguishable from a leaked key to the
    // secret scanner in CI, and silencing that scanner is worse than an ugly
    // test value.
    assert.deepEqual(problemSecrets({ TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAA' }), [
      'TOKEN_ENCRYPTION_KEY',
    ]);
  });

  it('flags one key reused for both encryption and session signing', () => {
    const same = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    assert.deepEqual(
      problemSecrets({ TOKEN_ENCRYPTION_KEY: same, SESSION_SIGNING_KEY: same }),
      ['SESSION_SIGNING_KEY'],
    );
  });

  it('flags a short admin path secret', () => {
    assert.deepEqual(problemSecrets({ ADMIN_URL_SECRET: 'abc123' }), ['ADMIN_URL_SECRET']);
  });

  it('flags a trailing slash and a missing scheme on PUBLIC_BASE_URL', () => {
    assert.deepEqual(problemSecrets({ PUBLIC_BASE_URL: 'https://w.example.dev/' }), [
      'PUBLIC_BASE_URL',
    ]);
    assert.deepEqual(problemSecrets({ PUBLIC_BASE_URL: 'w.example.dev' }), ['PUBLIC_BASE_URL']);
  });

  it('reports an unset secret rather than silently accepting it', () => {
    assert.deepEqual(problemSecrets({ META_APP_ID: '   ' }), ['META_APP_ID']);
  });
});

describe('login throttle', () => {
  it('allows the first few attempts without any lock', () => {
    for (let attempt = 1; attempt <= FREE_ATTEMPTS; attempt++) {
      assert.equal(lockSecondsFor(attempt), 0, `attempt ${attempt} should not lock`);
    }
  });

  it('doubles the lock from one minute and caps it at an hour', () => {
    assert.equal(lockSecondsFor(FREE_ATTEMPTS + 1), 60);
    assert.equal(lockSecondsFor(FREE_ATTEMPTS + 2), 120);
    assert.equal(lockSecondsFor(FREE_ATTEMPTS + 3), 240);
    assert.equal(lockSecondsFor(FREE_ATTEMPTS + 20), 3600);
  });

  it('reports remaining lock time only while the lock is in the future', () => {
    assert.equal(lockRemaining({ fails: 9, lockedUntil: 1_000 }, 900), 100);
    assert.equal(lockRemaining({ fails: 9, lockedUntil: 1_000 }, 1_000), 0);
    assert.equal(lockRemaining({ fails: 0, lockedUntil: 0 }, 1_000), 0);
  });

  it('words the wait for the login page, one second included', () => {
    assert.equal(describeLock(1), '1 second');
    assert.equal(describeLock(45), '45 seconds');
    assert.equal(describeLock(60), '60 seconds');
    assert.equal(describeLock(61), '2 minutes');
    assert.equal(describeLock(119), '2 minutes');
    assert.equal(describeLock(240), '4 minutes');
  });
});

describe('logs date filters', () => {
  it('reads a YYYY-MM-DD day as midnight UTC', () => {
    assert.equal(parseDay('2026-10-27'), Date.UTC(2026, 9, 27) / 1000);
    assert.equal(parseDay('2028-02-29'), Date.UTC(2028, 1, 29) / 1000);
  });

  it('refuses days that do not exist instead of rolling them over', () => {
    for (const raw of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '0099-01-01']) {
      assert.equal(parseDay(raw), null, raw);
    }
  });

  it('refuses anything that is not exactly YYYY-MM-DD', () => {
    for (const raw of ['', '2026-1-5', '26-10-27', '2026/10/27', '2026-10-27T00:00', 'yesterday', 'NaN']) {
      assert.equal(parseDay(raw), null, raw);
    }
  });

  it('turns To into the midnight after that day, so the whole day is included', () => {
    const { filters, notes } = parseLogsQuery({ from: '2026-10-01', to: '2026-10-01' });
    assert.deepEqual(filters, { from: Date.UTC(2026, 9, 1) / 1000, to: Date.UTC(2026, 9, 2) / 1000 });
    assert.deepEqual(notes, []);
  });

  it('ignores a bad date with a note and keeps the other filters', () => {
    const q = parseLogsQuery({ status: 'failed', from: '2026-02-30', to: 'soon' });
    assert.deepEqual(q.filters, { status: 'failed' });
    assert.deepEqual(q.form, { status: 'failed', ig_user_id: '', rule_id: '', from: '', to: '' });
    assert.equal(q.notes.length, 2);
    assert.match(q.notes[0]!, /From date “2026-02-30” isn’t a real date/);
    assert.match(q.notes[1]!, /To date “soon”/);
  });

  it('says so when From is after To', () => {
    const { notes } = parseLogsQuery({ from: '2026-10-02', to: '2026-10-01' });
    assert.match(notes[0]!, /From date is after the To date/);
  });
});

describe('logs query', () => {
  it('drops statuses and rule ids it does not recognise', () => {
    const q = parseLogsQuery({ status: 'deleted', rule_id: '1 OR 1=1', ig_user_id: ' 1784 ' });
    assert.deepEqual(q.filters, { ig_user_id: '1784' });
    assert.deepEqual(parseLogsQuery({ status: 'ok', rule_id: '12' }).filters, { status: 'ok', rule_id: 12 });
  });

  it('reads an Older or a Newer cursor, and needs both halves of it', () => {
    assert.deepEqual(parseLogsQuery({ before: '1759320000', before_id: '179' }).cursor, {
      dir: 'older',
      sent_at: 1759320000,
      comment_id: '179',
    });
    assert.deepEqual(parseLogsQuery({ after: '1759320000', after_id: '179' }).cursor, {
      dir: 'newer',
      sent_at: 1759320000,
      comment_id: '179',
    });
    for (const half of [{ before: '1759320000' }, { before_id: '179' }, { after: 'x', after_id: '179' }]) {
      const q = parseLogsQuery(half);
      assert.equal(q.cursor, null);
      assert.match(q.notes[0]!, /starts from the newest sends/);
    }
    assert.deepEqual(parseLogsQuery({}).notes, []);
  });

  it('breaks ties on comment_id going older', () => {
    const { sql, bindings } = sentLogQuery({}, { dir: 'older', sent_at: 100, comment_id: 'c5' }, 51);
    assert.match(sql, /WHERE s\.sent_at <= \? AND \(s\.sent_at < \? OR \(s\.sent_at = \? AND s\.comment_id < \?\)\)/);
    assert.match(sql, /ORDER BY s\.sent_at DESC, s\.comment_id DESC/);
    assert.deepEqual(bindings, [100, 100, 100, 'c5', 51]);
  });

  it('reverses the comparison and the order going newer', () => {
    const { sql, bindings } = sentLogQuery({}, { dir: 'newer', sent_at: 100, comment_id: 'c5' }, 51);
    assert.match(sql, /WHERE s\.sent_at >= \? AND \(s\.sent_at > \? OR \(s\.sent_at = \? AND s\.comment_id > \?\)\)/);
    assert.match(sql, /ORDER BY s\.sent_at ASC, s\.comment_id ASC/);
    assert.deepEqual(bindings, [100, 100, 100, 'c5', 51]);
  });

  it('binds every filter in the order its condition appears', () => {
    const { sql, bindings } = sentLogQuery(
      { status: 'failed', ig_user_id: 'acct', rule_id: 3, from: 10, to: 20 },
      { dir: 'older', sent_at: 15, comment_id: 'c1' },
      51,
    );
    assert.match(
      sql,
      /WHERE s\.dm_status = \? AND s\.ig_user_id = \? AND s\.rule_id = \? AND s\.sent_at >= \? AND s\.sent_at < \? AND s\.sent_at <= \? AND \(s\.sent_at < \?/,
    );
    assert.deepEqual(bindings, ['failed', 'acct', 3, 10, 20, 15, 15, 15, 'c1', 51]);
  });

  it('has no WHERE at all on an unfiltered first page', () => {
    const { sql, bindings } = sentLogQuery({}, null, 51);
    assert.doesNotMatch(sql, /WHERE/);
    assert.deepEqual(bindings, [51]);
  });
});

describe('logs page links', () => {
  const base = '/a/secret';
  const form = { status: 'failed', ig_user_id: '', rule_id: '7', from: '2026-10-01', to: '' };
  const page = [
    { sent_at: 300, comment_id: 'c9' },
    { sent_at: 200, comment_id: 'c8' },
  ];

  it('keeps the filters and carries both halves of the cursor', () => {
    assert.equal(
      logsHref(base, form, { dir: 'older', sent_at: 200, comment_id: 'c8' }),
      '/a/secret/logs?status=failed&rule_id=7&from=2026-10-01&before=200&before_id=c8',
    );
    assert.equal(logsHref(base, { status: '', ig_user_id: '', rule_id: '', from: '', to: '' }), '/a/secret/logs');
  });

  it('encodes comment ids and filter values', () => {
    const href = logsHref(base, { ...form, ig_user_id: 'a&b=c' }, { dir: 'newer', sent_at: 1, comment_id: 'x y&z' });
    assert.equal(new URL(href, 'https://w.example').searchParams.get('ig_user_id'), 'a&b=c');
    assert.equal(new URL(href, 'https://w.example').searchParams.get('after_id'), 'x y&z');
  });

  it('offers only Older on the first page, and only when there is more', () => {
    const links = pageLinks(base, { form, cursor: null }, page, true);
    assert.equal(links.newer, null);
    assert.match(links.older!, /before=200&before_id=c8$/);
    assert.deepEqual(pageLinks(base, { form, cursor: null }, page, false), { newer: null, older: null });
  });

  it('always offers Newer after going older', () => {
    const links = pageLinks(base, { form, cursor: { dir: 'older', sent_at: 400, comment_id: 'c10' } }, page, false);
    assert.match(links.newer!, /after=300&after_id=c9$/);
    assert.equal(links.older, null);
  });

  it('always offers Older after going newer, and Newer only when there is more', () => {
    const cursor = { dir: 'newer', sent_at: 100, comment_id: 'c7' } as const;
    assert.deepEqual(pageLinks(base, { form, cursor }, page, false), {
      newer: null,
      older: logsHref(base, form, { dir: 'older', sent_at: 200, comment_id: 'c8' }),
    });
    assert.match(pageLinks(base, { form, cursor }, page, true).newer!, /after=300&after_id=c9$/);
  });

  it('offers no links on an empty page', () => {
    const cursor = { dir: 'older', sent_at: 1, comment_id: 'c0' } as const;
    assert.deepEqual(pageLinks(base, { form, cursor }, [], false), { newer: null, older: null });
  });
});
