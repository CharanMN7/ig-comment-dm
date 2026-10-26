import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hmacSha256Hex,
  timingSafeEqualString,
  verifyHmacSha256Hex,
  verifyMetaSignature,
  verifyMetaSignatureAny,
} from '../src/crypto.ts';
import { findConfigProblems } from '../src/config.ts';
import { FREE_ATTEMPTS, lockRemaining, lockSecondsFor } from '../src/throttle.ts';
import type { Env } from '../src/types.ts';
import { authorizeUrl, oauthRedirectUri } from '../src/meta.ts';
import { isSelfComment } from '../src/guard.ts';
import { sentLogQuery } from '../src/db.ts';
import { logsHref, pageLinks, parseDay, parseLogsQuery } from '../src/logs.ts';
import { parseWebhookPayload } from '../src/process.ts';
import {
  KEYWORD_CACHE_MAX,
  compileKeyword,
  escapeRegex,
  findMatchingRule,
  keywordMatches,
  normalizeCommentText,
} from '../src/match.ts';
import type { Rule } from '../src/types.ts';

function rule(partial: Partial<Rule> & Pick<Rule, 'id' | 'keywords' | 'label'>): Rule {
  return {
    ig_user_id: 'acct',
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

describe('findMatchingRule', () => {
  const global = rule({ id: 1, label: 'global', keywords: JSON.stringify(['guide']), dm_text: 'global-dm' });
  const scoped = rule({
    id: 2,
    label: 'scoped',
    keywords: JSON.stringify(['guide']),
    media_id: 'MEDIA1',
    dm_text: 'scoped-dm',
  });

  it('prefers a media-scoped rule over a global rule', () => {
    const hit = findMatchingRule([global, scoped], 'guide please', 'MEDIA1');
    assert.equal(hit?.id, 2);
    assert.equal(hit?.dm_text, 'scoped-dm');
  });

  it('falls back to a global rule on other posts', () => {
    const hit = findMatchingRule([global, scoped], 'guide please', 'OTHER');
    assert.equal(hit?.id, 1);
  });

  it('returns the first matching rule and stops', () => {
    const a = rule({ id: 10, label: 'a', keywords: JSON.stringify(['hello']) });
    const b = rule({ id: 11, label: 'b', keywords: JSON.stringify(['hello']) });
    const hit = findMatchingRule([a, b], 'hello there', undefined);
    assert.equal(hit?.id, 10);
  });

  it('returns null when nothing matches', () => {
    assert.equal(findMatchingRule([global], 'nice photo', undefined), null);
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
