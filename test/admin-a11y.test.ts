import { describe, expect, it } from 'vitest';
import { meta } from './support/meta.ts';
import { IG_USER, seedAccount, seedRule } from './support/seed.ts';
import { ADMIN_PASSWORD, Browser, adminPath, commentPayload, postWebhook, signedInAdmin } from './support/worker.ts';

const FIELD = /<(input|textarea|select)\b[^>]*>/g;

/**
 * Form controls a screen reader would announce with no name: no `<label for>`
 * naming their id, and not inside a `<label>` either.
 */
function unlabelled(page: string): string[] {
  const found: string[] = [];
  for (const m of page.matchAll(FIELD)) {
    const tag = m[0];
    if (/type="hidden"/.test(tag)) continue;
    const id = tag.match(/\sid="([^"]+)"/)?.[1];
    if (id && page.includes(`<label for="${id}"`)) continue;
    const before = page.slice(0, m.index);
    if (before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue;
    found.push(tag);
  }
  return found;
}

/** Radio buttons whose group has no fieldset and legend to name it. */
function ungroupedRadios(page: string): string[] {
  const found: string[] = [];
  for (const m of page.matchAll(/<input type="radio"[^>]*>/g)) {
    const before = page.slice(0, m.index);
    const open = before.lastIndexOf('<fieldset');
    const named = open > before.lastIndexOf('</fieldset>') && before.indexOf('<legend>', open) > open;
    if (!named) found.push(m[0]);
  }
  return found;
}

async function everyAdminPage(): Promise<Array<[string, string]>> {
  meta.on('GET', '/me/media', {
    json: { data: [{ id: '18000000000000001', caption: 'A reel', permalink: 'https://www.instagram.com/reel/abc/', media_product_type: 'REELS' }] },
  });
  const visitor = new Browser();
  const setup = (await visitor.get(adminPath('/setup'))).text;
  const setupError = (await visitor.submit(adminPath('/setup'), { password: 'short', confirm: 'short' })).text;
  const admin = await signedInAdmin();
  const firstHome = (await admin.get(adminPath('/'))).text;
  const emptyRules = (await admin.get(adminPath('/rules'))).text;
  const stranger = new Browser();
  const login = (await stranger.get(adminPath('/login'))).text;
  const wrongPassword = (await stranger.submit(adminPath('/login'), { password: `${ADMIN_PASSWORD}!` })).text;

  await seedAccount();
  const rule = await seedRule({ keywords: ['guide'], excludeKeywords: ['how much'], publicReply: 'Sent you a DM!' });
  await postWebhook(commentPayload({ commentId: 'sent-ok', text: 'guide' }));
  await admin.get(adminPath('/rules/new'));
  const ruleError = (await admin.submit(adminPath('/rules'), { ig_user_id: IG_USER, label: '', keywords: 'guide', dm_text: 'hi' })).text;
  await admin.get(adminPath('/test'));
  const testMatch = (await admin.submit(adminPath('/test'), { ig_user_id: IG_USER, text: 'guide', media_id: '' })).text;
  const testNoMatch = (await admin.submit(adminPath('/test'), { ig_user_id: IG_USER, text: 'hello', media_id: '' })).text;

  return [
    ['setup', setup],
    ['setup with an error', setupError],
    ['login', login],
    ['wrong password', wrongPassword],
    ['home on a new install', firstHome],
    ['rules, none yet', emptyRules],
    ['home', (await admin.get(adminPath('/'))).text],
    ['rules', (await admin.get(adminPath('/rules'))).text],
    ['new rule', (await admin.get(adminPath('/rules/new'))).text],
    ['new rule from a template', (await admin.get(adminPath('/rules/new?template=guide'))).text],
    ['rule with an error', ruleError],
    ['edit rule', (await admin.get(adminPath(`/rules/${rule}/edit`))).text],
    ['delete rule', (await admin.get(adminPath(`/rules/${rule}/delete`))).text],
    ['test', (await admin.get(adminPath('/test'))).text],
    ['test match', testMatch],
    ['test no match', testNoMatch],
    ['accounts', (await admin.get(adminPath('/accounts'))).text],
    ['connect', (await admin.get('/connect')).text],
    ['missing rule', (await admin.get(adminPath('/rules/999/edit'))).text],
  ];
}

describe('admin pages for assistive technology', () => {
  it('give every form control a label, every radio group a legend, and every page a language', async () => {
    const pages = await everyAdminPage();
    const problems: string[] = [];
    for (const [name, page] of pages) {
      if (!page.includes('<html lang="en">')) problems.push(`${name}: no lang on <html>`);
      for (const tag of unlabelled(page)) problems.push(`${name}: no label for ${tag}`);
      for (const tag of ungroupedRadios(page)) problems.push(`${name}: no fieldset and legend around ${tag}`);
    }
    expect(problems).toEqual([]);
    // Guards the guard: the rule form's controls were really looked at.
    const form = pages.find(([name]) => name === 'edit rule')![1];
    expect([...form.matchAll(FIELD)].length).toBeGreaterThanOrEqual(12);
    expect(form).toContain('type="radio"');
  });

  it.each([
    ['/', 'Home'],
    ['/rules', 'Rules'],
    ['/rules/new', 'Rules'],
    ['/test', 'Test'],
    ['/accounts', 'Accounts'],
  ])('marks the nav link for %s as the current page, and names the app in the title', async (path, link) => {
    await seedAccount();
    const page = (await (await signedInAdmin()).get(adminPath(path))).text;
    expect(page.match(/aria-current="page"/g)).toHaveLength(1);
    expect(page).toMatch(new RegExp(`aria-current="page">${link}</a>`));
    expect(page).toMatch(/<title>[^<]+ · Comment to DM<\/title>/);
  });
});
