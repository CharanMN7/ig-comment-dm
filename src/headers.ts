import type { MiddlewareHandler } from 'hono';

/**
 * The admin panel's first factor is a secret in the URL path (`/a/<secret>`).
 * That makes `Referrer-Policy` load-bearing rather than decorative: without it,
 * every outbound link an operator clicks from an admin page hands the full
 * admin URL to a third-party server in the `Referer` header. The legal pages
 * and the Connect flow link out to Meta and Cloudflare, so this is a real path,
 * not a theoretical one.
 *
 * The CSP is unusually tight because it can be. This Worker ships zero
 * client-side JavaScript and fetches no fonts, so nearly everything can be
 * denied outright. `style-src 'unsafe-inline'` is there because the stylesheet
 * is inlined in `html.ts` to keep the app to one request. `manifest-src` and
 * `img-src` allow only this Worker, for installing the admin panel on a phone:
 * Chrome checks the manifest against the first and its icons against the
 * second, and without them drops both without saying so.
 */
const POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "manifest-src 'self'",
  "img-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();

  // Redirects to Instagram carry no markup and must keep their Location header
  // semantics; adding a CSP to them is noise. Everything else gets the full set.
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Content-Security-Policy', POLICY);

  // The admin panel and the OAuth callback both render account state. Neither
  // should ever sit in a shared cache or a browser's back-forward cache after
  // logout.
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/a/') || path.startsWith('/connect')) {
    c.header('Cache-Control', 'no-store, max-age=0');
  }
};
