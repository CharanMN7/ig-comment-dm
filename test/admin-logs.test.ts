import { describe, expect, it } from 'vitest';
import { LOGS_PAGE_SIZE } from '../src/logs.ts';
import { DAY, NOW, seedAccount, seedRule, seedSent } from './support/seed.ts';
import { Browser, adminPath, signedInAdmin } from './support/worker.ts';

const OTHER_USER = '17841400000000002';

// Each seeded send carries a unique marker as its error text, which the page
// shows inline. Reading the markers back gives a page's rows in order.
function rowsOn(page: string): string[] {
  return [...page.matchAll(/>row-(\d+)</g)].map((m) => m[1]!);
}

function linkOn(page: string, label: 'Newer' | 'Older'): string | null {
  const m = page.match(new RegExp(`<a class="btn secondary" href="([^"]+)">[^<]*${label}[^<]*</a>`));
  return m ? m[1]!.replaceAll('&amp;', '&') : null;
}

function pad(n: number): string {
  return String(n).padStart(3, '0');
}

async function seedMany(count: number, sentAt: (i: number) => number): Promise<string[]> {
  for (let i = 0; i < count; i++) {
    await seedSent({ commentId: `c${pad(i)}`, error: `row-${pad(i)}`, sentAt: sentAt(i) });
  }
  return Array.from({ length: count }, (_, i) => pad(count - 1 - i));
}

describe('the logs page', () => {
  it('sits behind the admin login', async () => {
    await signedInAdmin();
    const res = await new Browser().get(adminPath('/logs'));
    expect(res.status).toBe(302);
    expect(res.location).toBe(adminPath('/login'));
  });

  it('reaches all of 60 sends that share one second, with no duplicates and no gaps', async () => {
    await seedAccount();
    const newestFirst = await seedMany(60, () => NOW - 60);
    const admin = await signedInAdmin();

    const first = (await admin.get(adminPath('/logs'))).text;
    expect(rowsOn(first)).toHaveLength(LOGS_PAGE_SIZE);
    expect(linkOn(first, 'Newer')).toBeNull();

    const second = (await admin.get(linkOn(first, 'Older')!)).text;
    expect(linkOn(second, 'Older')).toBeNull();
    expect([...rowsOn(first), ...rowsOn(second)]).toEqual(newestFirst);
  });

  it('comes back to the same rows going Older and then Newer', async () => {
    await seedAccount();
    // Seven sends a second: ties inside a page and across page boundaries.
    const newestFirst = await seedMany(110, (i) => NOW - DAY + Math.floor(i / 7));
    const admin = await signedInAdmin();

    const page1 = (await admin.get(adminPath('/logs'))).text;
    const page2 = (await admin.get(linkOn(page1, 'Older')!)).text;
    const page3 = (await admin.get(linkOn(page2, 'Older')!)).text;
    expect([...rowsOn(page1), ...rowsOn(page2), ...rowsOn(page3)]).toEqual(newestFirst);
    expect(linkOn(page3, 'Older')).toBeNull();

    const back2 = (await admin.get(linkOn(page3, 'Newer')!)).text;
    expect(rowsOn(back2)).toEqual(rowsOn(page2));
    expect(linkOn(back2, 'Older')).toBe(linkOn(page2, 'Older'));

    const back1 = (await admin.get(linkOn(back2, 'Newer')!)).text;
    expect(rowsOn(back1)).toEqual(rowsOn(page1));
    expect(linkOn(back1, 'Newer')).toBeNull();
  });

  it('filters by status, account, rule and UTC day', async () => {
    await seedAccount();
    await seedAccount({ igUserId: OTHER_USER, username: 'second' });
    const guide = await seedRule({ label: 'Free guide' });
    const promo = await seedRule({ label: 'Promo code', keywords: ['promo'] });
    const at = (month: number, day: number, h: number, m: number, s: number) => Date.UTC(2026, month - 1, day, h, m, s) / 1000;
    await seedSent({ commentId: 'c1', error: 'row-1', status: 'ok', ruleId: guide, sentAt: at(9, 29, 23, 59, 59) });
    await seedSent({ commentId: 'c2', error: 'row-2', status: 'failed', ruleId: promo, sentAt: at(9, 30, 0, 0, 0) });
    await seedSent({ commentId: 'c3', error: 'row-3', status: 'skipped', igUserId: OTHER_USER, sentAt: at(9, 30, 23, 59, 59) });
    await seedSent({ commentId: 'c4', error: 'row-4', status: 'ok', ruleId: guide, sentAt: at(10, 1, 0, 0, 0) });
    const admin = await signedInAdmin();
    const rows = async (qs: string) => rowsOn((await admin.get(adminPath(`/logs?${qs}`))).text);

    expect(await rows('')).toEqual(['4', '3', '2', '1']);
    expect(await rows('status=failed')).toEqual(['2']);
    expect(await rows(`ig_user_id=${OTHER_USER}`)).toEqual(['3']);
    expect(await rows(`rule_id=${promo}`)).toEqual(['2']);
    expect(await rows('from=2026-09-30')).toEqual(['4', '3', '2']);
    expect(await rows('to=2026-09-30')).toEqual(['3', '2', '1']);
    expect(await rows('from=2026-09-30&to=2026-09-30')).toEqual(['3', '2']);
    expect(await rows(`status=ok&rule_id=${guide}&to=2026-09-30`)).toEqual(['1']);

    const page = (await admin.get(adminPath(`/logs?status=failed&rule_id=${promo}&from=2026-09-30`))).text;
    expect(page).toContain('<option value="failed" selected>');
    expect(page).toContain(`<option value="${promo}" selected>Promo code</option>`);
    expect(page).toContain('name="from" type="date" value="2026-09-30"');
  });

  it('keeps the filters on the Older and Newer links', async () => {
    await seedAccount();
    for (let i = 0; i < 120; i++) {
      await seedSent({ commentId: `c${pad(i)}`, error: `row-${pad(i)}`, status: i % 2 ? 'failed' : 'ok', sentAt: NOW - 60 });
    }
    const admin = await signedInAdmin();
    const first = (await admin.get(adminPath('/logs?status=failed'))).text;
    const older = linkOn(first, 'Older')!;
    expect(older).toContain('status=failed');
    const second = (await admin.get(older)).text;
    expect(rowsOn(second)).toHaveLength(60 - LOGS_PAGE_SIZE);
    expect(rowsOn(second).every((n) => Number(n) % 2 === 1)).toBe(true);
    expect(linkOn(second, 'Newer')).toContain('status=failed');
  });

  it('ignores a date that is not real, says so, and still shows the sends', async () => {
    await seedAccount();
    await seedSent({ commentId: 'c1', error: 'row-1' });
    const admin = await signedInAdmin();
    const page = (await admin.get(adminPath('/logs?from=2026-02-30&to=garbage'))).text;
    expect(rowsOn(page)).toEqual(['1']);
    expect(page).toContain('The From date “2026-02-30” isn’t a real date, so it was left out.');
    expect(page).toContain('The To date “garbage” isn’t a real date');
    expect(page).toContain('name="from" type="date" value=""');
    expect(page).toContain('Dates are in UTC');
  });

  it('explains an empty page instead of showing a blank table', async () => {
    await seedAccount();
    const admin = await signedInAdmin();
    expect((await admin.get(adminPath('/logs'))).text).toContain('Nothing logged yet.');

    await seedSent({ commentId: 'c1', error: 'row-1', status: 'ok' });
    const filtered = (await admin.get(adminPath('/logs?status=failed'))).text;
    expect(filtered).toContain('No sends match these filters.');
    expect(filtered).not.toContain('<table>');

    const past = (await admin.get(adminPath(`/logs?status=ok&before=${NOW - 10 * DAY}&before_id=c0`))).text;
    expect(past).toContain('Nothing on this page.');
    expect(past).toContain(`href="${adminPath('/logs?status=ok')}"`);
  });

  it('escapes hostile text from Meta, rule names, usernames and the URL', async () => {
    await seedAccount({ username: '<b>creator</b>' });
    const rule = await seedRule({ label: '<script>alert(1)</script>' });
    await seedSent({ commentId: 'c1', ruleId: rule, status: 'failed', error: '<img src=x onerror=alert(1)>' });
    const admin = await signedInAdmin();

    const page = (await admin.get(adminPath('/logs'))).text;
    expect(page).toContain('Send failed.');
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).toContain('@&lt;b&gt;creator&lt;/b&gt;');
    expect(page).not.toMatch(/<script|<img|<b>creator/);

    const hostile = encodeURIComponent('"><script>alert(2)</script>');
    const reflected = (await admin.get(adminPath(`/logs?from=${hostile}&before=1&before_id=${hostile}`))).text;
    expect(reflected).toContain('“&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;”');
    expect(reflected).not.toContain('<script');
  });
});
