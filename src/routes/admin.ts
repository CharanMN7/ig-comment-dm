import { type Context, Hono } from 'hono';
import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
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
import { EMPTY_SNAPSHOT, STALE_PENDING_SECONDS, ensureCommentSubscriptions, runCron, snapshotTotals } from '../cron.ts';
import {
  HEALTH_FIRST_SEEN_KEY,
  NO_SENDS,
  type SendTotals,
  type Span,
  type TotalsSnapshot,
  addTotals,
  countSentByComment,
  countSentUpTo,
  deleteRule,
  extraRepliesFor,
  getAccount,
  getRule,
  getSent,
  healthSnapshot,
  insertRule,
  latestSignedWebhookStatuses,
  listAccounts,
  listRules,
  purgeAccount,
  readTotalsSnapshot,
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
import { type Section, csrfField, daysUntil, fmtWhen, layout, pageError, plural, statusWords } from '../html.ts';
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
import { EXTRA_PUBLIC_REPLY_CAP, otherRuleSkipReason, planOtherRules } from '../other-replies.ts';
import { chooseRule } from '../process.ts';
import { parsePublicReplies, serializePublicReplies } from '../replies.ts';
import { CRON_FIRST_RUN_SECONDS, jobState } from './health.ts';
import {
  type SessionBinding,
  clearSessionCookie,
  endAllSessions,
  makeSession,
  readSession,
  readSessionBinding,
  serializeSessionCookie,
} from '../session.ts';
import { LINK_MARKER, TEMPLATES, findTemplate, placeholderLinkIn, type RuleTemplate } from '../templates.ts';
import { clearFailures, describeLock, lockRemaining, readThrottle, reserveAttempt } from '../throttle.ts';
import type { Env, ExtraReply, MatchMode, Rule, SessionData } from '../types.ts';

type Vars = {
  adminBase: string;
  binding: SessionBinding;
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

  const { binding, hasPassword } = await readSessionBinding(c.env.DB);
  c.set('binding', binding);
  let session = await readSession(c.env.SESSION_SIGNING_KEY, binding, c.req.header('Cookie'));
  const path = subPath(pathname);
  const isSetup = path === '/setup';
  const isLogin = path === '/login';

  if (!session && c.req.method === 'GET') {
    const made = await makeSession(c.env.SESSION_SIGNING_KEY, binding, false);
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

type AdminContext = Context<{ Bindings: Env; Variables: Vars }>;

/**
 * What a page says after one of its forms posts and redirects back. Only the
 * code travels in the URL, so a crafted link can show one of these lines and
 * nothing else.
 */
const DONE = new Map<string, (base: string) => HtmlEscapedString | Promise<HtmlEscapedString>>([
  ['rule-saved', (base) => html`Rule saved. <a href="${base}/test">Try it with a sample comment</a>.`],
  ['rule-paused', () => html`Rule paused. It won’t reply to anyone until you resume it.`],
  ['rule-resumed', () => html`Rule resumed. It replies to new comments again.`],
  ['rule-deleted', () => html`Rule deleted.`],
  ['account-paused', () => html`Account paused. None of its rules reply until you resume it.`],
  ['account-resumed', () => html`Account resumed. Its rules reply to new comments again.`],
  ['checked', () => html`Connections checked. Anything that needs you is listed at the top.`],
]);

function redirectDone(c: AdminContext, path: string, done: string) {
  return c.redirect(`${c.get('adminBase')}${path}?done=${done}`, 302);
}

function doneNote(c: AdminContext) {
  const message = DONE.get(c.req.query('done') ?? '');
  return message ? html`<div class="ok" role="status">${message(c.get('adminBase'))}</div>` : html``;
}

/** A 404 inside the panel, with the nav and a way back, for someone already logged in. */
function notFoundPage(c: AdminContext, opts: { section?: Section; message: string; back: string; backLabel: string }) {
  const base = c.get('adminBase');
  return c.html(
    layout({
      title: 'Not found',
      base,
      section: opts.section,
      csrf: c.get('session').csrf,
      body: html`
        <h1>Not found</h1>
        <p>${opts.message}</p>
        <p><a class="btn secondary" href="${base}${opts.back}">${opts.backLabel}</a></p>
      `,
    }),
    404,
  );
}

function ruleNotFound(c: AdminContext) {
  return notFoundPage(c, {
    section: 'rules',
    message: 'That rule doesn’t exist. It may have been deleted.',
    back: '/rules',
    backLabel: 'Back to rules',
  });
}

function setupPage(opts: { base: string; csrf: string; error?: string }) {
  return layout({
    title: 'Create password',
    app: opts.base,
    body: html`
      <h1>Create your password</h1>
      ${opts.error ? html`<p class="err" role="alert">${opts.error}</p>` : html``}
      <p>This page is only shown once. Pick a password you will remember — there is no email reset.</p>
      <form method="post" action="${opts.base}/setup">
        ${csrfField(opts.csrf)}
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required minlength="8" autocomplete="new-password" />
        <p class="muted">At least 8 characters.</p>
        <label for="confirm">Type it again</label>
        <input id="confirm" name="confirm" type="password" required minlength="8" autocomplete="new-password" />
        <div class="row"><button type="submit">Save password</button></div>
      </form>
    `,
  });
}

adminRoutes.get('/setup', async (c) => {
  if (await passwordConfigured(c.env)) return c.redirect(`${c.get('adminBase')}/login`, 302);
  return c.html(setupPage({ base: c.get('adminBase'), csrf: c.get('session').csrf }));
});

adminRoutes.post('/setup', async (c) => {
  if (await passwordConfigured(c.env)) return c.redirect(`${c.get('adminBase')}/login`, 302);
  const form = formOf(c);
  const password = form.password ?? '';
  const confirm = form.confirm ?? '';
  const base = c.get('adminBase');
  const problem =
    password.length < 8 ? 'Use at least 8 characters.' : password !== confirm ? 'Those two passwords did not match.' : null;
  if (problem) return c.html(setupPage({ base, csrf: c.get('session').csrf, error: problem }), 400);
  try {
    const { hash, salt } = await hashPassword(password);
    await systemSet(c.env.DB, 'admin_password_hash', hash);
    await systemSet(c.env.DB, 'admin_password_salt', salt);

    const made = await makeSession(c.env.SESSION_SIGNING_KEY, { ...c.get('binding'), salt }, true);
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

function loginPage(opts: { base: string; csrf: string; error?: string; lockedFor?: number; loggedOut?: boolean }) {
  return layout({
    title: 'Log in',
    app: opts.base,
    body: html`
      ${opts.loggedOut ? html`<div class="ok" role="status">Logged out on every browser and device.</div>` : html``}
      <h1>Log in</h1>
      ${opts.error ? html`<p class="err" role="alert">${opts.error}</p>` : html``}
      ${opts.lockedFor
        ? html`<p class="muted">
              Too many wrong passwords. Logging in is paused for ${describeLock(opts.lockedFor)}
              on every browser, not just this one. A wrong password after that doubles the wait,
              up to an hour.
            </p>
            <p class="muted">
              Weren’t those yours? Then someone else has this page’s address. Whoever set this up can
              give it a new one by changing <code>ADMIN_URL_SECRET</code>.
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
      loggedOut: c.req.query('out') === '1',
    }),
  );
});

adminRoutes.post('/login', async (c) => {
  const base = c.get('adminBase');
  const csrf = c.get('session').csrf;

  // Claim the attempt before hashing. PBKDF2 is the most expensive thing this
  // Worker does, so answering a locked-out attempt without running it also
  // stops the login form being used to burn CPU quota.
  //
  // The lock covers the whole panel, not one browser or IP. A per-IP lock is
  // dodged by anyone with more addresses, and a per-browser one by dropping
  // the cookie. Its cost is that a guesser locks the operator out too, but
  // only someone holding the secret URL can reach this form, and changing
  // ADMIN_URL_SECRET shuts them out for good.
  const attempt = await reserveAttempt(c.env.DB, nowSeconds());
  if (!attempt.allowed) {
    return c.html(loginPage({ base, csrf, lockedFor: attempt.lock }), 429);
  }

  const password = formOf(c).password ?? '';
  const hash = await systemGet(c.env.DB, 'admin_password_hash');
  const salt = await systemGet(c.env.DB, 'admin_password_salt');
  const ok = hash && salt ? await verifyPassword(password, hash, salt) : false;

  if (!ok) {
    return c.html(
      loginPage({
        base,
        csrf,
        error: 'Wrong password.',
        lockedFor: attempt.lock || undefined,
      }),
      401,
    );
  }

  await clearFailures(c.env.DB);
  const made = await makeSession(c.env.SESSION_SIGNING_KEY, c.get('binding'), true);
  c.header('Set-Cookie', serializeSessionCookie(made.token, c.env.PUBLIC_BASE_URL, 30 * 24 * 60 * 60));
  return c.redirect(`${base}/`, 302);
});

// Logout ends every session, not just this browser's: a stateless cookie
// can't be revoked on its own, and a copy of it would otherwise outlive this.
adminRoutes.post('/logout', async (c) => {
  await endAllSessions(c.env.DB);
  c.header('Set-Cookie', clearSessionCookie(c.env.PUBLIC_BASE_URL));
  return c.redirect(`${c.get('adminBase')}/login?out=1`, 302);
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
  return TOTAL_WINDOWS.flatMap((w) => (w.days == null ? [] : [today - (w.days - 1) * DAY]));
}

// With no snapshot yet and at most this many rows, Home counts all time live.
// That reads fewer rows than the 30-day window does on a busy account, and
// spares a page view the sweep and the write.
const LIVE_TOTALS_MAX_ROWS = 1_000;

// The daily job keeps the snapshot under about 24 hours old. Past this it has
// missed a run, and Home would read every row since, so it catches up itself.
const SNAPSHOT_MAX_AGE = 2 * DAY;

/**
 * The snapshot Home adds its live counts to. Without one, a small table is
 * counted whole, and a large one, an upgrade before its first nightly run,
 * gets its snapshot now, so the full read happens once rather than per visit.
 */
async function totalsBase(db: D1Database, now: number): Promise<TotalsSnapshot> {
  const stored = await readTotalsSnapshot(db);
  if (stored && now - stored.cutoff <= SNAPSHOT_MAX_AGE) return stored;
  if (!stored && (await countSentUpTo(db, LIVE_TOTALS_MAX_ROWS + 1)) <= LIVE_TOTALS_MAX_ROWS) return EMPTY_SNAPSHOT;
  try {
    return await snapshotTotals(db, now);
  } catch (err) {
    // Counting live from the old snapshot, or from nothing, is slower but still right.
    console.error('snapshot send totals failed', err instanceof Error ? err.message : err);
    return stored ?? EMPTY_SNAPSHOT;
  }
}

/**
 * Each window in TOTAL_WINDOWS order. All time is the snapshot plus the rows
 * since its cutoff, which are a range read like the other windows.
 */
async function homeTotals(
  db: D1Database,
  now: number,
  perAccount: boolean,
): Promise<{ all: SendTotals[]; byAccount: Map<string, SendTotals[]> | null }> {
  const base = await totalsBase(db, now);
  const spans: Span[] = [...windowStarts(now).map((from) => ({ from })), { from: base.cutoff, firstReach: true }];
  const withBase = (live: SendTotals[], snapshot: SendTotals): SendTotals[] =>
    spans.map((_, i) => {
      const t = live[i] ?? NO_SENDS;
      return i === spans.length - 1 ? addTotals(snapshot, t) : t;
    });
  const all = withBase(await sendTotals(db, spans), base.all);
  if (!perAccount) return { all, byAccount: null };
  const live = await sendTotalsByAccount(db, spans);
  const ids = new Set([...live.keys(), ...Object.keys(base.accounts)]);
  const byAccount = new Map([...ids].map((id) => [id, withBase(live.get(id) ?? [], base.accounts[id] ?? NO_SENDS)]));
  return { all, byAccount };
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
          ${plural(t.reached, 'person', 'people')} reached
          <div class="muted">
            ${fmtCount(t.sent)} ${plural(t.sent, 'DM', 'DMs')} sent<br />${fmtCount(t.skipped)} skipped<br />
            ${t.failed ? html`<span class="err">${failed}</span>` : failed}
          </div>
        </div>`;
      })}
    </div>
  `;
}

function extraReplyLine(e: ExtraReply & { rule_label: string | null }, now: number) {
  const rule = html`Also matched <b>${e.rule_label ?? 'a deleted rule'}</b>:`;
  if (e.status === 'ok') return html`<div class="muted">${rule} public reply posted.</div>`;
  if (e.status === 'failed') {
    return html`<div class="muted">${rule} <span class="err">public reply failed.</span></div>
      <div class="muted detail">${e.error ?? ''}</div>`;
  }
  if (e.status === 'queued') return html`<div class="muted">${rule} public reply waits for the DM.</div>`;
  if (e.status === 'pending') {
    // Never retried, like a stuck DM, so after the same wait it is reported the same way.
    return now - e.sent_at > STALE_PENDING_SECONDS
      ? html`<div class="muted">${rule} the Worker stopped before its public reply finished, so it was not tried again.</div>`
      : html`<div class="muted">${rule} public reply still sending.</div>`;
  }
  return html`<div class="muted">${rule} ${e.error ?? 'public reply not posted'}.</div>`;
}

/** Until the first DM goes out, Home leads with the three steps that get there. */
function gettingStarted(base: string, accounts: { username: string }[], ruleCount: number, anySent: boolean) {
  const done = html`<b>Done:</b>`;
  return html`
    <h2>Get started</h2>
    <ol class="steps">
      <li>
        ${accounts.length
          ? html`${done} connected ${accounts.map((a) => `@${a.username}`).join(', ')}.`
          : html`<a href="/connect">Connect your Instagram account</a>. It takes about 20 seconds.`}
      </li>
      <li>
        ${ruleCount
          ? html`${done} ${ruleCount === 1 ? 'one rule' : `${String(ruleCount)} rules`} written.`
          : html`<a href="${base}/rules">Write your first rule</a>, or start from a template.`}
      </li>
      <li>
        ${anySent
          ? html`${done} your first DM went out.`
          : html`<a href="${base}/test">Test your rule</a> with a sample comment. Then ask a friend to comment
              from their own account: their DM shows up under Last 20 sends.`}
      </li>
    </ol>
  `;
}

// Wrong signatures are logged at most once a minute, so this many in a row
// spans minutes with nothing getting through: Meta retrying with a secret we
// don't have. A few forged requests, or a burst of them, can't add up to it.
const WRONG_SECRET_AFTER = 3;

adminRoutes.on('GET', ['/', ''], async (c) => {
  const base = c.get('adminBase');
  const session = c.get('session');
  const now = nowSeconds();
  const accounts = await listAccounts(c.env.DB);
  c.executionCtx.waitUntil(ensureCommentSubscriptions(c.env));
  const sends = await recentSent(c.env.DB, 20);
  const extras = new Map<string, Awaited<ReturnType<typeof extraRepliesFor>>>();
  for (const e of await extraRepliesFor(c.env.DB, sends.map((s) => s.comment_id))) {
    extras.set(e.comment_id, [...(extras.get(e.comment_id) ?? []), e]);
  }
  let events: Awaited<ReturnType<typeof recentWebhookEvents>> = [];
  let latestSigned: string[] = [];
  try {
    events = await recentWebhookEvents(c.env.DB, 8);
    latestSigned = await latestSignedWebhookStatuses(c.env.DB, WRONG_SECRET_AFTER);
  } catch {
    events = [];
  }
  // With one account the breakdown would repeat the totals, so skip its query.
  const { all: totals, byAccount } = await homeTotals(c.env.DB, now, accounts.length > 1);
  const health = await healthSnapshot(c.env.DB, now);
  // Shares /health's clock, so a deploy nobody monitors still gets its grace
  // period from the first time the operator opens Home.
  if (health.firstSeenAt == null) await systemSet(c.env.DB, HEALTH_FIRST_SEEN_KEY, String(now));
  const cron = jobState(health.lastCronOkAt, CRON_STALE_SECONDS, CRON_FIRST_RUN_SECONDS, health.firstSeenAt ?? now, now);
  const reconnect = accounts.filter((a) => a.needs_reconnect === 1 || a.token_expires_at <= now);
  const configProblems = findConfigProblems(c.env);
  const anySent = (totals.at(-1)?.sent ?? 0) > 0;
  // Gone for good once a DM has gone out, which also spares Home the rules query.
  const steps = anySent && accounts.length ? html`` : gettingStarted(base, accounts, (await listRules(c.env.DB)).length, anySent);

  const banners = [];
  if (reconnect.length) {
    const names = reconnect.map((a) => `@${a.username}`).join(', ');
    banners.push(html`
      <div class="banner">
        Instagram needs reconnecting${accounts.length === 1 ? '' : ` for ${names}`}.
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
  if (latestSigned.length === WRONG_SECRET_AFTER && latestSigned.every((s) => s === 'bad_sig')) {
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
      section: 'home',
      csrf: c.get('session').csrf,
      body: html`
        ${doneNote(c)}
        ${banners}
        <h1>Home</h1>
        ${steps}
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
                    let token = days < 0 ? 'Expired' : `${days} ${plural(days, 'day', 'days')} left`;
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
                          ? html`<div class="muted">Public reply not posted, because Instagram didn’t confirm the DM.</div>`
                          : html``}
                        ${(extras.get(s.comment_id) ?? []).map((e) => extraReplyLine(e, now))}
                      </td>
                    </tr>`,
                  )}
                </tbody>
              </table></div>
            `}

        <h2>Did Instagram reach us?</h2>
        ${events.length === 0
          ? health.lastWebhookAt != null
            ? html`<p class="muted">
                Nothing in the last 7 days. The last notification reached us on ${fmtWhen(health.lastWebhookAt)}.
                That is normal if nobody has commented since. If someone has, check that the app is still
                Live and that Webhook subscription is still on for the account.
              </p>`
            : html`<p class="muted">
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
  return redirectDone(c, '/', 'checked');
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
  reply_without_dm: boolean;
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
    reply_without_dm: rule.reply_without_dm === 1,
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
    reply_without_dm: f.reply_without_dm === '1',
    media_id: f.media_id ?? '',
    dm_text: f.dm_text ?? '',
    public_replies: replyFields(f),
  };
}

function formValuesFromTemplate(t: RuleTemplate, igUserId: string): RuleFormValues {
  return {
    ig_user_id: igUserId,
    label: t.name,
    keywords: t.keywords.join('\n'),
    match_mode: 'word',
    exclude_keywords: t.exclusions.join('\n'),
    match_all: t.matchAll,
    // Every template's replies mention the DM, which another rule's DM would make false.
    reply_without_dm: false,
    media_id: '',
    dm_text: t.dm,
    public_replies: [...t.publicReplies],
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
  // Folded away on a new rule, but a rule already using one of these opens
  // with it showing, so nobody edits a rule without seeing how it matches.
  const fineTuned = contains || v.exclude_keywords.trim() !== '' || v.reply_without_dm;
  return html`
    ${opts.error ? html`<p class="err" role="alert">${opts.error}</p>` : html``}
    <form class="rule-form" method="post" action="${opts.action}">
      ${csrfField(opts.csrf)}
      <label for="label">Rule name</label>
      <input id="label" name="label" type="text" required value="${v.label}" placeholder="Free guide" />
      <p class="muted">Only you see this. It helps you tell your rules apart.</p>

      <fieldset class="group">
        <legend>When someone comments</legend>
        <div class="when-keywords">
          <label for="keywords">Keywords</label>
          <textarea id="keywords" name="keywords" placeholder="guide&#10;freebie">${v.keywords}</textarea>
          <p class="muted">
            One per line. A comment with any of these gets your message. Capitals, accents, emoji and
            punctuation don’t matter, so “GUIDE!!” counts as “guide”. Each keyword needs at least 3 letters,
            or 2 in Chinese and Japanese.
          </p>
        </div>
        <label class="choice">
          <input type="checkbox" id="match_all" name="match_all" value="1" ${v.match_all ? 'checked' : ''} />
          <span>
            <b>Reply to every comment on this post</b>
            <span class="muted">
              Instead of keywords, for giveaways and waitlists: everyone who comments gets the message. Each
              comment gets its own message, so someone who comments three times gets it three times.
            </span>
          </span>
        </label>
        <p class="err needs-post">
          Pick one post under “Which posts” below. This can’t be used on all posts: it would message
          everyone who comments on anything, and Instagram may restrict the account.
        </p>
        <p class="muted when-all">
          Older posts: every 5 minutes a check also reads the post’s 25 newest comments from the last 3 days,
          and any it hasn’t handled before get the message too, up to 10 messages per check. Comments it
          already skipped stay skipped.
        </p>
        <details class="matching" ${fineTuned ? 'open' : ''}>
          <summary>Exclusions and matching (optional)</summary>
          <fieldset class="choices when-keywords">
            <legend>How to look for keywords</legend>
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
          <label for="exclude_keywords">Exclusions</label>
          <textarea id="exclude_keywords" name="exclude_keywords" placeholder="how much&#10;already have it&#10;not interested">${v.exclude_keywords}</textarea>
          <p class="muted">
            Skip comments that contain any of these, even when a keyword matches. One per line. Useful for
            “how much is the guide?” or “I already have the guide”, which mention your keyword but don’t want
            the message. They are found the same way as your keywords. Another rule without these exclusions
            can still reply.
          </p>
          <p class="muted when-all">On a rule that replies to every comment, exclusions are found as whole words.</p>
          <label class="choice">
            <input type="checkbox" id="reply_without_dm" name="reply_without_dm" value="1" ${v.reply_without_dm ? 'checked' : ''} />
            <span>
              <b>Also post this public reply when another rule sends the DM</b>
              <span class="muted">Only tick this if the reply doesn’t mention a DM.</span>
            </span>
          </label>
        </details>
      </fieldset>

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
          Leave this on <b>All posts and reels</b> unless the rule is for one post. If the list is empty, leave
          it as it is: that still covers every post.
        </p>
        <p class="muted when-all">Pick the one post whose commenters should all get the message.</p>
      </fieldset>

      <fieldset class="group">
        <legend>What to send</legend>
        <label for="dm_text">DM</label>
        <textarea id="dm_text" name="dm_text" required maxlength="${String(DM_TEXT_MAX)}">${v.dm_text}</textarea>
        <p class="muted">
          Up to 1,000 characters. Instagram allows one DM per comment, so put everything they
          need in this one, link included.
          <code>{username}</code> puts in their Instagram name and counts as 30. It’s the only placeholder for now.
        </p>
        <label for="public_reply_text">Public reply under their comment (optional)</label>
        <textarea id="public_reply_text" name="public_reply_text" maxlength="${String(PUBLIC_REPLY_MAX)}">${mainReply}</textarea>
        <p class="muted">
          Everyone reading the comments sees this, for example “Sent you a DM!”. Leave it blank to send
          only the DM. If the DM fails, the public reply is not posted either. Up to 1,000 characters, and
          <code>{username}</code> works here too.
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

      <div class="row">
        <button type="submit">Save rule</button>
        <a class="btn secondary" href="${opts.base}/rules">Cancel</a>
      </div>
    </form>
  `;
}

function templateGallery(base: string) {
  return html`
    <h2 id="templates">Start from a template</h2>
    <p class="muted">Each one fills in the new-rule form with keywords and a message, ready for you to change.</p>
    <ul class="templates">
      ${TEMPLATES.map(
        (t) => html`<li>
          <a href="${base}/rules/new?template=${t.id}"><b>${t.name}</b><span class="muted">${t.forWhom}</span></a>
        </li>`,
      )}
    </ul>
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
      section: 'rules',
      csrf: c.get('session').csrf,
      body: html`
        ${doneNote(c)}
        <h1>Rules</h1>
        <p class="muted">When a comment matches a keyword, we send that person one DM.</p>
        <div class="row">
          <a class="btn" href="${base}/rules/new">New rule</a>
          ${rules.length ? html`<a class="btn secondary" href="#templates">Start from a template</a>` : html``}
        </div>
        ${rules.length === 0
          ? html`<p>No rules yet. Start from a template below, or press New rule for a blank form.</p>`
          : html`
              <div class="table-wrap"><table>
                <thead>
                  <tr>
                    <th>Name</th>
                    ${showAccount ? html`<th>Account</th>` : html``}
                    <th>Keywords</th>
                    <th>Status</th>
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
                      <td>${r.active ? 'On' : 'Paused'}</td>
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
        ${templateGallery(base)}
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
        section: 'rules',
        csrf: c.get('session').csrf,
        body: html`<h1>New rule</h1><p>Connect an Instagram account first on the <a href="${base}/accounts">Accounts</a> page.</p>`,
      }),
    );
  }
  const igUserId = accounts[0]!.ig_user_id;
  const template = findTemplate(c.req.query('template'));
  const intro = template
    ? html`<div class="note">
        <p>Filled in from <b>${template.name}</b>. Nothing is saved until you press Save rule.</p>
        <p>Replace <code>${LINK_MARKER}</code> with your own link.</p>
        ${template.note ? html`<p>${template.note}</p>` : html``}
        <p><a href="${base}/rules#templates">Pick a different template</a></p>
      </div>`
    : html`<p class="muted">
        Or <a href="${base}/rules#templates">start from a template</a>, with keywords and a message already written.
      </p>`;
  return c.html(
    layout({
      title: 'New rule',
      base,
      section: 'rules',
      csrf: c.get('session').csrf,
      body: html`<h1>New rule</h1>${intro}${ruleForm({
        base,
        csrf: c.get('session').csrf,
        accounts,
        action: `${base}/rules`,
        values: template ? formValuesFromTemplate(template, igUserId) : { ...formValuesFromPost({}), ig_user_id: igUserId },
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

/**
 * Templates put LINK_MARKER where the creator's link goes. That, or a sample
 * address like example.com, would reach real followers as typed, so neither
 * can be saved.
 */
function placeholderLinkProblem(what: string, text: string): string | null {
  const found = placeholderLinkIn(text);
  if (!found) return null;
  if (found === LINK_MARKER) {
    return `${what} still says ${LINK_MARKER}. Replace it with your own link, or delete it, before saving.`;
  }
  return `${what} links to “${found}”, a sample address that isn’t yours. Replace it with your own link before saving.`;
}

export const MATCH_ALL_NEEDS_POST_MESSAGE =
  '“Reply to every comment” needs one post. Pick it under “Which posts”, or untick the box. On all posts it would message everyone who comments on anything, and Instagram may restrict the account.';

export const UNKNOWN_ACCOUNT_MESSAGE = 'Pick an Instagram account from the list. The one this form sent isn’t connected here.';

/**
 * Exported for the unit tests. CSS can hide a field but cannot stop a form
 * being posted, so this, not the form, is what keeps a match-all rule off
 * "All posts", and a rule off an account that isn't connected, which the
 * database would otherwise refuse with an error page.
 */
export function readRuleFields(form: Record<string, string>, accounts: readonly { ig_user_id: string }[]) {
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
  const replyWithoutDm = form.reply_without_dm === '1';
  if (!label) return { error: 'Give this rule a name.' };
  if (!ig) return { error: 'Pick an Instagram account.' };
  if (!accounts.some((a) => a.ig_user_id === ig)) return { error: UNKNOWN_ACCOUNT_MESSAGE };
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
  if (!dm) return { error: 'Write the DM to send.' };
  const dmProblem =
    messageProblem('The DM', dm, DM_TEXT_MAX) ?? placeholderLinkProblem('The DM', dm);
  if (dmProblem) return { error: dmProblem };
  for (const [i, reply] of replies.entries()) {
    const what = i === 0 ? 'The public reply' : `Reply ${String(i + 1)}`;
    const problem = reply ? (messageProblem(what, reply, PUBLIC_REPLY_MAX) ?? placeholderLinkProblem(what, reply)) : null;
    if (problem) return { error: problem };
  }
  if (media && looksLikePostUrl(media)) {
    return {
      error:
        'That looks like a link, not a post ID. Leave “Which posts” on All posts and reels, or pick a post from the list.',
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
      reply_without_dm: replyWithoutDm ? 1 : 0,
      media_id: media || null,
      dm_text: dm,
      public_reply_text: serializePublicReplies(replies),
    },
  };
}

adminRoutes.post('/rules', async (c) => {
  const accounts = await listAccounts(c.env.DB);
  const fields = readRuleFields(formOf(c), accounts);
  const base = c.get('adminBase');
  if ('error' in fields) {
    return c.html(
      layout({
        title: 'New rule',
        base,
        section: 'rules',
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
  return redirectDone(c, '/rules', 'rule-saved');
});

adminRoutes.get('/rules/:id/edit', async (c) => {
  const id = Number(c.req.param('id'));
  const rule = await getRule(c.env.DB, id);
  const base = c.get('adminBase');
  if (!rule) return ruleNotFound(c);
  const accounts = await listAccounts(c.env.DB);
  return c.html(
    layout({
      title: 'Edit rule',
      base,
      section: 'rules',
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
  if (!existing) return ruleNotFound(c);
  const accounts = await listAccounts(c.env.DB);
  const fields = readRuleFields(formOf(c), accounts);
  const base = c.get('adminBase');
  if ('error' in fields) {
    return c.html(
      layout({
        title: 'Edit rule',
        base,
        section: 'rules',
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
  return redirectDone(c, '/rules', 'rule-saved');
});

adminRoutes.post('/rules/:id/toggle', async (c) => {
  const id = Number(c.req.param('id'));
  await toggleRule(c.env.DB, id);
  const rule = await getRule(c.env.DB, id);
  if (!rule) return c.redirect(`${c.get('adminBase')}/rules`, 302);
  return redirectDone(c, '/rules', rule.active ? 'rule-resumed' : 'rule-paused');
});

adminRoutes.get('/rules/:id/delete', async (c) => {
  const rule = await getRule(c.env.DB, Number(c.req.param('id')));
  if (!rule) return ruleNotFound(c);
  const base = c.get('adminBase');
  const session = c.get('session');
  const account = await getAccount(c.env.DB, rule.ig_user_id);
  return c.html(
    layout({
      title: 'Delete rule',
      base,
      section: 'rules',
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
          Matching comments will stop getting a DM. This cannot be undone. To stop it for now
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
  return redirectDone(c, '/rules', 'rule-deleted');
});

adminRoutes.get('/test', async (c) => {
  const accounts = await listAccounts(c.env.DB);
  const base = c.get('adminBase');
  const posts = accounts.length ? await recentMediaOptions(c.env) : [];
  return c.html(
    layout({
      title: 'Test',
      base,
      section: 'test',
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
                  Leave on all posts unless you limited a rule to one post. A rule that replies to every comment
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
  const { match, also, excluded } = await chooseRule(c.env.DB, ig, text, media);
  const account = await getAccount(c.env.DB, ig);
  const base = c.get('adminBase');
  // Shown either way: when a test does not match, the cleaned-up text is
  // usually the explanation (the hashtag symbol is gone, the accent folded).
  const readAs = html`<tr><th>Comment, as matched</th><td>${normalizeCommentText(text) || '(nothing left)'}</td></tr>`;
  const exclusions = excluded.length
    ? html`
        <h2>${match ? 'Passed over because of an exclusion' : 'Skipped because of an exclusion'}</h2>
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
          ? html`<p class="muted">An exclusion only stops its own rule, so the other matching rules still reply.</p>`
          : html``}
      `
    : html``;
  const replies = parsePublicReplies(match?.rule.public_reply_text);
  const others = planOtherRules(also);
  const usesName = match
    ? countUsernameTokens([match.rule.dm_text, ...replies, ...others.flatMap((o) => (o.posts ? o.replies : []))].join('\n')) > 0
    : false;
  const sample = (reply: string) => fillPlaceholders(reply, SAMPLE_USERNAME);
  const otherRules = others.length
    ? html`
        <h2>Other matching rules</h2>
        <p class="muted">
          One comment gets one DM, from the rule above: Instagram allows one private reply per comment. Their
          DMs are not sent. A rule set to <b>Also post this public reply when another rule sends the DM</b>
          still posts its public reply, once the DM has gone through, up to ${String(EXTRA_PUBLIC_REPLY_CAP)}
          of them per comment.
        </p>
        <div class="table-wrap"><table>
          <thead><tr><th>Rule</th><th>Keyword found</th><th>Public reply</th></tr></thead>
          <tbody>
            ${others.map((o) => {
              const skip = otherRuleSkipReason(o);
              return html`<tr>
                <td>${o.rule.label}</td>
                <td>${o.keyword ?? EVERY_COMMENT_WORDS}</td>
                <td>
                  ${skip !== null
                    ? html`<span class="muted">Not posted: ${skip}.</span>`
                    : o.replies.length === 1
                      ? html`<span class="message">${sample(o.replies[0] ?? '')}</span>`
                      : html`One of these ${String(o.replies.length)}, at random:
                          <ol>${o.replies.map((r) => html`<li class="message">${sample(r)}</li>`)}</ol>`}
                </td>
              </tr>`;
            })}
          </tbody>
        </table></div>
      `
    : html``;
  return c.html(
    layout({
      title: 'Test',
      base,
      section: 'test',
      csrf: c.get('session').csrf,
      body: html`
        <h1>Test result</h1>
        ${match
          ? html`
              ${account && account.active !== 1
                ? html`<div class="note">
                    @${account.username} is paused, so this comment would get no reply. Once you
                    <a href="${base}/accounts">resume it</a>, it would match the rule <b>${match.rule.label}</b>.
                  </div>`
                : html`<div class="ok">This would match the rule <b>${match.rule.label}</b>.</div>`}
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
              <h2>DM that would be sent</h2>
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
              ${otherRules}
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
      section: 'accounts',
      csrf: c.get('session').csrf,
      body: html`
        ${doneNote(c)}
        <h1>Accounts</h1>
        <p>Connect the Instagram account you post from. You can connect more than one if they are all yours.</p>
        <p><a class="btn" href="/connect">Connect a new account</a></p>
        <details ${accounts.length ? '' : 'open'}>
          <summary>Addresses to save in Meta first</summary>
          <p class="muted">
            In Meta: Instagram → API setup with Instagram login → click <b>Set up</b> under
            “3. Set up Instagram business login”. Paste the first line as <b>Redirect URL</b>. Then
            Business login settings → OAuth redirect URIs (add both lines). Use the Instagram App ID
            from that same page, not the Facebook app id at the top of the dashboard.
          </p>
          <pre class="raw">${callback}
${callback}/</pre>
        </details>
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
                        ${a.active ? 'Watching comments' : 'Paused'}
                        · ${expired ? html`<span class="err">needs reconnect</span>` : `${days} ${plural(days, 'day', 'days')} left`}
                      </td>
                      <td class="actions">
                        <a class="btn${expired ? '' : ' secondary'}" href="/connect?reconnect=1">Reconnect</a>
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
  return redirectDone(c, '/accounts', 'account-paused');
});

adminRoutes.post('/accounts/:id/activate', async (c) => {
  await setAccountActive(c.env.DB, c.req.param('id'), 1);
  return redirectDone(c, '/accounts', 'account-resumed');
});

const SELFTEST_IG_USER = 'selftest_ig_user';

/** Unlisted. Used by scripts/selftest.ts against a deployed URL. */
adminRoutes.post('/selftest/seed', async (c) => {
  const now = nowSeconds();
  const enc = await encryptAesGcm(c.env.TOKEN_ENCRYPTION_KEY, 'selftest-dummy-token');
  await upsertAccount(c.env.DB, {
    ig_user_id: SELFTEST_IG_USER,
    username: 'selftest',
    access_token_enc: enc.ciphertext,
    token_iv: enc.iv,
    token_expires_at: now + 50 * 24 * 60 * 60,
    connected_at: now,
    last_refreshed_at: now,
  });
  // A comment no rule matches gets no row, so selftest's "hello there" needs
  // a rule that matches it. The exclusion skips it at once: a send would
  // call Instagram with the dummy token.
  if ((await listRules(c.env.DB, SELFTEST_IG_USER)).length === 0) {
    await insertRule(c.env.DB, {
      ig_user_id: SELFTEST_IG_USER,
      label: 'Selftest',
      keywords: JSON.stringify(['hello']),
      match_mode: 'word',
      exclude_keywords: JSON.stringify(['there']),
      match_all: 0,
      reply_without_dm: 0,
      media_id: null,
      dm_text: 'selftest',
      public_reply_text: null,
      created_at: now,
    });
  }
  return c.json({ ok: true, ig_user_id: SELFTEST_IG_USER });
});

/**
 * Unlisted. scripts/selftest.ts calls this when it's done, so a deployed
 * Worker isn't left with a fake account on Accounts, its sends in the totals,
 * or "Reached us" rows that look like Meta getting through when it wasn't.
 */
adminRoutes.post('/selftest/cleanup', async (c) => {
  await purgeAccount(c.env.DB, SELFTEST_IG_USER);
  return c.json({ ok: true });
});

adminRoutes.get('/selftest/status', async (c) => {
  const commentId = c.req.query('comment_id') ?? '';
  const lastCron = await systemGet(c.env.DB, 'last_cron_ok_at');
  const count = commentId ? await countSentByComment(c.env.DB, commentId) : 0;
  const row = commentId ? await getSent(c.env.DB, commentId) : null;
  return c.json({ last_cron_ok_at: lastCron, count, row });
});

// Last, so it only answers paths nothing above did. The login middleware has
// already run, so only a logged-in operator sees this; a wrong secret still
// gets the bare 404.
adminRoutes.get('*', (c) =>
  notFoundPage(c, { message: 'There’s no page at this address.', back: '/', backLabel: 'Go to Home' }),
);
