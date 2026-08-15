import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hmacSha256Hex, verifyHmacSha256Hex, verifyMetaSignature } from '../src/crypto.ts';
import { isSelfComment } from '../src/guard.ts';
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
});
