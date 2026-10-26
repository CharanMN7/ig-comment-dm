import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { systemSet } from '../src/db.ts';
import { meta } from './support/meta.ts';
import { DAY, IG_USER, NOW, seedAccount, seedRule } from './support/seed.ts';
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

    expect(textOf(page)).toContain('Today (UTC) 1 people reached 1 DMs sent 1 skipped 1 failed');
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

  it('warns when the last webhook failed its signature check', async () => {
    await postWebhook(commentPayload(), { secret: 'wrong' });
    const page = (await (await signedInAdmin()).get(adminPath('/'))).text;
    expect(page).toContain('the signing secret did not match');
    expect(page).toContain('Wrong secret');
  });

  it('does not blame the signing secret for a POST that carried no signature at all', async () => {
    await postWebhook(commentPayload(), { signature: null });
    const page = (await (await signedInAdmin()).get(adminPath('/'))).text;
    expect(page).not.toContain('the signing secret did not match');
    expect(page).toContain('Not signed');
  });

  it('judges the signing secret by the newest signed delivery, whatever unsigned noise came after it', async () => {
    const admin = await signedInAdmin();
    await postWebhook(commentPayload(), { secret: 'wrong' });
    for (let i = 0; i < 10; i++) await postWebhook('{}', { signature: null });
    expect((await admin.get(adminPath('/'))).text).toContain('the signing secret did not match');

    await postWebhook({ object: 'instagram', entry: [] });
    await postWebhook('{}', { signature: null });
    expect((await admin.get(adminPath('/'))).text).not.toContain('the signing secret did not match');
  });

  it('warns until the daily check has run in the last 3 days', async () => {
    const admin = await signedInAdmin();
    expect((await admin.get(adminPath('/'))).text).toContain('hasn’t run in over 3 days');
    await systemSet(env.DB, 'last_cron_ok_at', String(NOW - 2 * DAY));
    expect((await admin.get(adminPath('/'))).text).not.toContain('hasn’t run in over 3 days');
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
