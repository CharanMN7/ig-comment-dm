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

/** WCAG relative luminance of a #rgb or #rrggbb colour. */
function luminance(hex: string): number {
  const digits = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c) : [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)];
  const [r, g, b] = digits.map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
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

  it('says DM on every page, never private message', async () => {
    for (const [name, page] of await everyAdminPage()) expect(page, name).not.toMatch(/private message/i);
  });

  it('makes placeholder text at least 4.5:1 against the field behind it', async () => {
    const page = (await (await signedInAdmin()).get(adminPath('/'))).text;
    const css = page.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    const placeholder = css.match(/::placeholder \{([^}]*)\}/)?.[1];
    expect(placeholder, 'with no colour set, Safari draws placeholders at 2.3:1').toBeDefined();
    // Firefox fades placeholders to 54% unless told otherwise.
    expect(placeholder).toContain('opacity: 1');
    const color = placeholder!.match(/color: (#[0-9a-f]{3,6});/i)![1]!;
    const field = css.match(/input\[type=text\], input\[type=password\],[^{]* textarea, select \{([^}]*)\}/)![1]!;
    const background = field.match(/background: (#[0-9a-f]{3,6});/i)![1]!;
    expect(contrast(color, background)).toBeGreaterThanOrEqual(4.5);
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
