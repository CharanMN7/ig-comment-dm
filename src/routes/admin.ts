import { Hono } from 'hono';
import { html } from 'hono/html';
import {
  CRON_STALE_SECONDS,
  DM_TEXT_MAX,
  decryptAesGcm,
  encryptAesGcm,
  hashPassword,
  nowSeconds,
  timingSafeEqualString,
  verifyPassword,
} from '../crypto.ts';
import { ensureCommentSubscriptions, runCron } from '../cron.ts';
import {
  countSentByComment,
  deleteRule,
  getRule,
  getSent,
  insertRule,
  listAccounts,
  listRules,
  recentSent,
  recentWebhookEvents,
  setAccountActive,
  systemGet,
  systemSet,
  todayCounters,
  toggleRule,
  updateRule,
  upsertAccount,
} from '../db.ts';
import { findConfigProblems } from '../config.ts';
import { csrfField, daysUntil, fmtWhen, layout, pageError, statusWords } from '../html.ts';
import { KEYWORD_TOO_SHORT_MESSAGE, findMatchingRule, parseKeywords } from '../match.ts';
import { listRecentMedia, oauthRedirectUri } from '../meta.ts';
import { clearSessionCookie, makeSession, readSession, serializeSessionCookie } from '../session.ts';
import {
  clearFailures,
  describeLock,
  lockRemaining,
  readThrottle,
  recordFailure,
} from '../throttle.ts';
import type { Env, SessionData } from '../types.ts';

type Vars = {
  adminBase: string;
  session: SessionData;
  form: Record<string, string>;
};

export const adminRoutes = new Hono<{ Bindings: Env; Variables: Vars }>({ strict: false });

adminRoutes.onError((err, c) => {
  console.error(err);
  const detail = err instanceof Error ? err.message : String(err);
  const d1 = /no such table|D1/i.test(detail);
  const key = /SESSION_SIGNING_KEY|TOKEN_ENCRYPTION_KEY|32 random bytes/i.test(detail);
  const plain = d1
    ? 'The database tables are missing. Run the D1 migration, then try again.'
    : key
      ? 'A Worker secret is the wrong size. TOKEN_ENCRYPTION_KEY and SESSION_SIGNING_KEY must each be 32 random bytes, base64 — openssl rand -base64 32.'
      : 'That failed. Try once more. If it keeps happening, tell whoever set this up to check the Worker logs.';
  return c.html(layout({ title: 'Something went wrong', body: pageError(plain, detail) }), 500);
});

function secretFromPath(pathname: string): string | null {
  const parts = pathname.split('/');
  // ['', 'a', secret, ...]
  if (parts[1] !== 'a' || !parts[2]) return null;
  return parts[2];
}

async function passwordConfigured(env: Env): Promise<boolean> {
  const hash = await systemGet(env.DB, 'admin_password_hash');
  const salt = await systemGet(env.DB, 'admin_password_salt');
  return !!(hash && salt);
}

function subPath(pathname: string): string {
  const rest = pathname.split('/').slice(3).join('/');
  return rest ? `/${rest}` : '/';
}

adminRoutes.use('*', async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  const secret = secretFromPath(pathname);
  if (!secret || !timingSafeEqualString(secret, c.env.ADMIN_URL_SECRET ?? '')) return c.notFound();
  const base = `/a/${secret}`;
  c.set('adminBase', base);
  c.set('form', {});

  let session = await readSession(c.env.SESSION_SIGNING_KEY, c.req.header('Cookie'));
  const path = subPath(pathname);
  const isSetup = path === '/setup';
  const isLogin = path === '/login';
  const hasPassword = await passwordConfigured(c.env);

  if (!session && c.req.method === 'GET') {
    const made = await makeSession(c.env.SESSION_SIGNING_KEY, false);
    session = made.data;
    c.header('Set-Cookie', serializeSessionCookie(made.token, c.env.PUBLIC_BASE_URL, 60 * 60), { append: true });
  }
  if (!session) {
    return c.redirect(`${base}${isSetup ? '/setup' : '/login'}`, 302);
  }
  c.set('session', session);

  if (c.req.method === 'POST') {
    const parsed = await c.req.parseBody();
    const form: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') form[k] = v;
    }
    c.set('form', form);
    if (form.csrf !== session.csrf) {
      return c.html(
        layout({
          title: 'Expired form',
          body: html`<h1>That form expired</h1><p>Refresh the page and try again.</p>`,
        }),
        403,
      );
    }
  }

  if (!hasPassword && !isSetup) return c.redirect(`${base}/setup`, 302);
  if (hasPassword && !session.authed && !isLogin && !isSetup) return c.redirect(`${base}/login`, 302);

  await next();
});

function formOf(c: { get: (key: 'form') => Record<string, string> }): Record<string, string> {
  return c.get('form') ?? {};
}

adminRoutes.get('/setup', async (c) => {
  if (await passwordConfigured(c.env)) return c.redirect(`${c.get('adminBase')}/login`, 302);
  const base = c.get('adminBase');
  const session = c.get('session');
  return c.html(
    layout({
      title: 'Create password',
      body: html`
        <h1>Create your password</h1>
        <p>This page is only shown once. Pick a password you will remember — there is no email reset.</p>
        <form method="post" action="${base}/setup">
          ${csrfField(session.csrf)}
          <label for="password">Password</label>
          <input id="password" name="password" type="password" required minlength="8" autocomplete="new-password" />
          <label for="confirm">Type it again</label>
          <input id="confirm" name="confirm" type="password" required minlength="8" autocomplete="new-password" />
          <div class="row"><button type="submit">Save password</button></div>
        </form>
      `,
    }),
  );
});

adminRoutes.post('/setup', async (c) => {
  if (await passwordConfigured(c.env)) return c.redirect(`${c.get('adminBase')}/login`, 302);
  const form = formOf(c);
  const password = form.password ?? '';
  const confirm = form.confirm ?? '';
  const base = c.get('adminBase');
  if (password.length < 8) {
    return c.html(
      layout({
        title: 'Create password',
        body: html`<p class="err">Use at least 8 characters.</p><p><a href="${base}/setup">Back</a></p>`,
      }),
      400,
    );
  }
  if (password !== confirm) {
    return c.html(
      layout({
        title: 'Create password',
        body: html`<p class="err">Those two passwords did not match.</p><p><a href="${base}/setup">Back</a></p>`,
      }),
      400,
    );
  }
  try {
    const { hash, salt } = await hashPassword(password);
    await systemSet(c.env.DB, 'admin_password_hash', hash);
    await systemSet(c.env.DB, 'admin_password_salt', salt);

    const made = await makeSession(c.env.SESSION_SIGNING_KEY, true);
    c.header('Set-Cookie', serializeSessionCookie(made.token, c.env.PUBLIC_BASE_URL, 30 * 24 * 60 * 60));
    return c.redirect(`${base}/`, 302);
  } catch (err) {
    console.error(err);
    const detail = err instanceof Error ? err.message : String(err);
    return c.html(
      layout({
        title: 'Could not save password',
        body: pageError(
          'Could not save the password. If this keeps happening, a Worker secret may be wrong, or the database migration was skipped.',
          detail,
        ),
      }),
      500,
    );
  }
});

function loginPage(opts: { base: string; csrf: string; error?: string; lockedFor?: number }) {
  return layout({
    title: 'Log in',
    body: html`
      <h1>Log in</h1>
      ${opts.error ? html`<p class="err">${opts.error}</p>` : html``}
      ${opts.lockedFor
        ? html`<p class="muted">
            Too many wrong passwords. Try again in ${describeLock(opts.lockedFor)}. Each further
            attempt doubles the wait, up to an hour.
          </p>`
        : html`
            <form method="post" action="${opts.base}/login">
              ${csrfField(opts.csrf)}
              <label for="password">Password</label>
              <input id="password" name="password" type="password" required autocomplete="current-password" />
              <div class="row"><button type="submit">Log in</button></div>
            </form>
          `}
    `,
  });
}

adminRoutes.get('/login', async (c) => {
  if (!(await passwordConfigured(c.env))) return c.redirect(`${c.get('adminBase')}/setup`, 302);
  if (c.get('session').authed) return c.redirect(`${c.get('adminBase')}/`, 302);
  const remaining = lockRemaining(await readThrottle(c.env.DB), nowSeconds());
  return c.html(
    loginPage({
      base: c.get('adminBase'),
      csrf: c.get('session').csrf,
      error: c.req.query('e') ? 'Wrong password.' : undefined,
      lockedFor: remaining || undefined,
    }),
  );
});

adminRoutes.post('/login', async (c) => {
  const base = c.get('adminBase');
  const csrf = c.get('session').csrf;

  // Check the lock before hashing. PBKDF2 is the most expensive thing this
  // Worker does, so answering a locked-out attempt without running it also
  // stops the login form being used to burn CPU quota.
  const remaining = lockRemaining(await readThrottle(c.env.DB), nowSeconds());
  if (remaining > 0) {
    return c.html(loginPage({ base, csrf, lockedFor: remaining }), 429);
  }

  const password = formOf(c).password ?? '';
  const hash = await systemGet(c.env.DB, 'admin_password_hash');
  const salt = await systemGet(c.env.DB, 'admin_password_salt');
  const ok = hash && salt ? await verifyPassword(password, hash, salt) : false;

  if (!ok) {
    const lock = await recordFailure(c.env.DB);
    return c.html(
      loginPage({
        base,
        csrf,
        error: 'Wrong password.',
        lockedFor: lock > 0 ? lock : undefined,
      }),
      401,
    );
  }

  await clearFailures(c.env.DB);
  const made = await makeSession(c.env.SESSION_SIGNING_KEY, true);
  c.header('Set-Cookie', serializeSessionCookie(made.token, c.env.PUBLIC_BASE_URL, 30 * 24 * 60 * 60));
  return c.redirect(`${base}/`, 302);
});

adminRoutes.post('/logout', async (c) => {
  c.header('Set-Cookie', clearSessionCookie(c.env.PUBLIC_BASE_URL));
  return c.redirect(`${c.get('adminBase')}/login`, 302);
});

adminRoutes.on('GET', ['/', ''], async (c) => {
  const base = c.get('adminBase');
  const session = c.get('session');
  const now = nowSeconds();
  const accounts = await listAccounts(c.env.DB);
  c.executionCtx.waitUntil(ensureCommentSubscriptions(c.env));
  const sends = await recentSent(c.env.DB, 20);
  let events: Awaited<ReturnType<typeof recentWebhookEvents>> = [];
  try {
    events = await recentWebhookEvents(c.env.DB, 8);
  } catch {
    events = [];
  }
  const dayStart = Math.floor(now / 86400) * 86400;
  const counts = await todayCounters(c.env.DB, dayStart);
  const lastCron = await systemGet(c.env.DB, 'last_cron_ok_at');
  const lastCronN = lastCron ? parseInt(lastCron, 10) : NaN;
  const lastPoll = await systemGet(c.env.DB, 'last_poll_ok_at');
  const lastPollN = lastPoll ? parseInt(lastPoll, 10) : NaN;
  const cronStale = !Number.isFinite(lastCronN) || now - lastCronN > CRON_STALE_SECONDS;
  const reconnect = accounts.filter((a) => a.needs_reconnect === 1 || a.token_expires_at <= now);
  const latestEvent = events[0];
  const configProblems = findConfigProblems(c.env);

  const banners = [];
  if (reconnect.length) {
    const names = reconnect.map((a) => `@${a.username}`).join(', ');
    banners.push(html`
      <div class="banner">
        Instagram needs reconnecting${reconnect.length === 1 ? '' : ` for ${names}`}.
        <a href="/connect?reconnect=1">Click here — takes 20 seconds.</a>
      </div>
    `);
  }
  if (cronStale) {
    banners.push(html`
      <div class="banner">
        The daily Instagram check hasn’t run in over 3 days. Message whoever set this up — the automatic
        refresh job isn’t running.
      </div>
    `);
  }
  if (configProblems.length) {
    banners.push(html`
      <div class="banner">
        <b>${configProblems.length === 1 ? 'A Worker secret needs attention.' : `${String(configProblems.length)} Worker secrets need attention.`}</b>
        Whoever set this up should fix these and deploy again.
        <table style="margin-top:0.55rem">
          <tr><th>Secret</th><th>What is wrong</th><th>Command that fixes it</th></tr>
          ${configProblems.map(
            (p) => html`
              <tr>
                <td><code>${p.secret}</code></td>
                <td>${p.detail}</td>
                <td><code>${p.fix}</code></td>
              </tr>
            `,
          )}
        </table>
      </div>
    `);
  }
  if (latestEvent?.status === 'bad_sig') {
    banners.push(html`
      <div class="banner">
        Instagram reached this program but the signing secret did not match. Add
        <code>FACEBOOK_APP_SECRET</code> from App settings → Basic (click Show next to App secret).
      </div>
    `);
  }

  return c.html(
    layout({
      title: 'Home',
      base,
      csrf: c.get('session').csrf,
      body: html`
        ${banners}
        <h1>Home</h1>
        <div class="kpis">
          <div class="kpi"><span class="muted">Comments seen today</span><b>${String(counts.triggers)}</b></div>
          <div class="kpi"><span class="muted">DMs sent today</span><b>${String(counts.sends)}</b></div>
          <div class="kpi"><span class="muted">Failures today</span><b>${String(counts.failures)}</b></div>
        </div>

        <h2>Accounts</h2>
        ${accounts.length === 0
          ? html`<p>No Instagram account connected yet. <a href="/connect">Connect one</a> — takes about 20 seconds.</p>`
          : html`
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Status</th>
                    <th>Token</th>
                  </tr>
                </thead>
                <tbody>
                  ${accounts.map((a) => {
                    const days = daysUntil(a.token_expires_at, now);
                    let token = days < 0 ? 'Expired' : `${days} day${days === 1 ? '' : 's'} left`;
                    if (a.needs_reconnect) token = 'Needs reconnect';
                    const status = a.active ? 'Watching comments' : 'Paused';
                    return html`<tr>
                      <td>@${a.username}</td>
                      <td>${status}</td>
                      <td>${token}</td>
                    </tr>`;
                  })}
                </tbody>
              </table>
            `}

        <h2>Last 20 sends</h2>
        ${sends.length === 0
          ? html`<p class="muted">
              Nothing sent yet. The Meta app must be <b>Live</b> (Publish in the left sidebar) for
              real comments to arrive instantly. In Development, only Meta’s webhook <b>Test</b> button
              is delivered. A comment checker also runs every 5 minutes. Leave the rule on
              <b>All posts and reels</b>. A friend comments from a different account. Check their
              <b>Message requests</b> as well as inbox. If Hidden Words is on, turn it off for test
              comments or Instagram may hide them from this program.
            </p>`
          : html`
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Rule</th>
                    <th>Status</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  ${sends.map(
                    (s) => html`<tr>
                      <td>${fmtWhen(s.sent_at)}</td>
                      <td>${s.rule_label ?? '—'}</td>
                      <td>${statusWords(s.dm_status)}</td>
                      <td>${s.dm_status === 'failed' && s.error
                        ? html`<span class="err">Send failed.</span>
                            <div class="muted">${s.error}</div>`
                        : s.error
                          ? html`<span class="muted">${s.error}</span>`
                          : html``}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            `}

        <h2>Did Instagram reach us?</h2>
        ${events.length === 0
          ? html`<p class="muted">
              No notification has arrived yet. If the app is still in Development, that is expected
              for real comments. Publish the app, or wait up to 5 minutes for the comment checker.
              Meta’s webhook Test → Send to My Server should appear here immediately if the callback
              URL is correct.
            </p>`
          : html`
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Status</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  ${events.map(
                    (e) => html`<tr>
                      <td>${fmtWhen(e.received_at)}</td>
                      <td>${e.status === 'received'
                        ? 'Reached us'
                        : e.status === 'bad_sig'
                          ? 'Wrong secret'
                          : e.status}</td>
                      <td class="muted">${e.error ?? e.object ?? ''}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            `}

        <h2>Daily check</h2>
        <p class="muted">
          Last token refresh:
          ${Number.isFinite(lastCronN) ? fmtWhen(lastCronN) : 'never'}.
          Last comment checker:
          ${Number.isFinite(lastPollN) ? fmtWhen(lastPollN) : 'not yet'}.
        </p>
        <form method="post" action="${base}/run-cron">
          ${csrfField(session.csrf)}
          <button class="secondary" type="submit">Check connections now</button>
        </form>
      `,
    }),
  );
});

adminRoutes.post('/run-cron', async (c) => {
  await runCron(c.env);
  return c.redirect(`${c.get('adminBase')}/`, 302);
});

function looksLikePostUrl(s: string): boolean {
  return /^https?:\/\//i.test(s) || /instagram\.com|\/reel\/|\/p\/|\/tv\//i.test(s);
}

async function recentMediaOptions(
  env: Env,
): Promise<Array<{ id: string; label: string }>> {
  const accounts = await listAccounts(env.DB);
  const out: Array<{ id: string; label: string }> = [];
  for (const a of accounts) {
    try {
      const token = await decryptAesGcm(env.TOKEN_ENCRYPTION_KEY, a.token_iv, a.access_token_enc);
      const items = await listRecentMedia(token);
      for (const m of items) {
        out.push({
          id: m.id,
          label: `@${a.username} · ${m.kind === 'reel' ? 'Reel' : 'Post'} · ${m.caption}`,
        });
      }
    } catch {
      // Token or Graph failure — operator can still leave the field blank.
    }
  }
  return out;
}

function parseKeywordLines(raw: string): { ok: true; keywords: string[] } | { ok: false; error: string } {
  const keywords = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (keywords.length === 0) return { ok: false, error: 'Add at least one keyword, one per line.' };
  if (keywords.some((k) => k.length < 3)) return { ok: false, error: KEYWORD_TOO_SHORT_MESSAGE };
  return { ok: true, keywords };
}

function ruleForm(opts: {
  base: string;
  csrf: string;
  accounts: { ig_user_id: string; username: string }[];
  action: string;
  values: {
    ig_user_id: string;
    label: string;
    keywords: string;
    media_id: string;
    dm_text: string;
    public_reply_text: string;
  };
  posts: Array<{ id: string; label: string }>;
  error?: string;
}) {
  const v = opts.values;
  const dmLen = v.dm_text.length;
  const known = new Set(opts.posts.map((p) => p.id));
  return html`
    ${opts.error ? html`<p class="err">${opts.error}</p>` : html``}
    <form method="post" action="${opts.action}">
      ${csrfField(opts.csrf)}
      <label for="ig_user_id">Instagram account</label>
      <select id="ig_user_id" name="ig_user_id" required>
        ${opts.accounts.map(
          (a) =>
            html`<option value="${a.ig_user_id}" ${a.ig_user_id === v.ig_user_id ? 'selected' : ''}>
              @${a.username}
            </option>`,
        )}
      </select>
      <label for="label">Name for this rule</label>
      <input id="label" name="label" type="text" required value="${v.label}" placeholder="Free guide" />
      <label for="keywords">Keywords (one per line)</label>
      <textarea id="keywords" name="keywords" required placeholder="guide&#10;freebie">${v.keywords}</textarea>
      <p class="muted">A comment matches if it contains any of these as whole words.</p>
      <label for="media_id">Which posts</label>
      <select id="media_id" name="media_id">
        <option value="" ${!v.media_id ? 'selected' : ''}>All posts and reels (recommended)</option>
        ${opts.posts.map(
          (p) =>
            html`<option value="${p.id}" ${p.id === v.media_id ? 'selected' : ''}>${p.label}</option>`,
        )}
        ${v.media_id && !known.has(v.media_id)
          ? html`<option value="${v.media_id}" selected>Saved ID · ${v.media_id}</option>`
          : html``}
      </select>
      <p class="muted">
        Leave this on <b>All posts and reels</b> unless you want one reel only. A reel’s ID is a long number
        from Instagram, not the share link (<code>instagram.com/reel/…</code>). If the list is empty, leave it
        on all posts — that still covers reels.
      </p>
      <label for="dm_text">Private message to send</label>
      <textarea
        id="dm_text"
        name="dm_text"
        required
        maxlength="${String(DM_TEXT_MAX)}"
        oninput="this.nextElementSibling.textContent=this.value.length+'/1,000 characters'"
      >${v.dm_text}</textarea>
      <p class="muted">${String(dmLen)}/1,000 characters</p>
      <label for="public_reply_text">Public reply under the comment (optional)</label>
      <textarea id="public_reply_text" name="public_reply_text">${v.public_reply_text}</textarea>
      <p class="muted">Leave blank to only send the private message, with no public reply.</p>
      <div class="row"><button type="submit">Save rule</button></div>
    </form>
  `;
}

adminRoutes.get('/rules', async (c) => {
  const base = c.get('adminBase');
  const session = c.get('session');
  const accounts = await listAccounts(c.env.DB);
  const accountMap = new Map(accounts.map((a) => [a.ig_user_id, a.username]));
  const rules = await listRules(c.env.DB);
  return c.html(
    layout({
      title: 'Rules',
      base,
      csrf: c.get('session').csrf,
      body: html`
        <h1>Rules</h1>
        <p class="muted">When a comment matches a keyword, we send that person one private message.</p>
        <p><a class="btn" href="${base}/rules/new">New rule</a></p>
        ${rules.length === 0
          ? html`<p>No rules yet.</p>`
          : html`
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Account</th>
                    <th>Keywords</th>
                    <th>On</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${rules.map((r) => {
                    const kws = parseKeywords(r.keywords).join(', ');
                    return html`<tr>
                      <td>${r.label}</td>
                      <td>@${accountMap.get(r.ig_user_id) ?? r.ig_user_id}</td>
                      <td>${kws}</td>
                      <td>${r.active ? 'Yes' : 'Paused'}</td>
                      <td class="actions">
                        <a href="${base}/rules/${String(r.id)}/edit">Edit</a>
                        <form method="post" action="${base}/rules/${String(r.id)}/toggle">
                          ${csrfField(session.csrf)}
                          <button class="secondary" type="submit">${r.active ? 'Pause' : 'Resume'}</button>
                        </form>
                        <form
                          method="post"
                          action="${base}/rules/${String(r.id)}/delete"
                          onsubmit="return confirm('Delete this rule?')"
                        >
                          ${csrfField(session.csrf)}
                          <button class="danger" type="submit">Delete</button>
                        </form>
                      </td>
                    </tr>`;
                  })}
                </tbody>
              </table>
            `}
      `,
    }),
  );
});

adminRoutes.get('/rules/new', async (c) => {
  const accounts = await listAccounts(c.env.DB);
  const base = c.get('adminBase');
  if (accounts.length === 0) {
    return c.html(
      layout({
        title: 'New rule',
        base,
        csrf: c.get('session').csrf,
        body: html`<h1>New rule</h1><p>Connect an Instagram account first on the <a href="${base}/accounts">Accounts</a> page.</p>`,
      }),
    );
  }
  return c.html(
    layout({
      title: 'New rule',
      base,
      csrf: c.get('session').csrf,
      body: html`<h1>New rule</h1>${ruleForm({
        base,
        csrf: c.get('session').csrf,
        accounts,
        action: `${base}/rules`,
        values: {
          ig_user_id: accounts[0]!.ig_user_id,
          label: '',
          keywords: '',
          media_id: '',
          dm_text: '',
          public_reply_text: '',
        },
        posts: await recentMediaOptions(c.env),
      })}`,
    }),
  );
});

function readRuleFields(form: Record<string, string>) {
  const parsed = parseKeywordLines(form.keywords ?? '');
  const dm = (form.dm_text ?? '').trim();
  const label = (form.label ?? '').trim();
  const ig = (form.ig_user_id ?? '').trim();
  const media = (form.media_id ?? '').trim();
  const pub = (form.public_reply_text ?? '').trim();
  if (!label) return { error: 'Give this rule a name.' };
  if (!ig) return { error: 'Pick an Instagram account.' };
  if (!parsed.ok) return { error: parsed.error };
  if (!dm) return { error: 'Write the private message to send.' };
  if (dm.length > DM_TEXT_MAX) return { error: 'The private message must be 1,000 characters or fewer.' };
  if (media && looksLikePostUrl(media)) {
    return {
      error:
        'That looks like a link, not a post ID. Leave “Which posts” on All posts and reels, or pick a reel from the list.',
    };
  }
  return {
    row: {
      ig_user_id: ig,
      label,
      keywords: JSON.stringify(parsed.keywords),
      media_id: media || null,
      dm_text: dm,
      public_reply_text: pub || null,
    },
  };
}

adminRoutes.post('/rules', async (c) => {
  const fields = readRuleFields(formOf(c));
  const base = c.get('adminBase');
  if ('error' in fields) {
    const accounts = await listAccounts(c.env.DB);
    const f = formOf(c);
    return c.html(
      layout({
        title: 'New rule',
        base,
        csrf: c.get('session').csrf,
        body: html`<h1>New rule</h1>${ruleForm({
          base,
          csrf: c.get('session').csrf,
          accounts,
          action: `${base}/rules`,
          values: {
            ig_user_id: f.ig_user_id ?? '',
            label: f.label ?? '',
            keywords: f.keywords ?? '',
            media_id: f.media_id ?? '',
            dm_text: f.dm_text ?? '',
            public_reply_text: f.public_reply_text ?? '',
          },
          posts: await recentMediaOptions(c.env),
          error: fields.error,
        })}`,
      }),
      400,
    );
  }
  await insertRule(c.env.DB, { ...fields.row, created_at: nowSeconds() });
  return c.redirect(`${base}/rules`, 302);
});

adminRoutes.get('/rules/:id/edit', async (c) => {
  const id = Number(c.req.param('id'));
  const rule = await getRule(c.env.DB, id);
  const base = c.get('adminBase');
  if (!rule) return c.notFound();
  const accounts = await listAccounts(c.env.DB);
  return c.html(
    layout({
      title: 'Edit rule',
      base,
      csrf: c.get('session').csrf,
      body: html`<h1>Edit rule</h1>${ruleForm({
        base,
        csrf: c.get('session').csrf,
        accounts,
        action: `${base}/rules/${String(rule.id)}`,
        values: {
          ig_user_id: rule.ig_user_id,
          label: rule.label,
          keywords: parseKeywords(rule.keywords).join('\n'),
          media_id: rule.media_id ?? '',
          dm_text: rule.dm_text,
          public_reply_text: rule.public_reply_text ?? '',
        },
        posts: await recentMediaOptions(c.env),
      })}`,
    }),
  );
});

adminRoutes.post('/rules/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await getRule(c.env.DB, id);
  if (!existing) return c.notFound();
  const fields = readRuleFields(formOf(c));
  const base = c.get('adminBase');
  if ('error' in fields) {
    const accounts = await listAccounts(c.env.DB);
    const f = formOf(c);
    return c.html(
      layout({
        title: 'Edit rule',
        base,
        csrf: c.get('session').csrf,
        body: html`<h1>Edit rule</h1>${ruleForm({
          base,
          csrf: c.get('session').csrf,
          accounts,
          action: `${base}/rules/${String(id)}`,
          values: {
            ig_user_id: f.ig_user_id ?? '',
            label: f.label ?? '',
            keywords: f.keywords ?? '',
            media_id: f.media_id ?? '',
            dm_text: f.dm_text ?? '',
            public_reply_text: f.public_reply_text ?? '',
          },
          posts: await recentMediaOptions(c.env),
          error: fields.error,
        })}`,
      }),
      400,
    );
  }
  await updateRule(c.env.DB, id, fields.row);
  return c.redirect(`${base}/rules`, 302);
});

adminRoutes.post('/rules/:id/toggle', async (c) => {
  await toggleRule(c.env.DB, Number(c.req.param('id')));
  return c.redirect(`${c.get('adminBase')}/rules`, 302);
});

adminRoutes.post('/rules/:id/delete', async (c) => {
  await deleteRule(c.env.DB, Number(c.req.param('id')));
  return c.redirect(`${c.get('adminBase')}/rules`, 302);
});

adminRoutes.get('/test', async (c) => {
  const accounts = await listAccounts(c.env.DB);
  const base = c.get('adminBase');
  const posts = accounts.length ? await recentMediaOptions(c.env) : [];
  return c.html(
    layout({
      title: 'Test',
      base,
      csrf: c.get('session').csrf,
      body: html`
        <h1>Test a comment</h1>
        <p>Paste a comment and see which rule would fire. Nothing is sent to anyone.</p>
        ${accounts.length === 0
          ? html`<p>Connect an Instagram account first.</p>`
          : html`
              <form method="post" action="${base}/test">
                ${csrfField(c.get('session').csrf)}
                <label for="ig_user_id">Account</label>
                <select id="ig_user_id" name="ig_user_id" required>
                  ${accounts.map((a) => html`<option value="${a.ig_user_id}">@${a.username}</option>`)}
                </select>
                <label for="text">Comment text</label>
                <textarea id="text" name="text" required placeholder="Guide please!"></textarea>
                <label for="media_id">Which posts</label>
                <select id="media_id" name="media_id">
                  <option value="">All posts and reels</option>
                  ${posts.map((p) => html`<option value="${p.id}">${p.label}</option>`)}
                </select>
                <p class="muted">Leave on all posts unless you limited a rule to one reel.</p>
                <div class="row"><button type="submit">See what would happen</button></div>
              </form>
            `}
      `,
    }),
  );
});

adminRoutes.post('/test', async (c) => {
  const form = formOf(c);
  const ig = form.ig_user_id ?? '';
  const text = form.text ?? '';
  const media = form.media_id?.trim() || undefined;
  const rules = (await listRules(c.env.DB, ig)).filter((r) => r.active === 1);
  const match = findMatchingRule(rules, text, media);
  const base = c.get('adminBase');
  return c.html(
    layout({
      title: 'Test',
      base,
      csrf: c.get('session').csrf,
      body: html`
        <h1>Test result</h1>
        ${match
          ? html`
              <div class="ok">
                This would match the rule <b>${match.label}</b>.
              </div>
              <h2>Private message that would be sent</h2>
              <p>${match.dm_text}</p>
              ${match.public_reply_text
                ? html`<h2>Public reply that would be posted</h2><p>${match.public_reply_text}</p>`
                : html`<p class="muted">No public reply for this rule.</p>`}
            `
          : html`<p>No rule would match this comment. Nothing would be sent.</p>`}
        <p><a href="${base}/test">Test another</a></p>
      `,
    }),
  );
});

adminRoutes.get('/accounts', async (c) => {
  const accounts = await listAccounts(c.env.DB);
  const base = c.get('adminBase');
  const session = c.get('session');
  const now = nowSeconds();
  const callback = oauthRedirectUri(c.req.url, c.env.PUBLIC_BASE_URL);
  return c.html(
    layout({
      title: 'Accounts',
      base,
      csrf: c.get('session').csrf,
      body: html`
        <h1>Accounts</h1>
        <p>Connect the Instagram account you post from. You can connect more than one if they are all yours.</p>
        <p class="muted">
          In Meta: Instagram → API setup with Instagram login → click <b>Set up</b> under
          “3. Set up Instagram business login”. Paste the first line as <b>Redirect URL</b>. Then
          Business login settings → OAuth redirect URIs (add both lines). Use the Instagram App ID
          from that same page, not the Facebook app id at the top of the dashboard.
        </p>
        <pre class="raw">${callback}
${callback}/</pre>
        <p><a class="btn" href="/connect">Connect a new account</a></p>
        ${accounts.length === 0
          ? html`<p class="muted">None connected yet.</p>`
          : html`
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${accounts.map((a) => {
                    const days = daysUntil(a.token_expires_at, now);
                    const expired = days < 0 || a.needs_reconnect === 1;
                    return html`<tr>
                      <td>@${a.username}</td>
                      <td>
                        ${a.active ? 'Active' : 'Paused'}
                        · ${expired ? html`<span class="err">needs reconnect</span>` : `${days} days left`}
                      </td>
                      <td class="actions">
                        <a class="btn" href="/connect?reconnect=1">Reconnect</a>
                        ${a.active
                          ? html`<form method="post" action="${base}/accounts/${a.ig_user_id}/deactivate">
                              ${csrfField(session.csrf)}
                              <button class="secondary" type="submit">Pause</button>
                            </form>`
                          : html`<form method="post" action="${base}/accounts/${a.ig_user_id}/activate">
                              ${csrfField(session.csrf)}
                              <button class="secondary" type="submit">Resume</button>
                            </form>`}
                      </td>
                    </tr>`;
                  })}
                </tbody>
              </table>
            `}
      `,
    }),
  );
});

adminRoutes.post('/accounts/:id/deactivate', async (c) => {
  await setAccountActive(c.env.DB, c.req.param('id'), 0);
  return c.redirect(`${c.get('adminBase')}/accounts`, 302);
});

adminRoutes.post('/accounts/:id/activate', async (c) => {
  await setAccountActive(c.env.DB, c.req.param('id'), 1);
  return c.redirect(`${c.get('adminBase')}/accounts`, 302);
});

/** Unlisted. Used by scripts/selftest.ts against a deployed URL. */
adminRoutes.post('/selftest/seed', async (c) => {
  const now = nowSeconds();
  const enc = await encryptAesGcm(c.env.TOKEN_ENCRYPTION_KEY, 'selftest-dummy-token');
  await upsertAccount(c.env.DB, {
    ig_user_id: 'selftest_ig_user',
    username: 'selftest',
    access_token_enc: enc.ciphertext,
    token_iv: enc.iv,
    token_expires_at: now + 50 * 24 * 60 * 60,
    connected_at: now,
    last_refreshed_at: now,
  });
  return c.json({ ok: true, ig_user_id: 'selftest_ig_user' });
});

adminRoutes.get('/selftest/status', async (c) => {
  const commentId = c.req.query('comment_id') ?? '';
  const lastCron = await systemGet(c.env.DB, 'last_cron_ok_at');
  const count = commentId ? await countSentByComment(c.env.DB, commentId) : 0;
  const row = commentId ? await getSent(c.env.DB, commentId) : null;
  return c.json({ last_cron_ok_at: lastCron, count, row });
});
