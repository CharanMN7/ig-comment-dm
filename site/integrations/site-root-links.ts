import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';

/**
 * @inkform/astro 0.1.0 adds Astro's `base` to links that point at docs pages,
 * but writes every other site-root link as it is in docs.json or the MDX: the
 * header's "Home" link (`/`) would point at github.io's root instead of this
 * project's page. docs.json is plain JSON and can't read the base, so the
 * built docs pages get it here. Off when the site is served from a domain
 * root, where `/` is already right.
 */
export function siteRootLinks(): AstroIntegration {
  let base = '';
  return {
    name: 'site-root-links',
    hooks: {
      'astro:config:done': ({ config }) => {
        base = config.base.replace(/\/+$/, '');
      },
      'astro:build:done': async ({ dir, logger }) => {
        if (!base) return;
        const docsDir = path.join(fileURLToPath(dir), 'docs');
        const link = /(<a\b[^>]*?\shref=")(\/(?!\/)[^"]*)"/g;
        let changed = 0;
        for (const file of await htmlFiles(docsDir)) {
          const html = await readFile(file, 'utf8');
          const next = html.replace(link, (match, start: string, href: string) => {
            if (href === base || href.startsWith(`${base}/`)) return match;
            changed++;
            return `${start}${base}${href}"`;
          });
          if (next !== html) await writeFile(file, next);
        }
        logger.info(`Prefixed ${changed} site-root links in the docs with ${base}`);
      },
    },
  };
}

async function htmlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile() && e.name.endsWith('.html')).map((e) => path.join(e.parentPath, e.name));
}
