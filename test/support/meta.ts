import { setupNetwork } from '@msw/cloudflare';
import { http } from 'msw';

/**
 * A stand-in for every Meta host the Worker talks to. It answers with the
 * response shapes Meta documents and records each request, so a test can say
 * exactly what the Worker sent: which endpoint, which token, which body.
 *
 * It is strict on purpose. A request to a Meta path with no route, or to any
 * other host, fails the test in `setup.ts`. If a change adds a new Meta call,
 * the tests should say so loudly rather than let it fall through to the real
 * network or to a vague default.
 */

export type MetaCall = {
  method: string;
  host: string;
  /** Pathname with the Graph version prefix removed, so bumping GRAPH_VERSION doesn't touch every assertion. */
  path: string;
  query: Record<string, string>;
  authorization: string | null;
  body: unknown;
  /** Date.now() when the request arrived; under fake timers the gaps between retries are the backoff delays. */
  at: number;
};

export type MetaReply = { status?: number; json: unknown } | { networkError: true };
type Responder = MetaReply | ((call: MetaCall) => MetaReply);
type Route = { method: string; pattern: RegExp; respond: Responder };

const META_HOSTS = ['graph.instagram.com', 'api.instagram.com', 'graph.facebook.com'];

export const FAKE_ME = { id: '9000000000000001', user_id: '17841400000000099', username: 'connected_creator' };
export const FAKE_EXPIRES_IN = 60 * 24 * 60 * 60;

function compile(path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[a-z_]+/gi, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

function defaultRoutes(): Route[] {
  const ok = (json: unknown): MetaReply => ({ json });
  return [
    { method: 'POST', pattern: compile('/:id/messages'), respond: ok({ recipient_id: '1234567890', message_id: 'm_fake' }) },
    { method: 'POST', pattern: compile('/:id/replies'), respond: ok({ id: '18000000000000001' }) },
    { method: 'POST', pattern: compile('/:id/subscribed_apps'), respond: ok({ success: true }) },
    { method: 'GET', pattern: compile('/me/media'), respond: ok({ data: [] }) },
    { method: 'GET', pattern: compile('/:id/comments'), respond: ok({ data: [] }) },
    { method: 'GET', pattern: compile('/me'), respond: ok(FAKE_ME) },
    {
      method: 'GET',
      pattern: compile('/refresh_access_token'),
      respond: ok({ access_token: 'refreshed-token', token_type: 'bearer', expires_in: FAKE_EXPIRES_IN }),
    },
    {
      method: 'GET',
      pattern: compile('/access_token'),
      respond: ok({ access_token: 'long-lived-token', token_type: 'bearer', expires_in: FAKE_EXPIRES_IN }),
    },
    {
      method: 'POST',
      pattern: compile('/oauth/access_token'),
      respond: ok({ data: [{ access_token: 'short-lived-token', user_id: FAKE_ME.user_id, permissions: 'instagram_business_basic' }] }),
    },
  ];
}

// MSW hands over its own Request type; only these members are read.
type Incoming = Pick<Request, 'url' | 'method' | 'headers' | 'text' | 'formData'>;

async function readBody(request: Incoming): Promise<unknown> {
  const type = request.headers.get('Content-Type') ?? '';
  if (request.method === 'GET' || request.method === 'HEAD') return null;
  if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) {
    const fields: Record<string, string> = {};
    for (const [k, v] of await request.formData()) fields[k] = typeof v === 'string' ? v : '[file]';
    return fields;
  }
  const text = await request.text();
  if (type.includes('json')) return JSON.parse(text) as unknown;
  return text === '' ? null : text;
}

class FakeMeta {
  calls: MetaCall[] = [];
  /** Requests to hosts that are not Meta. These would have hit the real network. */
  escaped: string[] = [];
  /** Requests to a Meta host that no route answers. */
  unrouted: string[] = [];
  #routes: Route[] = defaultRoutes();

  reset(): void {
    this.calls = [];
    this.escaped = [];
    this.unrouted = [];
    this.#routes = defaultRoutes();
  }

  /** Forgets calls made while arranging a test, without hiding any stray request. */
  clearCalls(): void {
    this.calls = [];
  }

  /** The newest matching route wins, so a test can override a default for one call path. */
  on(method: string, path: string, respond: Responder): void {
    this.#routes.unshift({ method, pattern: compile(path), respond });
  }

  callsTo(method: string, path: string): MetaCall[] {
    const pattern = compile(path);
    return this.calls.filter((c) => c.method === method && pattern.test(c.path));
  }

  async handle(request: Incoming): Promise<Response> {
    const url = new URL(request.url);
    const call: MetaCall = {
      method: request.method,
      host: url.host,
      path: url.pathname.replace(/^\/v\d+(\.\d+)?(?=\/)/, ''),
      query: Object.fromEntries(url.searchParams),
      authorization: request.headers.get('Authorization'),
      body: await readBody(request),
      at: Date.now(),
    };
    this.calls.push(call);
    const route = this.#routes.find((r) => r.method === call.method && r.pattern.test(call.path));
    if (!route) {
      this.unrouted.push(`${call.method} ${url.host}${url.pathname}`);
      return Response.json({ error: { message: 'FakeMeta has no route for this request', code: 0 } }, { status: 404 });
    }
    const reply = typeof route.respond === 'function' ? route.respond(call) : route.respond;
    if ('networkError' in reply) return Response.error();
    return Response.json(reply.json, { status: reply.status ?? 200 });
  }
}

export const meta = new FakeMeta();

export const network = setupNetwork();

network.configure({
  onUnhandledFrame: ({ frame }) => {
    const data = frame.data as { request?: Request } | undefined;
    meta.escaped.push(data?.request ? `${data.request.method} ${data.request.url}` : 'non-HTTP frame');
    // Throwing a network-error Response makes the Worker's fetch reject
    // instead of MSW quietly passing the request through to the internet.
    throw Response.error();
  },
});

export const metaHandlers = META_HOSTS.map((host) =>
  http.all(`https://${host}/*`, ({ request }) => meta.handle(request)),
);
