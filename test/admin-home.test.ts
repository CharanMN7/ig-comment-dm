import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { systemSet } from '../src/db.ts';
import { meta } from './support/meta.ts';
import { DAY, IG_USER, NOW, seedAccount, seedRule } from './support/seed.ts';
import { adminPath, commentPayload, postWebhook, request, signedInAdmin } from './support/worker.ts';

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

  it("counts today's comments, sends and failures", async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'] });
    await postWebhook(commentPayload({ commentId: 'ok-1', text: 'guide' }));
    await postWebhook(commentPayload({ commentId: 'skip-1', text: 'hello' }));
    meta.on('POST', '/:id/messages', { status: 400, json: { error: { message: 'nope' } } });
    await postWebhook(commentPayload({ commentId: 'fail-1', text: 'guide' }));

    const page = (await (await signedInAdmin()).get(adminPath('/'))).text;

    expect(page).toMatch(/Comments seen today<\/span><b>3<\/b>/);
    expect(page).toMatch(/DMs sent today<\/span><b>1<\/b>/);
    expect(page).toMatch(/Failures today<\/span><b>1<\/b>/);
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
