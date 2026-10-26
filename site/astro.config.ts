import { defineConfig } from 'astro/config';
import inkform from '@inkform/astro';
import { siteRootLinks } from './integrations/site-root-links.ts';

// Where the site is served. Everything else (Astro's `site` and `base`, every
// link on the landing page and in the docs) is derived from this one URL.
// The Pages workflow passes the URL that GitHub reports for the repo, so a
// custom domain set in the repo's Pages settings is picked up on the next
// deploy. Locally, change this line or set SITE_URL.
const siteUrl = new URL(process.env.SITE_URL || 'https://charanmn7.github.io/ig-comment-dm/');
const base = siteUrl.pathname.replace(/\/+$/, '') || '/';

export default defineConfig({
  site: siteUrl.origin,
  base,
  // Pages serves /docs/setup/ from docs/setup/index.html and redirects
  // /docs/setup to it, so links that already end in a slash skip a hop.
  trailingSlash: 'always',
  integrations: [
    inkform({
      base: '/docs',
      contentRoot: './content',
      theme: './src/styles/docs-theme.css',
      mermaid: true,
    }),
    siteRootLinks(),
  ],
});
