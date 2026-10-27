import { Hono } from 'hono';
import { html } from 'hono/html';
import {
  CRON_STALE_SECONDS,
  DM_TEXT_MAX,
  PUBLIC_REPLY_MAX,
  decryptAesGcm,
  encryptAesGcm,
  hashPassword,
  nowSeconds,
  timingSafeEqualString,
  verifyPassword,
} from '../crypto.ts';
import { ensureCommentSubscriptions, runCron } from '../cron.ts';
import {
  HEALTH_FIRST_SEEN_KEY,
  type SendTotals,
  countSentByComment,
  deleteRule,
  getAccount,
  getRule,
  getSent,
  healthSnapshot,
  insertRule,
  latestSignedWebhookStatus,
  listAccounts,
  listRules,
  recentSent,
  recentWebhookEvents,
  sendTotals,
  sendTotalsByAccount,
  setAccountActive,
  systemGet,
  systemSet,
  toggleRule,
  updateRule,
  upsertAccount,
} from '../db.ts';
import { findConfigProblems } from '../config.ts';
import { csrfField, daysUntil, fmtWhen, layout, pageError, statusWords } from '../html.ts';
import {
  EXCLUSION_TOO_SHORT_MESSAGE,
  KEYWORD_TOO_SHORT_MESSAGE,
  isMatchMode,
  keywordProblem,
  keywordSwallowedBy,
  normalizeCommentText,
  parseKeywords,
} from '../match.ts';
import { listRecentMedia, oauthRedirectUri } from '../meta.ts';
import {
  SAMPLE_USERNAME,
  USERNAME_GROWTH,
  countUsernameTokens,
  fillPlaceholders,
  worstCaseLength,
} from '../placeholders.ts';
import { chooseRule } from '../process.ts';
import { parsePublicReplies, serializePublicReplies } from '../replies.ts';
import { CRON_FIRST_RUN_SECONDS, jobState } from './health.ts';
import { clearSessionCookie, makeSession, readSession, serializeSessionCookie } from '../session.ts';
import {
  clearFailures,
  describeLock,
  lockRemaining,
  readThrottle,
  recordFailure,
} from '../throttle.ts';
import type { Env, MatchMode, Rule, SessionData } from '../types.ts';

type Vars = {
  adminBase: string;
  session: SessionData;
  form: Record<string, string>;
};

export const adminRoutes = new Hono<{ Bindings: Env; Variables: Vars }>({ strict: false });

adminRoutes.onError((err, c) => {
  console.error(err);
  const detail = err instanceof Error ? err.message : String(err);
  const d1 = /no such table/i.test(detail);
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
      app: base,
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
        body: html`<p class="err">Use at least 8 characters.</p><p><a class="btn secondary" href="${base}/setup">Back</a></p>`,
      }),
      400,
    );
  }
  if (password !== confirm) {
    return c.html(
      layout({
        title: 'Create password',
        body: html`<p class="err">Those two passwords did not match.</p><p><a class="btn secondary" href="${base}/setup">Back</a></p>`,
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
    app: opts.base,
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

const DAY = 24 * 60 * 60;

// Windows start at a UTC midnight, so "Last 7 days" is today and the six days
// before it. One fixed clock means the numbers don't shift with the viewer.
const TOTAL_WINDOWS = [
  { label: 'Today (UTC)', days: 1 },
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'All time', days: null },
];

function windowStarts(now: number): number[] {
  const today = Math.floor(now / DAY) * DAY;
  return TOTAL_WINDOWS.map((w) => (w.days == null ? 0 : today - (w.days - 1) * DAY));
}

function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

function totalsTiles(totals: SendTotals[]) {
  return html`
    <div class="kpis">
      ${TOTAL_WINDOWS.map((w, i) => {
        const t = totals[i] ?? { sent: 0, skipped: 0, failed: 0, reached: 0 };
        const failed = `${fmtCount(t.failed)} failed`;
        return html`<div class="kpi">
          <span class="muted">${w.label}</span>
          <b>${fmtCount(t.reached)}</b>
          people reached
          <div class="muted">
            ${fmtCount(t.sent)} DMs sent<br />${fmtCount(t.skipped)} skipped<br />
            ${t.failed ? html`<span class="err">${failed}</span>` : failed}
          </div>
        </div>`;
      })}
    </div>
  `;
}

adminRoutes.on('GET', ['/', ''], async (c) => {
  const base = c.get('adminBase');
  const session = c.get('session');
  const now = nowSeconds();
  const accounts = await listAccounts(c.env.DB);
  c.executionCtx.waitUntil(ensureCommentSubscriptions(c.env));
  const sends = await recentSent(c.env.DB, 20);
  let events: Awaited<ReturnType<typeof recentWebhookEvents>> = [];
  let latestSigned: string | null = null;
  try {
    events = await recentWebhookEvents(c.env.DB, 8);
    latestSigned = await latestSignedWebhookStatus(c.env.DB);
  } catch {
    events = [];
  }
  const starts = windowStarts(now);
  const totals = await sendTotals(c.env.DB, starts);
  // With one account the breakdown would repeat the totals, so skip its query.
  const byAccount = accounts.length > 1 ? await sendTotalsByAccount(c.env.DB, starts) : null;
  const health = await healthSnapshot(c.env.DB, now);
  // Shares /health's clock, so a deploy nobody monitors still gets its grace
  // period from the first time the operator opens Home.
  if (health.firstSeenAt == null) await systemSet(c.env.DB, HEALTH_FIRST_SEEN_KEY, String(now));
  const cron = jobState(health.lastCronOkAt, CRON_STALE_SECONDS, CRON_FIRST_RUN_SECONDS, health.firstSeenAt ?? now, now);
  const reconnect = accounts.filter((a) => a.needs_reconnect === 1 || a.token_expires_at <= now);
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
  if (cron === 'starting') {
    const todayRun = Math.floor(now / DAY) * DAY + 3 * 60 * 60;
    const next = todayRun > now ? todayRun : todayRun + DAY;
    banners.push(html`
      <div class="note">
        The daily Instagram check hasn’t run yet. It runs at 03:00 UTC every day, so expect the first run by
        ${fmtWhen(next)}.
      </div>
    `);
  } else if (cron === 'stale') {
    banners.push(html`
      <div class="banner">
        ${health.lastCronOkAt == null
          ? 'The daily Instagram check has never run, and its first run at 03:00 UTC is overdue.'
          : 'The daily Instagram check hasn’t run in over 3 days.'}
        Message whoever set this up — the automatic refresh job isn’t running.
      </div>
    `);
  }
  if (configProblems.length) {
    banners.push(html`
      <div class="banner">
        <b>${configProblems.length === 1 ? 'A Worker secret needs attention.' : `${String(configProblems.length)} Worker secrets need attention.`}</b>
        Whoever set this up should fix these and deploy again.
        <div class="table-wrap"><table style="margin-top:0.55rem">
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
        </table></div>
      </div>
    `);
  }
  if (latestSigned === 'bad_sig') {
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
        ${totalsTiles(totals)}
        <p class="muted">
          Days start at 00:00 UTC, and the 7- and 30-day totals include today. People reached counts each
          person once, and only if a DM actually went out to them.
        </p>
        ${byAccount
          ? html`
              <h2>By account</h2>
              ${accounts.map(
                (a) => html`<h3>@${a.username}</h3>
                  ${totalsTiles(byAccount.get(a.ig_user_id) ?? [])}`,
              )}
            `
          : html``}

        <h2>Accounts</h2>
        ${accounts.length === 0
          ? html`<p>No Instagram account connected yet. <a href="/connect">Connect one</a> — takes about 20 seconds.</p>`
          : html`
              <div class="table-wrap"><table>
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
              </table></div>
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
              <div class="table-wrap"><table>
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
                      <td>
                        ${s.dm_status === 'failed' && s.error
                          ? html`<span class="err">Send failed.</span>
                              <div class="muted detail">${s.error}</div>`
                          : s.error
                            ? html`<span class="muted detail">${s.error}</span>`
                            : html``}
                        ${s.reply_status === 'skipped'
                          ? html`<div class="muted">Public reply not posted, because no DM went out.</div>`
                          : html``}
                      </td>
                    </tr>`,
                  )}
                </tbody>
              </table></div>
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
              <div class="table-wrap"><table>
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
                          : e.status === 'unsigned'
                            ? 'Not signed'
                            : e.status}</td>
                      <td class="muted detail">${e.error ?? e.object ?? ''}</td>
                    </tr>`,
                  )}
                </tbody>
              </table></div>
            `}

        <h2>Daily check</h2>
        <p class="muted">
          Last token refresh:
          ${health.lastCronOkAt != null ? fmtWhen(health.lastCronOkAt) : 'never'}.
          Last comment checker:
          ${health.lastPollOkAt != null ? fmtWhen(health.lastPollOkAt) : 'not yet'}.
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

function keywordLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function firstKeywordProblem(words: string[], tooShortMessage: string): string | null {
  for (const word of words) {
    const problem = keywordProblem(word, tooShortMessage);
    if (problem) return problem;
  }
  return null;
}

/** How many variation fields the form offers beside the main public reply. */
const EXTRA_REPLIES = 4;

/**
 * The main reply, then every variation field the form sent, blanks included,
 * so a form shown again after an error keeps each reply in its own field.
 */
function replyFields(form: Record<string, string>): string[] {
  const fields = [form.public_reply_text ?? ''];
  for (let i = 2; `public_reply_text_${String(i)}` in form; i++) fields.push(form[`public_reply_text_${String(i)}`] ?? '');
  return fields;
}

type RuleFormValues = {
  ig_user_id: string;
  label: string;
  keywords: string;
  match_mode: string;
  exclude_keywords: string;
  match_all: boolean;
  media_id: string;
  dm_text: string;
  /** The main reply first, then the variations, in the fields they came from. */
  public_replies: string[];
};

function formValuesFromRule(rule: Rule): RuleFormValues {
  return {
    ig_user_id: rule.ig_user_id,
    label: rule.label,
    keywords: parseKeywords(rule.keywords).join('\n'),
    match_mode: rule.match_mode,
    exclude_keywords: parseKeywords(rule.exclude_keywords).join('\n'),
    match_all: rule.match_all === 1,
    media_id: rule.media_id ?? '',
    dm_text: rule.dm_text,
    public_replies: parsePublicReplies(rule.public_reply_text),
  };
}

/** What the operator typed, echoed back unchanged when the form is rejected. */
function formValuesFromPost(f: Record<string, string>): RuleFormValues {
  return {
    ig_user_id: f.ig_user_id ?? '',
    label: f.label ?? '',
    keywords: f.keywords ?? '',
    match_mode: f.match_mode ?? 'word',
    exclude_keywords: f.exclude_keywords ?? '',
    match_all: f.match_all === '1',
    media_id: f.media_id ?? '',
    dm_text: f.dm_text ?? '',
    public_replies: replyFields(f),
  };
}

const EVERY_COMMENT_WORDS = 'Every comment on its post';

const MATCH_MODE_WORDS: Record<MatchMode, string> = {
  word: 'Whole words only',
  contains: 'Anywhere in the comment',
};

function ruleForm(opts: {
  base: string;
  csrf: string;
  accounts: { ig_user_id: string; username: string }[];
  action: string;
  values: RuleFormValues;
  posts: Array<{ id: string; label: string }>;
  error?: string;
}) {
  const v = opts.values;
  const known = new Set(opts.posts.map((p) => p.id));
  const [mainReply = '', ...variations] = v.public_replies;
  const variationFields = Array.from({ length: Math.max(EXTRA_REPLIES, variations.length) }, (_, i) => variations[i] ?? '');
  const contains = v.match_mode === 'contains';
  return html`
    ${opts.error ? html`<p class="err" role="alert">${opts.error}</p>` : html``}
    <form class="rule-form" method="post" action="${opts.action}">
      ${csrfField(opts.csrf)}
      <label for="label">Rule name</label>
      <input id="label" name="label" type="text" required value="${v.label}" placeholder="Free guide" />
      <p class="muted">Only you see this. It helps you tell your rules apart.</p>

      <fieldset class="group">
        <legend>Where to watch</legend>
        <label for="ig_user_id">Instagram account</label>
        <select id="ig_user_id" name="ig_user_id" required>
          ${opts.accounts.map(
            (a) =>
              html`<option value="${a.ig_user_id}" ${a.ig_user_id === v.ig_user_id ? 'selected' : ''}>
                @${a.username}
              </option>`,
          )}
        </select>
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
        <p class="muted when-keywords">
          Leave this on <b>All posts and reels</b> unless you want one reel only. A reel’s ID is a long number
          from Instagram, not the share link (<code>instagram.com/reel/…</code>). If the list is empty, leave it
          on all posts — that still covers reels.
        </p>
        <p class="muted when-all">Pick the one post or reel whose commenters should all get the message.</p>
      </fieldset>

      <fieldset class="group">
        <legend>Which comments get a message</legend>
        <label class="choice">
          <input type="checkbox" id="match_all" name="match_all" value="1" ${v.match_all ? 'checked' : ''} />
          <span>
            <b>Reply to every comment on this post</b>
            <span class="muted">
              For giveaways and waitlists: everyone who comments gets the message, no keyword needed. Each
              comment gets its own message, so someone who comments three times gets it three times.
            </span>
          </span>
        </label>
        <p class="err needs-post">
          Pick one post or reel under “Which posts” above. This can’t be used on all posts: it would message
          everyone who comments on anything, and Instagram may restrict the account.
        </p>
        <p class="muted when-all">
          Older posts: every 5 minutes a check also reads the post’s 25 newest comments from the last 3 days,
          and any it hasn’t handled before get the message too, up to 10 messages per check. Comments it
          already skipped stay skipped.
        </p>
        <div class="when-keywords">
          <label for="keywords">Keywords</label>
          <textarea id="keywords" name="keywords" placeholder="guide&#10;freebie">${v.keywords}</textarea>
          <p class="muted">
            One per line. A comment with any of these gets your message. Capitals, accents, emoji and
            punctuation don’t matter, so “GUIDE!!” counts as “guide”. Each keyword needs at least 3 letters.
          </p>
          <fieldset class="choices">
            <legend>How to look for them</legend>
            <label class="choice">
              <input type="radio" name="match_mode" value="word" ${contains ? '' : 'checked'} />
              <span>
                <b>${MATCH_MODE_WORDS.word}</b> (recommended)
                <span class="muted">“guide” matches “Guide please!” but not “guides” or “guidelines”.</span>
              </span>
            </label>
            <label class="choice">
              <input type="radio" name="match_mode" value="contains" ${contains ? 'checked' : ''} />
              <span>
                <b>${MATCH_MODE_WORDS.contains}</b>
                <span class="muted">Contains also catches #launch2026, but “art” would match “start”.</span>
              </span>
            </label>
          </fieldset>
        </div>
        <label for="exclude_keywords">Exclusions (optional)</label>
        <textarea id="exclude_keywords" name="exclude_keywords" placeholder="how much&#10;already have it&#10;not interested">${v.exclude_keywords}</textarea>
        <p class="muted">
          Skip comments that contain any of these, even when a keyword matches. One per line. Useful for
          “how much is the guide?” or “I already have the guide”, which mention your keyword but don’t want
          the message. They are found the same way as your keywords. Another rule without these exclusions
          can still reply.
        </p>
        <p class="muted when-all">On a rule that replies to every comment, exclusions are found as whole words.</p>
      </fieldset>

      <fieldset class="group">
        <legend>What to send</legend>
        <label for="dm_text">Private message</label>
        <textarea id="dm_text" name="dm_text" required maxlength="${String(DM_TEXT_MAX)}">${v.dm_text}</textarea>
        <p class="muted">
          Up to 1,000 characters. Instagram allows one private message per comment, so put everything they
          need in this one, link included.
          <code>{username}</code> puts in their Instagram name and counts as 30. It’s the only placeholder for now.
        </p>
        <label for="public_reply_text">Public reply under their comment (optional)</label>
        <textarea id="public_reply_text" name="public_reply_text" maxlength="${String(PUBLIC_REPLY_MAX)}">${mainReply}</textarea>
        <p class="muted">
          Everyone reading the comments sees this, for example “Sent you a DM!”. Leave it blank to reply
          privately only. If the private message fails, the public reply is not posted either. Up to 1,000
          characters, and <code>{username}</code> works here too.
        </p>
        <details ${variations.some((r) => r.trim()) ? 'open' : ''}>
          <summary>Add variations (optional)</summary>
          <p class="muted">Each comment gets one of your replies, picked at random, so the thread doesn’t look automated.</p>
          ${variationFields.map((text, i) => {
            const name = `public_reply_text_${String(i + 2)}`;
            return html`
              <label for="${name}">Reply ${String(i + 2)}</label>
              <textarea id="${name}" name="${name}" class="short" maxlength="${String(PUBLIC_REPLY_MAX)}">${text}</textarea>
            `;
          })}
        </details>
      </fieldset>

      <div class="row"><button type="submit">Save rule</button></div>
    </form>
  `;
}

adminRoutes.get('/rules', async (c) => {
  const base = c.get('adminBase');
  const session = c.get('session');
  const accounts = await listAccounts(c.env.DB);
  const accountMap = new Map(accounts.map((a) => [a.ig_user_id, a.username]));
  // With one account the column says the same thing on every row, and dropping
  // it is what lets the action buttons fit on a phone without scrolling.
  const showAccount = accounts.length > 1;
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
              <div class="table-wrap"><table>
                <thead>
                  <tr>
                    <th>Name</th>
                    ${showAccount ? html`<th>Account</th>` : html``}
                    <th>Keywords</th>
                    <th>On</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${rules.map((r) => {
                    const kws = r.match_all === 1 ? EVERY_COMMENT_WORDS : parseKeywords(r.keywords).join(', ');
                    const exclusions = parseKeywords(r.exclude_keywords);
                    return html`<tr>
                      <td>${r.label}</td>
                      ${showAccount ? html`<td>@${accountMap.get(r.ig_user_id) ?? r.ig_user_id}</td>` : html``}
                      <td>
                        ${kws}
                        ${r.match_mode === 'contains'
                          ? html`<div class="muted">${MATCH_MODE_WORDS.contains}</div>`
                          : html``}
                        ${exclusions.length
                          ? html`<div class="muted">Exclusions: ${exclusions.join(', ')}</div>`
                          : html``}
                      </td>
                      <td>${r.active ? 'Yes' : 'Paused'}</td>
                      <td class="actions">
                        <a class="btn secondary" href="${base}/rules/${String(r.id)}/edit">Edit</a>
                        <form method="post" action="${base}/rules/${String(r.id)}/toggle">
                          ${csrfField(session.csrf)}
                          <button class="secondary" type="submit">${r.active ? 'Pause' : 'Resume'}</button>
                        </form>
                        <a class="btn danger" href="${base}/rules/${String(r.id)}/delete">Delete</a>
                      </td>
                    </tr>`;
                  })}
                </tbody>
              </table></div>
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
        values: { ...formValuesFromPost({}), ig_user_id: accounts[0]!.ig_user_id },
        posts: await recentMediaOptions(c.env),
      })}`,
    }),
  );
});

const count = (n: number): string => n.toLocaleString('en-US');

/**
 * Checked against the longest the text can become once a name is put in, not
 * against what was typed, so a rule that saves always fits Instagram's limit.
 */
function messageProblem(what: string, text: string, max: number): string | null {
  if (!fillPlaceholders(text, null).trim()) {
    return `${what} needs more than {username}. Instagram sometimes leaves the name out, and then there would be nothing to send.`;
  }
  const longest = worstCaseLength(text);
  if (longest <= max) return null;
  const limit = `${what} must be ${count(max)} characters or fewer.`;
  if (!countUsernameTokens(text)) return `${limit} This one is ${count(text.length)}.`;
  return `${limit} This one is ${count(text.length)}, and each {username} can add up to ${USERNAME_GROWTH} characters for a long name, so it could reach ${count(longest)}.`;
}

export const MATCH_ALL_NEEDS_POST_MESSAGE =
  '“Reply to every comment” needs one post. Pick it under “Which posts”, or untick the box. On all posts it would message everyone who comments on anything, and Instagram may restrict the account.';

/**
 * Exported for the unit tests. CSS can hide a field but cannot stop a form
 * being posted, so this, not the form, is what keeps a match-all rule off
 * "All posts".
 */
export function readRuleFields(form: Record<string, string>) {
  const keywords = keywordLines(form.keywords ?? '');
  const exclusions = keywordLines(form.exclude_keywords ?? '');
  // Browsers submit each textarea line break as CRLF but count it as one
  // character against maxlength. Without this, a message that fit the box
  // could still fail the length check below.
  const dm = (form.dm_text ?? '').replace(/\r\n/g, '\n').trim();
  const label = (form.label ?? '').trim();
  const ig = (form.ig_user_id ?? '').trim();
  const media = (form.media_id ?? '').trim();
  const replies = replyFields(form).map((r) => r.replace(/\r\n/g, '\n').trim());
  const matchAll = form.match_all === '1';
  if (!label) return { error: 'Give this rule a name.' };
  if (!ig) return { error: 'Pick an Instagram account.' };
  if (matchAll && !media) return { error: MATCH_ALL_NEEDS_POST_MESSAGE };
  // A match-all rule hides the keywords and the radios, and the matcher never
  // reads its keywords, so neither is checked or kept. Its exclusions are
  // still matched, as whole words, which is what the form tells the operator.
  let matchMode: MatchMode = 'word';
  if (!matchAll) {
    if (keywords.length === 0) return { error: 'Add at least one keyword, one per line.' };
    const keywordError = firstKeywordProblem(keywords, KEYWORD_TOO_SHORT_MESSAGE);
    if (keywordError) return { error: keywordError };
    // A form from before match modes existed sends no choice; that rule matched whole words.
    const chosen = form.match_mode ?? 'word';
    if (!isMatchMode(chosen)) {
      return { error: 'Choose how to look for keywords: whole words only, or anywhere in the comment.' };
    }
    matchMode = chosen;
  }
  const exclusionError = firstKeywordProblem(exclusions, EXCLUSION_TOO_SHORT_MESSAGE);
  if (exclusionError) return { error: exclusionError };
  const swallowed = matchAll ? null : keywordSwallowedBy(keywords, exclusions, matchMode);
  if (swallowed) {
    return {
      error: `The keyword “${swallowed.keyword}” could never get a message, because it contains the exclusion “${swallowed.exclusion}”. Remove one of them.`,
    };
  }
  if (!dm) return { error: 'Write the private message to send.' };
  const dmProblem = messageProblem('The private message', dm, DM_TEXT_MAX);
  if (dmProblem) return { error: dmProblem };
  for (const [i, reply] of replies.entries()) {
    const problem = reply ? messageProblem(i === 0 ? 'The public reply' : `Reply ${String(i + 1)}`, reply, PUBLIC_REPLY_MAX) : null;
    if (problem) return { error: problem };
  }
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
      keywords: JSON.stringify(matchAll ? [] : keywords),
      match_mode: matchMode,
      exclude_keywords: JSON.stringify(exclusions),
      match_all: matchAll ? 1 : 0,
      media_id: media || null,
      dm_text: dm,
      public_reply_text: serializePublicReplies(replies),
    },
  };
}

adminRoutes.post('/rules', async (c) => {
  const fields = readRuleFields(formOf(c));
  const base = c.get('adminBase');
  if ('error' in fields) {
    const accounts = await listAccounts(c.env.DB);
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
          values: formValuesFromPost(formOf(c)),
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
        values: formValuesFromRule(rule),
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
          values: formValuesFromPost(formOf(c)),
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

adminRoutes.get('/rules/:id/delete', async (c) => {
  const rule = await getRule(c.env.DB, Number(c.req.param('id')));
  if (!rule) return c.notFound();
  const base = c.get('adminBase');
  const session = c.get('session');
  const account = await getAccount(c.env.DB, rule.ig_user_id);
  return c.html(
    layout({
      title: 'Delete rule',
      base,
      csrf: session.csrf,
      body: html`
        <h1>Delete this rule?</h1>
        <div class="table-wrap"><table>
          <tr><th>Name</th><td>${rule.label}</td></tr>
          <tr><th>Account</th><td>@${account?.username ?? rule.ig_user_id}</td></tr>
          <tr>
            <th>Keywords</th>
            <td>${rule.match_all === 1 ? EVERY_COMMENT_WORDS : parseKeywords(rule.keywords).join(', ')}</td>
          </tr>
        </table></div>
        <p>
          Matching comments will stop getting a private message. This cannot be undone. To stop it for now
          and keep it, pause it instead.
        </p>
        <form method="post" action="${base}/rules/${String(rule.id)}/delete">
          ${csrfField(session.csrf)}
          <div class="row">
            <button class="danger" type="submit">Delete rule</button>
            <a class="btn secondary" href="${base}/rules">Keep it</a>
          </div>
        </form>
      `,
    }),
  );
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
                <p class="muted">
                  Leave on all posts unless you limited a rule to one reel. A rule that replies to every comment
                  only shows up when you pick its post here.
                </p>
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
  const { match, excluded } = await chooseRule(c.env.DB, ig, text, media);
  const base = c.get('adminBase');
  // Shown either way: when a test does not match, the cleaned-up text is
  // usually the explanation (the hashtag symbol is gone, the accent folded).
  const readAs = html`<tr><th>Comment, as matched</th><td>${normalizeCommentText(text) || '(nothing left)'}</td></tr>`;
  const exclusions = excluded.length
    ? html`
        <h2>${match ? 'Passed over first' : 'Skipped because of an exclusion'}</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Rule</th><th>Keyword found</th><th>Exclusion found</th></tr></thead>
          <tbody>
            ${excluded.map(
              (e) =>
                html`<tr><td>${e.rule.label}</td><td>${e.keyword ?? EVERY_COMMENT_WORDS}</td><td>${e.exclusion}</td></tr>`,
            )}
          </tbody>
        </table></div>
        ${match
          ? html`<p class="muted">An exclusion only stops its own rule, so the next matching rule replies instead.</p>`
          : html``}
      `
    : html``;
  const replies = parsePublicReplies(match?.rule.public_reply_text);
  const usesName = match ? countUsernameTokens([match.rule.dm_text, ...replies].join('\n')) > 0 : false;
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
                This would match the rule <b>${match.rule.label}</b>.
              </div>
              <div class="table-wrap"><table>
                ${match.keyword === null
                  ? html`<tr><th>Matched because</th><td>This rule replies to every comment on this post.</td></tr>`
                  : html`
                      <tr><th>Keyword found</th><td>${match.keyword}</td></tr>
                      <tr><th>Matching</th><td>${MATCH_MODE_WORDS[match.rule.match_mode]}</td></tr>
                    `}
                ${readAs}
              </table></div>
              ${usesName
                ? html`<p class="muted">
                    <code>{username}</code> is filled in with <b>${SAMPLE_USERNAME}</b>, a sample name. Real
                    messages use the name of whoever commented.
                  </p>`
                : html``}
              <h2>Private message that would be sent</h2>
              <p class="message">${fillPlaceholders(match.rule.dm_text, SAMPLE_USERNAME)}</p>
              ${replies.length === 0
                ? html`<p class="muted">No public reply for this rule.</p>`
                : replies.length === 1
                  ? html`<h2>Public reply that would be posted</h2>
                      <p class="message">${fillPlaceholders(replies[0] ?? '', SAMPLE_USERNAME)}</p>`
                  : html`<h2>Public reply that would be posted</h2>
                      <p class="muted">One of these ${String(replies.length)}, picked at random for each comment:</p>
                      <ol>
                        ${replies.map((r) => html`<li class="message">${fillPlaceholders(r, SAMPLE_USERNAME)}</li>`)}
                      </ol>`}
              ${exclusions}
            `
          : excluded.length
            ? html`
                <p>
                  Nothing would be sent. This comment has a rule’s keyword, but also one of that rule’s
                  exclusions, so it would be skipped.
                </p>
                ${exclusions}
                <div class="table-wrap"><table>${readAs}</table></div>
              `
            : html`
                <p>No rule would match this comment. Nothing would be sent.</p>
                <div class="table-wrap"><table>${readAs}</table></div>
                <p class="muted">
                  Rules set to <b>${MATCH_MODE_WORDS.word}</b> skip keywords inside longer words and hashtags: “guide”
                  does not match “guides” or “#guide2026”. Paused rules are not tested, and a rule that replies to
                  every comment is only tested on its own post.
                </p>
              `}
        <p><a class="btn secondary" href="${base}/test">Test another</a></p>
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
              <div class="table-wrap"><table>
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
              </table></div>
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
