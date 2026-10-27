import { describe, expect, it } from 'vitest';
import { accountRow, seedAccount, seedRule, sentRows, webhookEvents } from './support/seed.ts';
import { adminPath, commentPayload, postWebhook, signedInAdmin } from './support/worker.ts';

const SELFTEST_USER = 'selftest_ig_user';

describe('the endpoints scripts/selftest.ts drives', () => {
  it('removes the fake account, its sends and its logged webhooks, and leaves real ones alone', async () => {
    await seedAccount();
    await seedRule({ keywords: ['guide'] });
    await postWebhook(commentPayload({ commentId: 'real-1', text: 'guide' }));
    const admin = await signedInAdmin();
    await admin.get(adminPath('/'));

    expect((await admin.submit(adminPath('/selftest/seed'))).status).toBe(200);
    await postWebhook(commentPayload({ igUserId: SELFTEST_USER, commentId: 'selftest-1', fromId: 'someone_else' }));
    await postWebhook({ object: 'instagram', entry: [{ id: SELFTEST_USER }] }, { secret: 'wrong' });
    expect(await accountRow(SELFTEST_USER)).not.toBeNull();
    expect((await sentRows()).map((r) => r.comment_id).sort()).toEqual(['real-1', 'selftest-1']);

    const res = await admin.submit(adminPath('/selftest/cleanup'));

    expect(res.status).toBe(200);
    expect(await accountRow(SELFTEST_USER)).toBeNull();
    expect((await sentRows()).map((r) => r.comment_id)).toEqual(['real-1']);
    expect(await accountRow()).not.toBeNull();
    expect(await webhookEvents()).toEqual([expect.objectContaining({ status: 'received', object: 'instagram' })]);
  });

  it('needs the CSRF token like every other admin form', async () => {
    const admin = await signedInAdmin();
    await admin.submit(adminPath('/selftest/seed'));
    const res = await admin.post(adminPath('/selftest/cleanup'), {});
    expect(res.status).toBe(403);
    expect(await accountRow(SELFTEST_USER)).not.toBeNull();
  });
});
