import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { FAKE_EXPIRES_IN, FAKE_ME, meta } from './support/meta.ts';
import { DAY, FROZEN_NOW_MS, NOW, accountRow, seedAccount, storedToken } from './support/seed.ts';
import { ORIGIN, request } from './support/worker.ts';

const CALLBACK = `${ORIGIN}/connect/callback`;

async function startState(): Promise<string> {
  const res = await request('/connect/start');
  return new URL(res.location!).searchParams.get('state')!;
}

describe('Connect (Instagram Business Login)', () => {
  it('shows the exact redirect URIs and app id the operator must paste into Meta', async () => {
    const res = await request('/connect?reconnect=1');
    expect(res.text).toContain(`${CALLBACK}\n${CALLBACK}/`);
    expect(res.text).toContain(`<code>${env.META_APP_ID}</code>`);
    expect(res.text).toContain('href="/connect/start?reconnect=1"');
  });

  it('redirects to Instagram with a signed state', async () => {
    const res = await request('/connect/start');
    expect(res.status).toBe(302);
    const url = new URL(res.location!);
    expect(url.origin + url.pathname).toBe('https://www.instagram.com/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: env.META_APP_ID,
      redirect_uri: CALLBACK,
      response_type: 'code',
      scope: 'instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_messages',
      enable_fb_login: 'false',
    });
    expect(url.searchParams.get('state')).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(url.searchParams.has('force_reauth')).toBe(false);
  });

  it('forces re-authentication when reconnecting', async () => {
    const res = await request('/connect/start?reconnect=1');
    expect(new URL(res.location!).searchParams.get('force_reauth')).toBe('true');
  });

  it('exchanges the code, stores the long-lived token encrypted, and subscribes to comments', async () => {
    const state = await startState();

    const res = await request(`/connect/callback?code=auth-code-123&state=${encodeURIComponent(state)}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain(`Connected @${FAKE_ME.username}`);
    expect(meta.callsTo('POST', '/oauth/access_token')).toEqual([
      expect.objectContaining({
        host: 'api.instagram.com',
        body: {
          client_id: env.META_APP_ID,
          client_secret: env.META_APP_SECRET,
          grant_type: 'authorization_code',
          redirect_uri: CALLBACK,
          code: 'auth-code-123',
        },
      }),
    ]);
    expect(meta.callsTo('GET', '/access_token')).toEqual([
      expect.objectContaining({ query: { grant_type: 'ig_exchange_token', client_secret: env.META_APP_SECRET, access_token: 'short-lived-token' } }),
    ]);
    expect(meta.callsTo('GET', '/me')).toEqual([expect.objectContaining({ authorization: 'Bearer long-lived-token' })]);
    expect(meta.callsTo('POST', '/:id/subscribed_apps')).toEqual([
      expect.objectContaining({ path: `/${FAKE_ME.user_id}/subscribed_apps`, authorization: 'Bearer long-lived-token' }),
    ]);
    expect(await accountRow(FAKE_ME.user_id)).toMatchObject({
      username: FAKE_ME.username,
      token_expires_at: NOW + FAKE_EXPIRES_IN,
      active: 1,
      needs_reconnect: 0,
    });
    expect(await storedToken(FAKE_ME.user_id)).toBe('long-lived-token');
  });

  it('reconnecting revives a paused, flagged account and keeps its original connect date', async () => {
    await seedAccount({ igUserId: FAKE_ME.user_id, connectedAt: NOW - 90 * DAY, active: false });
    await env.DB.prepare('UPDATE accounts SET needs_reconnect = 1').run();
    const state = await startState();
    await request(`/connect/callback?code=c&state=${encodeURIComponent(state)}`);
    expect(await accountRow(FAKE_ME.user_id)).toMatchObject({ active: 1, needs_reconnect: 0, connected_at: NOW - 90 * DAY, last_refreshed_at: NOW });
  });

  it.each([
    ['a forged state', async () => 'eyJleHAiOjB9.AAAA'],
    ['no state', async () => ''],
    [
      'a state older than 10 minutes',
      async () => {
        const state = await startState();
        vi.setSystemTime(FROZEN_NOW_MS + 601_000);
        return state;
      },
    ],
  ])('refuses %s without calling Instagram', async (_, makeState) => {
    const state = await makeState();
    const res = await request(`/connect/callback?code=c&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(400);
    expect(res.text).toContain('That Instagram link expired or was invalid.');
    expect(meta.calls).toEqual([]);
  });

  it('explains a cancelled login and changes nothing', async () => {
    const res = await request('/connect/callback?error=access_denied&error_description=The+user+denied+your+request.');
    expect(res.status).toBe(200);
    expect(res.text).toContain('You didn’t connect Instagram. Nothing was changed.');
    expect(res.text).toContain('The user denied your request.');
    expect(meta.calls).toEqual([]);
  });

  it("shows Instagram's reason when the code exchange fails and stores no account", async () => {
    meta.on('POST', '/oauth/access_token', { status: 400, json: { error_type: 'OAuthException', code: 400, error_message: 'Invalid redirect_uri' } });
    const state = await startState();
    const res = await request(`/connect/callback?code=c&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(502);
    expect(res.text).toContain('Invalid redirect_uri');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts').first<{ n: number }>()).toEqual({ n: 0 });
  });
});
