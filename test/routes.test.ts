import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { adminPath, request } from './support/worker.ts';

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
      "default-src 'none'; style-src 'unsafe-inline'; manifest-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('answers 404 for unknown paths', async () => {
    expect((await request('/wp-login.php')).status).toBe(404);
  });
});

describe('the favicon', () => {
  it('links one from every page, so a browser stops asking for /favicon.ico', async () => {
    for (const path of ['/privacy', '/terms', '/data-deletion', '/connect', adminPath('/setup')]) {
      const res = await request(path);
      expect(res.text, path).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
    }
  });

  it('serves the SVG and a PNG at /favicon.ico, publicly cacheable and outside the admin path', async () => {
    for (const [path, type] of [
      ['/favicon.svg', 'image/svg+xml'],
      ['/favicon.ico', 'image/png'],
    ]) {
      const res = await request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('Content-Type'), path).toBe(type);
      expect(res.headers.get('Cache-Control'), path).toBe('public, max-age=604800');
      expect(res.headers.get('Content-Security-Policy'), path).toContain("default-src 'none'");
      expect(res.setCookies, path).toEqual([]);
    }
    const svg = await request('/favicon.svg');
    expect(svg.text).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512">/);
    const ico = await request('/favicon.ico');
    expect([...ico.bytes.slice(0, 8)], 'PNG signature').toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});
