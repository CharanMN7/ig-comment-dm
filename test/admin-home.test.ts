import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { HEALTH_FIRST_SEEN_KEY, systemSet } from '../src/db.ts';
import { meta } from './support/meta.ts';
import { DAY, FROZEN_NOW_MS, IG_USER, NOW, seedAccount, seedRule, systemValue } from './support/seed.ts';
import { adminPath, commentPayload, postWebhook, request, signedInAdmin } from './support/worker.ts';

/** The page as a reader sees it: tags gone, whitespace collapsed. */
function textOf(page: string): string {
  return page.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('the admin home page', () => {
  it('re-subscribes active accounts to comment webhooks in the background', async () => {
    await seedAccount();
    const admin = await signedInAdmin();
    const res = await admin.get(adminPath('/'));
    expect(res.status).toBe(200);
    expect(meta.callsTo('POST', '/:id/subscribed_apps')).toEqual([
      expect.objectContaining({ path: `/${IG_USER}/subscribed_apps`, body: { subscribed_fields: ['comments'] } }),
    ]);
  });

  it("counts today's sends, skips, failures and people reached from real webhooks", async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'] });
    await postWebhook(commentPayload({ commentId: 'ok-1', text: 'guide' }));
    await postWebhook(commentPayload({ commentId: 'skip-1', text: 'hello' }));
    meta.on('POST', '/:id/messages', { status: 400, json: { error: { message: 'nope' } } });
    await postWebhook(commentPayload({ commentId: 'fail-1', text: 'guide' }));

    const page = (await (await signedInAdmin()).get(adminPath('/'))).text;

    expect(textOf(page)).toContain('Today (UTC) 1 person reached 1 DM sent 1 skipped 1 failed');
    expect(textOf(page)).toContain('Last 7 days 1 person reached 1 DM sent 1 skipped 1 failed');
  });

  it('counts a token with one day left in the singular, on Home and on Accounts', async () => {
    await seedAccount({ expiresAt: NOW + DAY + 60 });
    await seedAccount({ igUserId: '17841400000000002', username: 'second', expiresAt: NOW + 2 * DAY + 60 });
    const admin = await signedInAdmin();
    const home = textOf((await admin.get(adminPath('/'))).text);
    expect(home).toContain('@creator Watching comments 1 day left');
    expect(home).toContain('@second Watching comments 2 days left');
    const accounts = textOf((await admin.get(adminPath('/accounts'))).text);
    expect(accounts).toContain('@creator Watching comments · 1 day left');
    expect(accounts).toContain('@second Watching comments · 2 days left');
  });

  it('shows a comment skipped by an exclusion, with the rule and the exclusion that matched', async () => {
    await seedAccount();
    await seedRule({ label: 'Free guide', keywords: ['guide'], excludeKeywords: ['how much'] });
    await postWebhook(commentPayload({ text: 'how much is the guide' }));
    const page = (await (await signedInAdmin()).get(adminPath('/'))).text;
    expect(page).toMatch(/<td>Free guide<\/td>\s*<td>Skipped<\/td>/);
    expect(page).toContain('Skipped: matched exclusion “how much”');
  });

  it("escapes Meta's error text when it shows a failed send", async () => {
    await seedAccount();
    await seedRule();
    meta.on('POST', '/:id/messages', { status: 400, json: { error: { message: '<img src=x onerror=alert(1)>' } } });
    await postWebhook(commentPayload());
    const page = (await (await signedInAdmin()).get(adminPath('/'))).text;
    expect(page).toContain('Send failed.');
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(page).not.toContain('<img');
  });

  it('says when a public reply was held back because the DM failed', async () => {
    await seedAccount();
    await seedRule({ publicReply: 'Sent you a DM!' });
    meta.on('POST', '/:id/messages', { status: 400, json: { error: { message: 'outside of allowed window' } } });
    await postWebhook(commentPayload());
    const page = (await (await signedInAdmin()).get(adminPath('/'))).text;
    expect(page).toContain('Send failed.');
    expect(page).toContain('Public reply not posted, because no DM went out.');
  });

  async function wrongSecretFor(minutes: number) {
    for (let minute = 0; minute < minutes; minute++) {
      vi.setSystemTime(FROZEN_NOW_MS + minute * 60_000);
      await postWebhook(commentPayload(), { secret: 'wrong' });
    }
  }

  it('lists one wrong signature without raising the signing secret banner', async () => {
    await postWebhook(commentPayload(), { secret: 'wrong' });
    const page = (await (await signedInAdmin()).get(adminPath('/'))).text;
    expect(page).toContain('Wrong secret');
    expect(page).not.toContain('the signing secret did not match');
  });

  it('warns about the signing secret after wrong signatures in three separate minutes with no good one between', async () => {
    await wrongSecretFor(3);
    const page = (await (await signedInAdmin()).get(adminPath('/'))).text;
    expect(page).toContain('the signing secret did not match');
  });

  it('does not warn about the signing secret for a burst of wrong signatures in the same minute', async () => {
    await Promise.all(Array.from({ length: 50 }, () => postWebhook(commentPayload(), { secret: 'wrong' })));
    const page = (await (await signedInAdmin()).get(adminPath('/'))).text;
    expect(page).not.toContain('the signing secret did not match');
  });

  it('drops the signing secret banner once a good delivery arrives, until wrong ones repeat again', async () => {
    await wrongSecretFor(3);
    const admin = await signedInAdmin();
    expect((await admin.get(adminPath('/'))).text).toContain('the signing secret did not match');

    await postWebhook({ object: 'instagram', entry: [] });
    vi.setSystemTime(FROZEN_NOW_MS + 3 * 60_000);
    await postWebhook(commentPayload(), { secret: 'wrong' });
    vi.setSystemTime(FROZEN_NOW_MS + 4 * 60_000);
    await postWebhook(commentPayload(), { secret: 'wrong' });
    expect((await admin.get(adminPath('/'))).text).not.toContain('the signing secret did not match');

    vi.setSystemTime(FROZEN_NOW_MS + 5 * 60_000);
    await postWebhook(commentPayload(), { secret: 'wrong' });
    expect((await admin.get(adminPath('/'))).text).toContain('the signing secret did not match');
  });

  it('neither lists nor warns about a POST that carried no signature at all', async () => {
    for (let i = 0; i < 10; i++) await postWebhook(commentPayload(), { signature: null });
    const page = (await (await signedInAdmin()).get(adminPath('/'))).text;
    expect(page).not.toContain('the signing secret did not match');
    expect(page).not.toContain('Not signed');
  });

  it('says the daily check has not run yet on a fresh deploy, instead of calling it 3 days late', async () => {
    const admin = await signedInAdmin();
    const page = textOf((await admin.get(adminPath('/'))).text);
    expect(page).not.toContain('over 3 days');
    expect(page).not.toContain('has never run');
    expect(page).toContain('The daily Instagram check hasn’t run yet.');
    expect(page).toContain('expect the first run by 2026-10-02 03:00 UTC.');
    // The grace period runs from the first look, shared with /health.
    expect(await systemValue(HEALTH_FIRST_SEEN_KEY)).toBe(String(NOW));

    vi.setSystemTime(Date.UTC(2026, 9, 2, 2, 30));
    expect(textOf((await admin.get(adminPath('/'))).text)).toContain('expect the first run by 2026-10-02 03:00 UTC.');
    expect(await systemValue(HEALTH_FIRST_SEEN_KEY)).toBe(String(NOW));
  });

  it('warns once the first nightly run is overdue, when /health starts failing too', async () => {
    const admin = await signedInAdmin();
    await systemSet(env.DB, HEALTH_FIRST_SEEN_KEY, String(NOW));
    vi.setSystemTime(FROZEN_NOW_MS + 25 * 60 * 60 * 1000);
    expect((await admin.get(adminPath('/'))).text).toContain('hasn’t run yet');

    vi.setSystemTime(FROZEN_NOW_MS + 27 * 60 * 60 * 1000);
    const page = (await admin.get(adminPath('/'))).text;
    expect(page).toContain('The daily Instagram check has never run, and its first run at 03:00 UTC is overdue.');
    expect(page).not.toContain('hasn’t run yet');
    expect(JSON.parse((await request('/health')).text)).toMatchObject({ cron: 'stale' });
  });

  it('warns until the daily check has run in the last 3 days', async () => {
    const admin = await signedInAdmin();
    await systemSet(env.DB, 'last_cron_ok_at', String(NOW - 4 * DAY));
    expect((await admin.get(adminPath('/'))).text).toContain('hasn’t run in over 3 days');
    await systemSet(env.DB, 'last_cron_ok_at', String(NOW - 2 * DAY));
    const page = (await admin.get(adminPath('/'))).text;
    expect(page).not.toContain('hasn’t run in over 3 days');
    expect(page).not.toContain('hasn’t run yet');
  });

  it('flags an account whose token has expired', async () => {
    await seedAccount({ username: 'lapsed', expiresAt: NOW - 1 });
    const page = (await (await signedInAdmin()).get(adminPath('/'))).text;
    expect(page).toContain('Instagram needs reconnecting');
    expect(page).toContain('Expired');
  });

  it('shows no secrets banner when the config is right, and names a missing FACEBOOK_APP_SECRET', async () => {
    const admin = await signedInAdmin();
    expect((await admin.get(adminPath('/'))).text).not.toContain('need attention');
    const res = await request(adminPath('/'), { headers: { Cookie: admin.cookieHeader }, env: { FACEBOOK_APP_SECRET: '' } });
    expect(res.text).toContain('A Worker secret needs attention.');
    expect(res.text).toContain('<code>FACEBOOK_APP_SECRET</code>');
  });
});

describe('getting started on Home', () => {
  it('lists the three steps on a new install, and ticks each off as it happens', async () => {
    const admin = await signedInAdmin();
    let page = textOf((await admin.get(adminPath('/'))).text);
    expect(page).toContain('Get started');
    expect(page).toContain('Connect your Instagram account . It takes about 20 seconds.');
    expect(page).toContain('Write your first rule , or start from a template.');
    expect(page).toContain('Test your rule with a sample comment.');

    await seedAccount();
    await seedRule({ keywords: ['guide'] });
    page = textOf((await admin.get(adminPath('/'))).text);
    expect(page).toContain('Done: connected @creator.');
    expect(page).toContain('Done: one rule written.');
    expect(page).toContain('Test your rule with a sample comment.');

    await postWebhook(commentPayload({ text: 'guide' }));
    expect((await admin.get(adminPath('/'))).text).not.toContain('Get started');
  });

  it('says the connections were checked after the button is pressed', async () => {
    const admin = await signedInAdmin();
    await admin.get(adminPath('/'));
    const res = await admin.submit(adminPath('/run-cron'));
    expect(res.location).toBe(adminPath('/?done=checked'));
    expect((await admin.get(res.location!)).text).toContain('<div class="ok" role="status">Connections checked.');
  });
});

describe('the admin error page', () => {
  it('says the tables are missing when one is', async () => {
    const admin = await signedInAdmin();
    await env.DB.prepare('DROP TABLE accounts').run();
    const res = await admin.get(adminPath('/accounts'));
    expect(res.status).toBe(500);
    expect(res.text).toContain('The database tables are missing. Run the D1 migration, then try again.');
    expect(res.text).toMatch(/<pre class="raw">[^<]*no such table: accounts/);
  });

  it('does not blame missing tables for any other database error, and shows the detail underneath', async () => {
    const admin = await signedInAdmin();
    await env.DB.prepare('ALTER TABLE accounts RENAME COLUMN username TO handle').run();
    const res = await admin.get(adminPath('/accounts'));
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('tables are missing');
    expect(res.text).toContain('That failed. Try once more.');
    expect(res.text).toMatch(/<pre class="raw">[^<]*D1_ERROR[^<]*no such column: username/);
  });
});
