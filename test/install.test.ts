import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { systemSet } from '../src/db.ts';
import { NOW, seedAccount, seedRule } from './support/seed.ts';
import { ORIGIN, type Reply, adminPath, request, signedInAdmin } from './support/worker.ts';

type Icon = { src: string; sizes: string; type: string; purpose: string };
type Manifest = {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: Icon[];
};

const PUBLIC_PATHS = ['/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

async function manifest(): Promise<{ res: Reply; body: Manifest; url: string }> {
  const url = new URL(adminPath('/manifest.webmanifest'), ORIGIN).href;
  const res = await request(adminPath('/manifest.webmanifest'));
  return { res, body: JSON.parse(res.text) as Manifest, url };
}

// Written here rather than imported from scripts/icons.ts, so a broken encoder
// can't check its own output.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Walks every chunk, checks its CRC, and inflates the image data, as a strict decoder would. */
async function readPng(png: Uint8Array): Promise<{ width: number; height: number; chunks: string[]; pixelBytes: number }> {
  expect([...png.slice(0, 8)], 'PNG signature').toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: string[] = [];
  const idat: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  let channels = 0;
  let at = 8;
  while (at < png.length) {
    const length = view.getUint32(at);
    const typeAndData = png.slice(at + 4, at + 8 + length);
    const type = String.fromCharCode(...typeAndData.slice(0, 4));
    expect(view.getUint32(at + 8 + length), `${type} CRC`).toBe(crc32(typeAndData));
    const data = typeAndData.slice(4);
    if (type === 'IHDR') {
      const ihdr = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = ihdr.getUint32(0);
      height = ihdr.getUint32(4);
      expect(data[8], 'bit depth').toBe(8);
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[data[9]!] ?? 0;
      expect(channels, 'colour type').toBeGreaterThan(0);
    }
    if (type === 'IDAT') idat.push(data);
    chunks.push(type);
    at += 12 + length;
  }
  expect(at, 'no trailing bytes').toBe(png.length);
  const inflated = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  expect(inflated.length, 'one filter byte plus one row of pixels per line').toBe(height * (1 + width * channels));
  return { width, height, chunks, pixelBytes: inflated.length };
}

describe('the web app manifest', () => {
  it('is served from inside the admin path, with the app inside it too', async () => {
    const { res, body, url } = await manifest();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/manifest+json');
    expect(body).toMatchObject({
      name: 'Comment to DM',
      short_name: 'Comment DM',
      display: 'standalone',
      background_color: '#f6f6f4',
      theme_color: '#ffffff',
    });
    const inside = `/a/${env.ADMIN_URL_SECRET}/`;
    expect(new URL(body.start_url, url).pathname).toBe(inside);
    expect(new URL(body.scope, url).pathname).toBe(inside);
    for (const icon of body.icons) expect(new URL(icon.src, url).pathname.startsWith(inside)).toBe(true);
  });

  it('lists an SVG for any size, PNGs at 192 and 512, and keeps maskable entries separate', async () => {
    const { body } = await manifest();
    expect(body.icons).toEqual([
      { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ]);
  });

  it('answers HEAD too', async () => {
    const res = await request(adminPath('/manifest.webmanifest'), { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.text).toBe('');
  });
});

describe('the home-screen icons', () => {
  it.each([
    ['/icon-192.png', 192],
    ['/icon-512.png', 512],
  ])('serves %s as a well-formed PNG of the size the manifest claims', async (path, size) => {
    const res = await request(adminPath(path));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    const png = await readPng(res.bytes);
    expect(png).toMatchObject({ width: size, height: size });
    expect(png.chunks[0]).toBe('IHDR');
    expect(png.chunks.at(-1)).toBe('IEND');
  });

  it('serves the SVG as an inert image', async () => {
    const res = await request(adminPath('/icon.svg'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(res.text).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512">/);
    expect(res.text).toMatch(/<\/svg>$/);
    expect(res.text).not.toMatch(/<script|\son[a-z]+=|href=/i);
  });

  it('serves every icon the manifest lists, with the type it declares', async () => {
    const { body, url } = await manifest();
    for (const icon of body.icons) {
      const res = await request(new URL(icon.src, url).pathname);
      expect(res.status, icon.src).toBe(200);
      expect(res.headers.get('Content-Type'), icon.src).toBe(icon.type);
    }
  });
});

describe('the login bypass for install files', () => {
  it.each(PUBLIC_PATHS)('serves %s with no session, no cookie, no-store and the usual headers', async (path) => {
    // A password is set and the login is locked out, which must not matter.
    await signedInAdmin();
    await systemSet(env.DB, 'login_locked_until', String(NOW + 3600));
    const res = await request(adminPath(path));
    expect(res.status).toBe(200);
    expect(res.setCookies).toEqual([]);
    expect(res.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });

  it.each(PUBLIC_PATHS)('answers 404 for %s under a wrong secret', async (path) => {
    for (const secret of ['not-the-secret', env.ADMIN_URL_SECRET.slice(0, -1)]) {
      const res = await request(`/a/${secret}${path}`);
      expect(res.status).toBe(404);
      expect(res.setCookies).toEqual([]);
    }
  });

  it('still sends every other admin path to the login', async () => {
    await seedAccount();
    await seedRule();
    await signedInAdmin();
    for (const path of [
      '/',
      '/rules',
      '/rules/1/edit',
      '/test',
      '/accounts',
      '/selftest/status',
      '/manifest.json',
      '/icon.png',
      '/icon-180.png',
      '/icon.svg/x',
    ]) {
      const res = await request(adminPath(path));
      expect([path, res.status, res.location]).toEqual([path, 302, adminPath('/login')]);
    }
  });

  it('still checks the session and CSRF token on a POST to an install path', async () => {
    await signedInAdmin();
    const res = await request(adminPath('/manifest.webmanifest'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'csrf=forged',
    });
    expect(res.status).toBe(302);
    expect(res.location).toBe(adminPath('/login'));
  });
});

describe('install links in the pages', () => {
  const LINK = `<link rel="manifest" href="${adminPath('/manifest.webmanifest')}" />`;

  it('puts the manifest link and theme colour on every admin page, login and setup included', async () => {
    await seedAccount();
    const fresh = await request(adminPath('/setup'));
    const admin = await signedInAdmin();
    const pages: Array<[string, string]> = [
      ['setup', fresh.text],
      ['login', (await request(adminPath('/login'))).text],
      ['home', (await admin.get(adminPath('/'))).text],
      ['rules', (await admin.get(adminPath('/rules'))).text],
      ['new rule', (await admin.get(adminPath('/rules/new'))).text],
      ['test', (await admin.get(adminPath('/test'))).text],
      ['accounts', (await admin.get(adminPath('/accounts'))).text],
    ];
    for (const [name, page] of pages) {
      expect(page, name).toContain(LINK);
      expect(page, name).toContain('<meta name="theme-color" content="#ffffff" />');
      expect(page, name).toContain(`<link rel="apple-touch-icon" href="${adminPath('/icon-192.png')}" />`);
    }
  });

  it('never links the manifest from a public page, where it would publish the admin address', async () => {
    for (const path of ['/privacy', '/terms', '/data-deletion', '/connect', '/connect/callback?error=access_denied']) {
      const res = await request(path);
      expect(res.text, path).not.toContain('manifest');
      expect(res.text, path).not.toContain('icon-192.png');
    }
  });
});
