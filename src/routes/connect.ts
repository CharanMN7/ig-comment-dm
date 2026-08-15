import { Hono } from 'hono';
import { html } from 'hono/html';
import { encryptAesGcm, nowSeconds } from '../crypto.ts';
import { upsertAccount } from '../db.ts';
import {
  authorizeUrl,
  exchangeCodeForShortLived,
  exchangeLongLived,
  fetchMe,
  redirectUri,
} from '../meta.ts';
import { makeOauthState, verifyOauthState } from '../session.ts';
import type { Env } from '../types.ts';
import { layout, pageError } from '../html.ts';

export const connectRoutes = new Hono<{ Bindings: Env }>();

connectRoutes.get('/', async (c) => {
  const state = await makeOauthState(c.env.SESSION_SIGNING_KEY);
  const url = authorizeUrl({
    clientId: c.env.META_APP_ID,
    redirectUri: redirectUri(c.env.PUBLIC_BASE_URL),
    state,
    forceReauth: c.req.query('reconnect') === '1',
  });
  return c.redirect(url, 302);
});

connectRoutes.get('/callback', async (c) => {
  const denied = c.req.query('error');
  if (denied) {
    return c.html(
      layout({
        title: 'Not connected',
        body: pageError(
          'You didn’t connect Instagram. Nothing was changed.',
          c.req.query('error_description') ?? denied,
        ),
      }),
    );
  }

  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state || !(await verifyOauthState(c.env.SESSION_SIGNING_KEY, state))) {
    return c.html(
      layout({
        title: 'Not connected',
        body: pageError(
          'That Instagram link expired or was invalid. Go back and click Connect again.',
          'missing or invalid code/state',
        ),
      }),
      400,
    );
  }

  try {
    const redir = redirectUri(c.env.PUBLIC_BASE_URL);
    const shortLived = await exchangeCodeForShortLived({
      clientId: c.env.META_APP_ID,
      clientSecret: c.env.META_APP_SECRET,
      redirectUri: redir,
      code,
    });
    const longLived = await exchangeLongLived(c.env.META_APP_SECRET, shortLived.access_token);
    const me = await fetchMe(longLived.access_token);
    const igUserId = me.user_id || me.id || shortLived.user_id;
    if (!igUserId) throw new Error('Instagram did not return an account id');

    const enc = await encryptAesGcm(c.env.TOKEN_ENCRYPTION_KEY, longLived.access_token);
    const now = nowSeconds();
    await upsertAccount(c.env.DB, {
      ig_user_id: igUserId,
      username: me.username,
      access_token_enc: enc.ciphertext,
      token_iv: enc.iv,
      token_expires_at: now + longLived.expires_in,
      connected_at: now,
      last_refreshed_at: now,
    });

    const admin = `/a/${c.env.ADMIN_URL_SECRET}/accounts`;
    return c.html(
      layout({
        title: 'Connected',
        body: html`
          <h1>Connected @${me.username}</h1>
          <p>Instagram is linked. You can close this tab and go back to the admin page.</p>
          <p><a href="${admin}">Open accounts</a></p>
        `,
      }),
    );
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return c.html(
      layout({
        title: 'Not connected',
        body: pageError(
          'Instagram didn’t finish connecting. Wait a minute and try again. If it keeps failing, the App ID or App Secret from the Meta developer site may be wrong.',
          raw,
        ),
      }),
      502,
    );
  }
});
