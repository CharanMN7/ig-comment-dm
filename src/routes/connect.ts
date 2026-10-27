import { Hono, type MiddlewareHandler } from 'hono';
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
import {
  OAUTH_STATE_TTL_SECONDS,
  makeOauthState,
  readSession,
  readSessionBinding,
  serializeConnectCookie,
  verifyOauthState,
} from '../session.ts';
import type { Env } from '../types.ts';
import { layout, pageError } from '../html.ts';

export const connectRoutes = new Hono<{ Bindings: Env }>();

function startHref(reconnect: boolean): string {
  return reconnect ? '/connect/start?reconnect=1' : '/connect/start';
}

/** The same bar the admin panel sets: a logged-in session, and a password that still exists. */
async function adminSignedIn(env: Env, cookieHeader: string | undefined): Promise<boolean> {
  const { binding, hasPassword } = await readSessionBinding(env.DB);
  if (!hasPassword) return false;
  const session = await readSession(env.SESSION_SIGNING_KEY, binding, cookieHeader);
  return !!session?.authed;
}

// Deliberately says nothing about where the admin page is: this is what a
// stranger who found /connect sees.
const fromAdminOnly = layout({
  title: 'Connect Instagram',
  body: html`
    <h1>Connect from your admin page</h1>
    <p>Open your admin page, log in, then go to <b>Accounts → Connect a new account</b>.</p>
  `,
});

const requireAdmin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!(await adminSignedIn(c.env, c.req.header('Cookie')))) return c.html(fromAdminOnly, 403);
  await next();
};

connectRoutes.use('/', requireAdmin);
connectRoutes.use('/start', requireAdmin);

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
          Open <b>Instagram → API setup with Instagram login</b>. Click <b>Set up</b> under
          <b>3. Set up Instagram business login</b> (not Facebook Login). Paste the first line into
          <b>Redirect URL</b>, Save, then open <b>Business login settings</b> and add both lines under
          <b>OAuth redirect URIs</b> if they are not already there.
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
        <div class="row">
          <a class="btn" href="${startHref(reconnect)}">I’ve saved those URLs — continue to Instagram</a>
          <a class="btn secondary" href="/a/${c.env.ADMIN_URL_SECRET}/accounts">Cancel</a>
        </div>
      `,
    }),
  );
});

connectRoutes.get('/start', async (c) => {
  const redir = oauthRedirectUri(c.req.url, c.env.PUBLIC_BASE_URL);
  const { state, cookie } = await makeOauthState(c.env.SESSION_SIGNING_KEY);
  c.header('Set-Cookie', serializeConnectCookie(cookie, c.env.PUBLIC_BASE_URL, OAUTH_STATE_TTL_SECONDS));
  const url = authorizeUrl({
    clientId: c.env.META_APP_ID,
    redirectUri: redir,
    state,
    forceReauth: c.req.query('reconnect') === '1',
  });
  return c.redirect(url, 302);
});

// Anyone can open /connect/callback?error=access_denied, so the page it shows
// can't name the admin address. It links here instead: the Strict session cookie
// is left off Instagram's redirect, but a click from our own page carries it.
connectRoutes.get('/accounts', requireAdmin, (c) => c.redirect(`/a/${c.env.ADMIN_URL_SECRET}/accounts`, 302));

connectRoutes.get('/callback', async (c) => {
  c.header('Set-Cookie', serializeConnectCookie('', c.env.PUBLIC_BASE_URL, 0));
  const denied = c.req.query('error');
  // Instagram's Cancel button. The operator chose it, so nothing went wrong.
  if (denied === 'access_denied') {
    return c.html(
      layout({
        title: 'Not connected',
        body: html`
          <h1>Not connected</h1>
          <p>
            You cancelled on Instagram’s screen, so no account was connected and nothing changed. You can
            connect again from Accounts whenever you’re ready.
          </p>
          <p><a class="btn" href="/connect/accounts">Back to Accounts</a></p>
        `,
      }),
    );
  }
  if (denied) {
    // Anyone can put any text in this URL and send it round as a link to a
    // page on this Worker's domain. Instagram's reason is shown only when the
    // state and this browser's connect cookie verify, which means the
    // operator's own Connect came back here; everyone else gets our words.
    const state = c.req.query('state');
    const own = !!state && (await verifyOauthState(c.env.SESSION_SIGNING_KEY, state, c.req.header('Cookie')));
    return c.html(
      layout({
        title: 'Not connected',
        body: html`
          <h1>Not connected</h1>
          <p>Instagram stopped the connection before it finished, so nothing changed. Try again from Accounts.</p>
          ${own
            ? html`<p class="muted">Instagram’s reason:</p>
                <pre class="raw">${c.req.query('error_description') ?? denied}</pre>`
            : html``}
          <p><a class="btn" href="/connect/accounts">Back to Accounts</a></p>
        `,
      }),
    );
  }

  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state || !(await verifyOauthState(c.env.SESSION_SIGNING_KEY, state, c.req.header('Cookie')))) {
    return c.html(
      layout({
        title: 'Not connected',
        body: pageError(
          'That Instagram link expired or was invalid. Open your admin page and click Connect again, then finish in the same browser within 10 minutes.',
          'missing or invalid code, state, or connect cookie',
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

    // The account is saved by now, so a network failure here must not turn
    // into "didn't finish connecting". Home subscribes again on every visit.
    const subscribed = await subscribeCommentWebhooks(igUserId, longLived.access_token).catch(() => ({ ok: false }));
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
