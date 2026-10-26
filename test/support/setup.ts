import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import { meta, metaHandlers, network } from './meta.ts';
import { FROZEN_NOW_MS } from './seed.ts';

beforeAll(() => network.enable());
afterAll(() => network.disable());

beforeEach(async () => {
  // Only Date is faked: real timers keep D1 and MSW working, and the one code
  // path that sleeps (Meta retry backoff) is tested with its sleep mocked.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FROZEN_NOW_MS);

  // The pool isolates storage per file, not per test. Wiping and re-migrating
  // costs a few milliseconds and means no test can lean on another's rows.
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

  meta.reset();
  network.use(...metaHandlers);
});

afterEach(() => {
  network.resetHandlers();
  vi.useRealTimers();
  expect(meta.escaped, 'request to a non-Meta host; the suite must never touch the network').toEqual([]);
  expect(meta.unrouted, 'Meta request with no fake; add a route in test/support/meta.ts').toEqual([]);
});
