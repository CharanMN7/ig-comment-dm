import { type Context, Hono } from 'hono';
import { timingSafeEqualString } from '../crypto.ts';
import { BACKGROUND_COLOR, THEME_COLOR } from '../html.ts';
import { ICON_192_PNG, ICON_512_PNG, ICON_SVG } from '../icons.ts';
import type { Env } from '../types.ts';

/**
 * What a phone needs to put the admin panel on its home screen. Browsers fetch
 * a manifest without cookies, and Android passes it and its icons to Google's
 * WebAPK service, which has none either, so behind the login these would
 * answer with a redirect and the install would fail. They stay under the secret
 * path and hold only the app's name, colours and icon.
 *
 * Mounted ahead of the admin routes, so these GETs answer before the admin
 * login middleware runs. Any other path, or any other method on these paths,
 * goes through the login as before.
 */
export const installRoutes = new Hono<{ Bindings: Env }>();

// Relative URLs resolve against the manifest's own address, which keeps the
// app inside /a/<secret>/ without writing the secret into the body.
const MANIFEST = JSON.stringify({
  name: 'Comment to DM',
  short_name: 'Comment DM',
  start_url: './',
  scope: './',
  display: 'standalone',
  background_color: BACKGROUND_COLOR,
  theme_color: THEME_COLOR,
  icons: [
    { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    // The drawing keeps to the centre 80% circle, so the same PNGs are safe to crop.
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});

function decode(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
}

const PNGS = { 192: decode(ICON_192_PNG), 512: decode(ICON_512_PNG) };

function secretMatches(c: Context<{ Bindings: Env }>): boolean {
  return timingSafeEqualString(c.req.param('secret') ?? '', c.env.ADMIN_URL_SECRET ?? '');
}

// No Cache-Control here: the security headers mark everything under /a/ no-store.
installRoutes.get('/manifest.webmanifest', (c) =>
  secretMatches(c) ? c.body(MANIFEST, 200, { 'Content-Type': 'application/manifest+json' }) : c.notFound(),
);

installRoutes.get('/icon.svg', (c) =>
  secretMatches(c) ? c.body(ICON_SVG, 200, { 'Content-Type': 'image/svg+xml' }) : c.notFound(),
);

installRoutes.get('/icon-192.png', (c) =>
  secretMatches(c) ? c.body(PNGS[192], 200, { 'Content-Type': 'image/png' }) : c.notFound(),
);

installRoutes.get('/icon-512.png', (c) =>
  secretMatches(c) ? c.body(PNGS[512], 200, { 'Content-Type': 'image/png' }) : c.notFound(),
);
