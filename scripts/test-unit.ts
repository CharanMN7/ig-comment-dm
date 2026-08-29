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
import { parseWebhookPayload } from '../src/process.ts';
import {
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

  it('escapes regex metacharacters in keywords', () => {
    assert.equal(escapeRegex('c++'), 'c\\+\\+');
    const n = normalizeCommentText('love c++ here');
    // punctuation stripped, so c++ becomes c
    assert.equal(normalizeCommentText('love c++ here'), 'love c here');
    assert.equal(keywordMatches(n, 'c++'), true);
  });
});

describe('Latin diacritic folding', () => {
  // A creator writing a `preco` rule and testing it with their own accented
  // comment used to conclude the tool was broken.
  const shouldMatch: Array<[string, string]> = [
    ['preco', 'qual o PREÇO?'],
    ['preco', 'qual o preço'],
    ['preco', 'QUAL O PRECO'],
    ['preço', 'qual o preco'],
    ['cafe', 'vamos ao café'],
    ['uber', 'über alles'],
    ['nino', 'el niño'],
    ['istanbul', 'İstanbul please'],
  ];

  for (const [keyword, comment] of shouldMatch) {
    it(`matches ${JSON.stringify(keyword)} in ${JSON.stringify(comment)}`, () => {
      assert.equal(keywordMatches(normalizeCommentText(comment), keyword), true);
    });
  }

  it('does not fold a Cyrillic breve — й is a different letter from и', () => {
    assert.notEqual(normalizeCommentText('й'), normalizeCommentText('и'));
    assert.equal(keywordMatches(normalizeCommentText('и'), 'й'), false);
  });

  it('does not fold a Japanese dakuten — が is a different kana from か', () => {
    assert.notEqual(normalizeCommentText('が'), normalizeCommentText('か'));
    assert.equal(keywordMatches(normalizeCommentText('か'), 'が'), false);
  });

  it('leaves scripts whose marks are load-bearing exactly as they were', () => {
    // Devanagari, Thai and Arabic vowel marks are letters, not decoration.
    for (const text of ['नमस्ते', 'สวัสดี', 'العربية', 'й', 'が', '한국어']) {
      assert.equal(normalizeCommentText(text), text.toLowerCase());
    }
  });

  it('still refuses an unrelated word that shares a folded prefix', () => {
    // Folding widens what counts as equal, not what counts as a boundary.
    assert.equal(keywordMatches(normalizeCommentText('cafeteria aqui'), 'cafe'), false);
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
