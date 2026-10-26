// Checks every internal link and asset reference in the built site, including
// #fragments, so a renamed heading or a moved page fails the build check
// instead of 404ing for a reader. External links aren't fetched.
//
//   node scripts/check-links.mjs dist
//
// The site is built under a base path (/ig-comment-dm/ on GitHub Pages), read
// from SITE_URL, with the same default as astro.config.ts.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const dist = path.resolve(process.argv[2] ?? 'dist');
if (!existsSync(dist)) {
  console.error(`No build output at ${dist}. Run npm run build first.`);
  process.exit(1);
}

const siteUrl = new URL(process.env.SITE_URL || 'https://charanmn7.github.io/ig-comment-dm/');
const base = siteUrl.pathname.endsWith('/') ? siteUrl.pathname : `${siteUrl.pathname}/`;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const pages = walk(dist).filter((f) => f.endsWith('.html'));
const idsCache = new Map();

function idsIn(file) {
  if (!idsCache.has(file)) {
    const html = readFileSync(file, 'utf8');
    idsCache.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => decodeEntities(m[1]))));
  }
  return idsCache.get(file);
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');
}

/** The file a site path is served from, or null. */
function resolveTarget(urlPath) {
  if (!urlPath.startsWith(base)) return null;
  const rel = decodeURIComponent(urlPath.slice(base.length));
  const candidates = rel === '' || rel.endsWith('/') ? [path.join(dist, rel, 'index.html')] : [path.join(dist, rel), path.join(dist, rel, 'index.html')];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

const problems = [];
let checked = 0;
let external = 0;

for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  const pageUrl = new URL(`${base}${path.relative(dist, page).split(path.sep).join('/')}`.replace(/index\.html$/, ''), siteUrl);
  // Skip <code>/<pre> contents: example URLs there are text, not links.
  const scrubbed = html.replace(/<pre[\s\S]*?<\/pre>/g, '');
  for (const m of scrubbed.matchAll(/<(a|link|img|script|source)\b[^>]*?\s(href|src)="([^"]*)"/g)) {
    const raw = decodeEntities(m[3]);
    if (!raw || /^(mailto:|tel:|data:|javascript:)/.test(raw)) continue;
    const url = new URL(raw, pageUrl);
    if (url.origin !== siteUrl.origin) {
      external++;
      continue;
    }
    checked++;
    const target = url.pathname === pageUrl.pathname ? page : resolveTarget(url.pathname);
    const where = `${path.relative(dist, page)} → ${raw}`;
    if (!target) {
      problems.push(`${where}: no such page or file`);
      continue;
    }
    if (url.hash && target.endsWith('.html')) {
      const id = decodeURIComponent(url.hash.slice(1));
      if (!idsIn(target).has(id)) problems.push(`${where}: no element with id "${id}"`);
    }
    if (m[1] === 'a' && target.endsWith('index.html') && !url.pathname.endsWith('/')) {
      problems.push(`${where}: missing trailing slash (Pages would redirect)`);
    }
  }
}

console.log(`Checked ${checked} internal links across ${pages.length} pages (${external} external links not fetched).`);
if (problems.length) {
  console.error(`\n${problems.length} broken:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('No broken internal links.');
