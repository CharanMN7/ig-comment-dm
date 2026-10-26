import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { request } from './support/worker.ts';

describe('public routes', () => {
  it('boots the Worker named in wrangler.toml and answers the deploy smoke check', async () => {
    // Through the pool's own dispatch rather than a direct import, so a broken
    // `main` or module graph fails here even if direct calls still work. The
    // cast is because src/index.ts types `scheduled`'s first parameter as
    // ScheduledEvent, so its default export doesn't type as an ExportedHandler.
    const main = exports as unknown as { default: Fetcher };
    const res = await main.default.fetch('https://ig-comment-dm.example.workers.dev/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it.each([
    ['/privacy', 'Privacy Policy'],
    ['/terms', 'Terms of Service'],
    ['/data-deletion', 'Data deletion'],
  ])('serves %s for Meta app review with the security headers', async (path, heading) => {
    const res = await request(path);
    expect(res.status).toBe(200);
    expect(res.text).toContain(heading);
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('answers 404 for unknown paths', async () => {
    expect((await request('/wp-login.php')).status).toBe(404);
  });
});
