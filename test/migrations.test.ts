import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { DAY, IG_USER, NOW } from './support/seed.ts';

// Deployments from before migrations were tracked ran these two by hand with
// `wrangler d1 execute`. They have the tables and an empty d1_migrations, so
// their first `npm run db:migrate` applies both again.
const HAND_APPLIED = ['001_init.sql', '002_webhook_events.sql'];

// Raw rows with only the columns 001 and 002 define: what an old Worker wrote,
// not what today's write helpers would write once a migration adds a column.
const OLD_ROWS: Record<string, Record<string, string | number | null>> = {
  accounts: {
    ig_user_id: IG_USER,
    username: 'creator',
    access_token_enc: 'ciphertext',
    token_iv: 'iv',
    token_expires_at: NOW + 50 * DAY,
    active: 1,
    connected_at: NOW - 90 * DAY,
    last_refreshed_at: NOW - DAY,
    needs_reconnect: 0,
  },
  rules: {
    id: 7,
    ig_user_id: IG_USER,
    label: 'Free guide',
    keywords: '["guide"]',
    media_id: null,
    dm_text: 'Here is your guide: https://example.com/guide',
    public_reply_text: 'Sent you a DM!',
    active: 1,
    created_at: NOW - 30 * DAY,
  },
  sent: {
    comment_id: '18000000000000001',
    ig_user_id: IG_USER,
    rule_id: 7,
    commenter_id: '9100000000000001',
    dm_status: 'ok',
    reply_status: 'ok',
    error: null,
    sent_at: NOW - DAY,
  },
  system: { key: 'admin_password_hash', value: 'hash' },
  webhook_events: {
    id: 3,
    received_at: NOW - 60,
    status: 'ok',
    object: 'instagram',
    preview: 'guide please',
    error: null,
  },
};

async function schema() {
  const { results } = await env.DB.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name",
  ).all();
  return results;
}

async function recordedMigrations(): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>();
  return results.map((r) => r.name);
}

async function oldDeploymentThenMigrate() {
  await reset();
  for (const migration of env.TEST_MIGRATIONS.filter((m) => HAND_APPLIED.includes(m.name))) {
    await env.DB.batch(migration.queries.map((q) => env.DB.prepare(q)));
  }
  await env.DB.batch(
    Object.entries(OLD_ROWS).map(([table, row]) =>
      env.DB.prepare(
        `INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`,
      ).bind(...Object.values(row)),
    ),
  );

  // Mirrors `wrangler d1 migrations apply`: the same d1_migrations table, one batch per file.
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

describe('migrations', () => {
  it('replays 001 and 002 harmlessly on a deployment that applied them by hand', async () => {
    const freshInstall = await schema();

    await oldDeploymentThenMigrate();

    expect(await recordedMigrations()).toEqual(env.TEST_MIGRATIONS.map((m) => m.name));
    expect(await schema()).toEqual(freshInstall);
    for (const [table, row] of Object.entries(OLD_ROWS)) {
      const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
      expect(results, table).toMatchObject([row]);
    }
  });

  it('ends with the same schema whichever of 007 and the logs page’s copy of its index runs first', async () => {
    const freshInstall = await schema();
    // What PR #64 ships as 003_sent_time_index.sql.
    const logsPage = {
      name: '003_sent_time_index.sql',
      queries: ['CREATE INDEX IF NOT EXISTS idx_sent_time ON sent(sent_at DESC, comment_id DESC);'],
    };

    await applyD1Migrations(env.DB, [...env.TEST_MIGRATIONS, logsPage]);
    expect(await schema()).toEqual(freshInstall);

    await reset();
    const before = env.TEST_MIGRATIONS.filter((m) => m.name < logsPage.name);
    const after = env.TEST_MIGRATIONS.filter((m) => m.name > logsPage.name);
    await applyD1Migrations(env.DB, [...before, logsPage, ...after]);
    expect(await schema()).toEqual(freshInstall);
  });

  it('leaves rules saved before match-all needing a keyword', async () => {
    await oldDeploymentThenMigrate();
    const rule = await env.DB.prepare('SELECT match_all FROM rules WHERE id = 7').first<{ match_all: number }>();
    expect(rule).toEqual({ match_all: 0 });
  });

  it('gives rules saved before exclusions an empty list', async () => {
    await oldDeploymentThenMigrate();
    const rule = await env.DB.prepare('SELECT exclude_keywords FROM rules WHERE id = 7').first<{ exclude_keywords: string }>();
    expect(rule).toEqual({ exclude_keywords: '[]' });
  });

  it('keeps rules saved before match modes matching whole words', async () => {
    await oldDeploymentThenMigrate();
    const rule = await env.DB.prepare('SELECT match_mode FROM rules WHERE id = 7').first<{ match_mode: string }>();
    expect(rule).toEqual({ match_mode: 'word' });
    await expect(env.DB.prepare("UPDATE rules SET match_mode = 'regex' WHERE id = 7").run()).rejects.toThrow(/CHECK constraint failed/);
  });
});
