import { describe, expect, it } from 'vitest';
import { meta } from './support/meta.ts';
import { IG_USER, seedAccount, seedRule } from './support/seed.ts';
import { adminPath, commentPayload, postWebhook, request, signedInAdmin } from './support/worker.ts';

// Layout itself is checked in a browser at 375px (see the PR); these keep the
// markup that layout depends on from quietly going away.
describe('admin pages at phone width', () => {
  it('puts every table in a scrolling wrapper, so only the table scrolls sideways', async () => {
    await seedAccount();
    await seedAccount({ igUserId: '17841400000000002', username: 'second' });
    const rule = await seedRule({ keywords: ['guide'] });
    await postWebhook(commentPayload({ commentId: 'sent-ok', text: 'guide' }));
    await postWebhook(commentPayload({ commentId: 'no-match', text: 'hello' }));
    meta.on('POST', '/:id/messages', { status: 400, json: { error: { message: 'nope' } } });
    await postWebhook(commentPayload({ commentId: 'dm-failed', text: 'guide' }));
    const admin = await signedInAdmin();

    const pages: Array<[string, string]> = [
      ['home with a secrets table', (await request(adminPath('/'), { headers: { Cookie: admin.cookieHeader }, env: { FACEBOOK_APP_SECRET: '' } })).text],
      ['rules', (await admin.get(adminPath('/rules'))).text],
      ['delete rule', (await admin.get(adminPath(`/rules/${rule}/delete`))).text],
      ['test match', (await admin.submit(adminPath('/test'), { ig_user_id: IG_USER, text: 'guide', media_id: '' })).text],
      ['test no match', (await admin.submit(adminPath('/test'), { ig_user_id: IG_USER, text: 'hello', media_id: '' })).text],
      ['accounts', (await admin.get(adminPath('/accounts'))).text],
    ];
    let tables = 0;
    for (const [name, page] of pages) {
      const all = page.match(/<table\b/g) ?? [];
      const wrapped = page.match(/<div class="table-wrap"><table\b/g) ?? [];
      expect(all.length, `${name} has a table`).toBeGreaterThan(0);
      expect(wrapped.length, `${name}: tables outside a .table-wrap`).toBe(all.length);
      tables += all.length;
    }
    expect(tables).toBeGreaterThanOrEqual(9);
  });

  it('drops the account column from the rules list when there is only one account', async () => {
    await seedAccount({ username: 'only_one' });
    await seedRule({ keywords: ['guide'] });
    const admin = await signedInAdmin();
    const one = (await admin.get(adminPath('/rules'))).text;
    expect(one).not.toContain('<th>Account</th>');
    expect(one).not.toContain('@only_one');

    await seedAccount({ igUserId: '17841400000000002', username: 'second' });
    const two = (await admin.get(adminPath('/rules'))).text;
    expect(two).toContain('<th>Account</th>');
    expect(two).toContain('@only_one');
  });

  it('keeps the nav on one row that scrolls by itself, with full-size links and the current page marked', async () => {
    await seedAccount();
    const page = (await (await signedInAdmin()).get(adminPath('/accounts'))).text;
    const css = page.match(/<style>([\s\S]*?)<\/style>/)![1]!.replace(/\/\*[\s\S]*?\*\//g, '');
    const declarations = (selector: string) =>
      [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((m) => m[1]!.trim() === selector)
        .map((m) => m[2]!)
        .join(';');
    const nav = declarations('header.top nav');
    expect(nav).toContain('flex-wrap: nowrap');
    expect(nav).not.toContain('flex-wrap: wrap');
    expect(nav).toContain('overflow-x: auto');
    // Without this a link shrinks to its 44px floor and its word spills out of it.
    expect(declarations('header.top nav > *')).toContain('flex: none');
    const links = declarations('header.top nav a');
    expect(links.match(/min-(height|width): [^;]+/g)).toEqual(['min-height: 44px', 'min-width: 44px']);
    expect(page).toContain('aria-current="page">Accounts</a>');
  });

  it('makes the rule list Edit link a full-size button', async () => {
    await seedAccount();
    const rule = await seedRule();
    const page = (await (await signedInAdmin()).get(adminPath('/rules'))).text;
    expect(page).toContain(`<a class="btn secondary" href="${adminPath(`/rules/${rule}/edit`)}">Edit</a>`);
  });
});
