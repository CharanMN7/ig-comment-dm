// `env` from cloudflare:workers is typed as Cloudflare.Env. Widening it to the
// Worker's own Env keeps tests and src agreeing on bindings without a cast.
declare namespace Cloudflare {
  type WorkerEnv = import('../src/types.ts').Env;
  interface Env extends WorkerEnv {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
