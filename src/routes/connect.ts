import { Hono } from 'hono';
import { html } from 'hono/html';
import { encryptAesGcm, nowSeconds } from '../crypto.ts';
import { upsertAccount } from '../db.ts';
import {
  authorizeUrl,
  exchangeCodeForShortLived,
  exchangeLongLived,
  fetchMe,
  oauthRedirectUri,
  subscribeCommentWebhooks,
} from '../meta.ts';
import { makeOauthState, verifyOauthState } from '../session.ts';
import type { Env } from '../types.ts';
import { layout, pageError } from '../html.ts';

export const connectRoutes = new Hono<{ Bindings: Env }>();

function startHref(reconnect: boolean): string {
  return reconnect ? '/connect/start?reconnect=1' : '/connect/start';
}

connectRoutes.get('/', (c) => {
  const redir = oauthRedirectUri(c.req.url, c.env.PUBLIC_BASE_URL);
  const withSlash = `${redir}/`;
  const reconnect = c.req.query('reconnect') === '1';
  const appId = (c.env.META_APP_ID ?? '').trim();
  return c.html(
    layout({
      title: 'Connect Instagram',
      body: html`
        <h1>Before you continue</h1>
        <p>
          Instagram will only return here if this address is saved in your Meta app.
          Open
          <b>Instagram → API setup with Instagram login → 3. Set up Instagram business login →
          Business login settings → OAuth redirect URIs</b>
          and paste both lines, then Save.
        </p>
        <pre class="raw">${redir}
${withSlash}</pre>
        <p>
          Use the <b>Instagram App ID</b> from that same Business login settings page — not the
          number at the top of the Meta dashboard. This program is sending:
        </p>
        <p><code>${appId}</code></p>
        <p class="muted">
          If that number does not match Instagram App ID, run
          <code>npx wrangler secret put META_APP_ID</code>, paste the Instagram App ID, then
          <code>npx wrangler deploy</code> before connecting.
        </p>
        <p><a class="btn" href="${startHref(reconnect)}">I’ve saved those URLs — continue to Instagram</a></p>
      `,
    }),
  );
});

connectRoutes.get('/start', async (c) => {
  const redir = oauthRedirectUri(c.req.url, c.env.PUBLIC_BASE_URL);
  const state = await makeOauthState(c.env.SESSION_SIGNING_KEY);
  const url = authorizeUrl({
    clientId: c.env.META_APP_ID,
    redirectUri: redir,
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
    const redir = oauthRedirectUri(c.req.url, c.env.PUBLIC_BASE_URL);
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

    const subscribed = await subscribeCommentWebhooks(longLived.access_token);
    const admin = `/a/${c.env.ADMIN_URL_SECRET}/accounts`;
    return c.html(
      layout({
        title: 'Connected',
        body: html`
          <h1>Connected @${me.username}</h1>
          <p>Instagram is linked. You can close this tab and go back to the admin page.</p>
          ${subscribed.ok
            ? html``
            : html`<p class="err">
                Comment notifications may not be on yet. Open Home in admin once, then try a test comment
                from a different Instagram account.
              </p>`}
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
