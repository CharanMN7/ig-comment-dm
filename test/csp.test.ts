import { describe, expect, it } from 'vitest';
import { meta } from './support/meta.ts';
import { IG_USER, seedAccount, seedRule } from './support/seed.ts';
import { ADMIN_PASSWORD, Browser, type Reply, adminPath, commentPayload, postWebhook, request, signedInAdmin } from './support/worker.ts';

// The CSP is `default-src 'none'` with no script-src, so the browser silently
// drops any inline script or on* handler. Markup that relies on one looks fine
// in review and does nothing in use, which is how rule Delete lost its confirm.
const SCRIPT = /<script/i;
const INLINE_HANDLER = /\son[a-z]+=/i;

function offences(pages: Array<[string, Reply]>): string[] {
  const found: string[] = [];
  for (const [name, page] of pages) {
    if (!page.headers.get('Content-Type')?.includes('text/html')) {
      found.push(`${name}: expected an HTML page, got ${page.status}`);
      continue;
    }
    const script = page.text.match(SCRIPT);
    const handler = page.text.match(INLINE_HANDLER);
    if (script) found.push(`${name}: ${script[0]}`);
    if (handler) found.push(`${name}: ${handler[0].trim()}`);
  }
  return found;
}

describe('pages under the CSP', () => {
  it('carry no <script> and no inline event handler anywhere in the admin panel', async () => {
    meta.on('GET', '/me/media', {
      json: { data: [{ id: '18000000000000001', caption: 'A reel', permalink: 'https://www.instagram.com/reel/abc/', media_product_type: 'REELS' }] },
    });
    await seedAccount();
    const rule = await seedRule({ keywords: ['guide'], publicReply: 'Sent you a DM!' });
    await postWebhook(commentPayload({ commentId: 'sent-ok', text: 'guide' }));
    await postWebhook(commentPayload({ commentId: 'no-match', text: 'hello' }));
    meta.on('POST', '/:id/messages', { status: 400, json: { error: { message: 'nope' } } });
    await postWebhook(commentPayload({ commentId: 'dm-failed', text: 'guide' }));
    await postWebhook(commentPayload(), { secret: 'wrong' });

    const visitor = new Browser();
    const setup = await visitor.get(adminPath('/setup'));
    const admin = await signedInAdmin();
    const stranger = new Browser();
    const login = await stranger.get(adminPath('/login'));
    const wrongPassword = await stranger.submit(adminPath('/login'), { password: `${ADMIN_PASSWORD}!` });
    const expiredForm = await admin.post(adminPath('/rules'), { csrf: 'stale' });

    const pages: Array<[string, Reply]> = [
      ['setup', setup],
      ['login', login],
      ['wrong password', wrongPassword],
      ['expired form', expiredForm],
      ['home', await admin.get(adminPath('/'))],
      ['logs', await admin.get(adminPath('/logs'))],
      ['logs with a bad date', await admin.get(adminPath('/logs?from=2026-02-30&status=failed'))],
      ['rules', await admin.get(adminPath('/rules'))],
      ['new rule', await admin.get(adminPath('/rules/new'))],
      ['rule with an error', await admin.submit(adminPath('/rules'), { ig_user_id: IG_USER, label: '', keywords: 'guide', dm_text: 'hi' })],
      ['edit rule', await admin.get(adminPath(`/rules/${rule}/edit`))],
      ['delete rule', await admin.get(adminPath(`/rules/${rule}/delete`))],
      ['test', await admin.get(adminPath('/test'))],
      ['test match', await admin.submit(adminPath('/test'), { ig_user_id: IG_USER, text: 'guide', media_id: '' })],
      ['test no match', await admin.submit(adminPath('/test'), { ig_user_id: IG_USER, text: 'hello', media_id: '' })],
      ['accounts', await admin.get(adminPath('/accounts'))],
      ['connect', await request('/connect')],
      ['connect denied', await request('/connect/callback?error=access_denied')],
      ['privacy', await request('/privacy')],
      ['terms', await request('/terms')],
      ['data deletion', await request('/data-deletion')],
    ];

    expect(offences(pages)).toEqual([]);
    // Guards the guard: a page that rendered nothing would pass for the wrong reason.
    expect(pages.find(([name]) => name === 'home')![1].text).toContain('Public reply not posted');
    expect(pages.find(([name]) => name === 'delete rule')![1].text).toContain('Delete this rule?');
  });
});
