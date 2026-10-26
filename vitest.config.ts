import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { unstable_readConfig } from 'wrangler';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));
const wranglerConfig = path.join(root, 'wrangler.toml');

// Migrations are found the same way `wrangler d1 migrations apply` finds them,
// so a PR that adds 003_*.sql or changes `migrations_dir` is tested as written
// instead of against a list someone has to remember to update.
function migrationsFor(binding: string) {
  const config = unstable_readConfig({ config: wranglerConfig });
  const db = config.d1_databases.find((d) => d.binding === binding);
  if (!db) throw new Error(`wrangler.toml has no D1 binding named ${binding}`);
  return readD1Migrations({
    projectPath: root,
    migrationsDir: db.migrations_dir ?? 'migrations',
    migrationsPattern: db.migrations_pattern,
  });
}

// The plugin still reads `.dev.vars` (and says so), but every key the Worker
// uses is overridden here, so a contributor's real Meta credentials can't leak
// into a run or make it pass only on their machine. Values are deliberately
// low-entropy so the CI secret scan stays quiet.
const key32 = (fill: number) => Buffer.alloc(32, fill).toString('base64');

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: wranglerConfig },
      miniflare: {
        bindings: {
          META_APP_ID: '1000000000000001',
          META_APP_SECRET: 'instagram-app-key',
          FACEBOOK_APP_SECRET: 'facebook-app-key',
          WEBHOOK_VERIFY_TOKEN: 'verify-me',
          TOKEN_ENCRYPTION_KEY: key32(1),
          SESSION_SIGNING_KEY: key32(2),
          ADMIN_URL_SECRET: 'admin'.padEnd(32, '0'),
          PUBLIC_BASE_URL: 'https://ig-comment-dm.example.workers.dev',
          TEST_MIGRATIONS: await migrationsFor('DB'),
        },
      },
    })),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/support/setup.ts'],
    // Each test file gets its own workerd process (~120 MB). Three keep the
    // suite at a few seconds without eating a laptop's memory.
    maxWorkers: 3,
  },
});
