import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../../src/index.ts';
import type { Env } from '../../src/types.ts';
import { IG_USER, NOW } from './seed.ts';

export const ORIGIN = 'https://ig-comment-dm.example.workers.dev';

export type Reply = {
  status: number;
  headers: Headers;
  text: string;
  location: string | null;
  setCookies: string[];
};

/**
 * Calls the real Worker's fetch handler, then waits for everything it handed
 * to `waitUntil`. The webhook answers 200 before it processes anything, so
 * without the wait a test would race the very work it is checking.
 */
export async function request(
  path: string,
  init: RequestInit & { env?: Partial<Env> } = {},
): Promise<Reply> {
  const { env: overrides, ...rest } = init;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(new URL(path, ORIGIN), rest), overrides ? { ...env, ...overrides } : env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  return { status: res.status, headers: res.headers, text, location: res.headers.get('Location'), setCookies: res.headers.getSetCookie() };
}

export async function runScheduled(cron: string): Promise<void> {
  const ctx = createExecutionContext();
  const controller = createScheduledController({ cron, scheduledTime: Date.now() });
  // src/index.ts types the first parameter as ScheduledEvent, but workerd hands
  // module Workers a ScheduledController. The handler only reads `cron`, which
  // both have, so the cast mirrors what production actually receives.
  await worker.scheduled(controller as unknown as ScheduledEvent, env, ctx);
  await waitOnExecutionContext(ctx);
}

// --- Webhooks ----------------------------------------------------------------

// Signed here with crypto.subtle directly rather than with the Worker's own
// helper, so a bug in src/crypto.ts can't sign and verify its way to green.
export async function signature(body: string, secret: string = env.META_APP_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export async function postWebhook(
  payload: unknown,
  opts: { secret?: string; signature?: string | null; env?: Partial<Env> } = {},
): Promise<Reply> {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const sig = opts.signature === undefined ? await signature(body, opts.secret) : opts.signature;
  if (sig !== null) headers.set('X-Hub-Signature-256', sig);
  return request('/webhook', { method: 'POST', headers, body, env: opts.env });
}

export type CommentOpts = {
  commentId?: string;
  fromId?: string;
  /** `null` leaves the username off the payload, as Meta sometimes does. */
  username?: string | null;
  text?: string;
  mediaId?: string;
  igUserId?: string;
  time?: number;
};

export function commentValue(opts: CommentOpts = {}) {
  return {
    id: opts.commentId ?? '17900000000000001',
    text: opts.text ?? 'Guide please!',
    from: {
      id: opts.fromId ?? '9100000000000001',
      ...(opts.username === null ? {} : { username: opts.username ?? 'a_fan' }),
    },
    media: { id: opts.mediaId ?? '18000000000000777', media_product_type: 'REELS' },
  };
}

/** The `changes[]` shape Meta documents for Instagram comment webhooks. */
export function commentPayload(opts: CommentOpts = {}) {
  return {
    object: 'instagram',
    entry: [
      {
        id: opts.igUserId ?? IG_USER,
        time: opts.time ?? NOW,
        changes: [{ field: 'comments', value: commentValue(opts) }],
      },
    ],
  };
}

// --- Admin -------------------------------------------------------------------

export const ADMIN_PASSWORD = 'correct horse battery staple';

export function adminPath(sub = '/'): string {
  return `/a/${env.ADMIN_URL_SECRET}${sub}`;
}

export function csrfFrom(html: string): string {
  const m = html.match(/name="csrf" value="([^"]+)"/);
  if (!m) throw new Error('no csrf field on the page');
  return m[1]!;
}

/** A cookie jar and form poster, standing in for the operator's browser. */
export class Browser {
  #cookies = new Map<string, { value: string; strict: boolean }>();
  lastPage = '';

  get cookieHeader(): string {
    return this.#header(false);
  }

  cookie(name: string): string | undefined {
    return this.#cookies.get(name)?.value;
  }

  setCookie(name: string, value: string): void {
    this.#cookies.set(name, { value, strict: false });
  }

  /**
   * `crossSite` is a navigation another site started, such as Instagram
   * redirecting back after login. A real browser leaves SameSite=Strict
   * cookies off those, so the admin session cookie never arrives with them.
   */
  async get(path: string, opts: { crossSite?: boolean } = {}): Promise<Reply> {
    return this.#send(path, { method: 'GET' }, opts.crossSite ?? false);
  }

  async post(path: string, fields: Record<string, string>): Promise<Reply> {
    return this.#send(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  }

  /** Posts a form with the CSRF token from the page this browser last loaded. */
  async submit(path: string, fields: Record<string, string> = {}): Promise<Reply> {
    return this.post(path, { csrf: csrfFrom(this.lastPage), ...fields });
  }

  #header(crossSite: boolean): string {
    return [...this.#cookies]
      .filter(([, c]) => !(crossSite && c.strict))
      .map(([k, c]) => `${k}=${c.value}`)
      .join('; ');
  }

  async #send(path: string, init: RequestInit, crossSite = false): Promise<Reply> {
    const headers = new Headers(init.headers);
    const cookies = this.#header(crossSite);
    if (cookies) headers.set('Cookie', cookies);
    const reply = await request(path, { ...init, headers });
    for (const line of reply.setCookies) {
      const [pair] = line.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (/max-age=0/i.test(line) || value === '') this.#cookies.delete(name);
      else this.#cookies.set(name, { value, strict: /samesite=strict/i.test(line) });
    }
    if (reply.headers.get('Content-Type')?.includes('text/html')) this.lastPage = reply.text;
    return reply;
  }
}

/** Runs first-run password setup and returns a browser holding an authed session. */
export async function signedInAdmin(): Promise<Browser> {
  const browser = new Browser();
  await browser.get(adminPath('/setup'));
  const done = await browser.submit(adminPath('/setup'), { password: ADMIN_PASSWORD, confirm: ADMIN_PASSWORD });
  if (done.status !== 302) throw new Error(`setup failed with ${done.status}: ${done.text.slice(0, 200)}`);
  await browser.get(adminPath('/rules'));
  return browser;
}

// --- Connect -----------------------------------------------------------------

/** Starts Connect as `browser` and returns the state Instagram will echo back. */
export async function startConnect(browser: Browser, query = ''): Promise<string> {
  const res = await browser.get(`/connect/start${query}`);
  if (res.status !== 302) throw new Error(`/connect/start answered ${res.status}: ${res.text.slice(0, 200)}`);
  return new URL(res.location!).searchParams.get('state')!;
}

/** Instagram's redirect back to the callback, made by the browser that started Connect. */
export function returnFromInstagram(browser: Browser, query: Record<string, string>): Promise<Reply> {
  return browser.get(`/connect/callback?${new URLSearchParams(query)}`, { crossSite: true });
}
