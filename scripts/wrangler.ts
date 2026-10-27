/**
 * Runs the Wrangler that npm installed for this copy, for setup, doctor and
 * update.
 *
 * They used to start it through npx. On Windows npx is a .cmd shim, which
 * spawn cannot start without a shell, so every call failed and setup and doctor
 * told someone who was logged in that they were not. A shell would start it,
 * but cmd.exe re-reads every argument, and doctor's SQL is full of quotes.
 * Starting Wrangler's own entry script with the Node that is already running
 * needs no shell on any platform, and runs the version package-lock.json pins.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

export const WRANGLER_MISSING = 'Wrangler is not installed in this folder. Run  npm install  here first.';

export interface WranglerResult {
  code: number;
  out: string;
}

/**
 * Wrangler's command-line entry script, found the way Node finds the package
 * from `from`, or null when it is not installed there.
 */
export function wranglerBin(from: string | URL = import.meta.url): string | null {
  let manifest: string;
  let bin: unknown;
  try {
    manifest = createRequire(from).resolve('wrangler/package.json');
    bin = (JSON.parse(readFileSync(manifest, 'utf8')) as { bin?: unknown }).bin;
  } catch {
    return null;
  }
  const entry =
    typeof bin === 'string' ? bin : typeof bin === 'object' && bin !== null ? (bin as Record<string, unknown>).wrangler : null;
  if (typeof entry !== 'string') return null;
  const path = resolve(dirname(manifest), entry);
  return existsSync(path) ? path : null;
}

/** What spawn needs to run Wrangler with `args`. Each argument reaches Wrangler exactly as written. */
export function wranglerSpawnArgs(bin: string, args: readonly string[]): { command: string; args: string[] } {
  return { command: process.execPath, args: [bin, ...args] };
}

/** Runs Wrangler to the end and returns its exit code and combined output. */
export function runWrangler(
  bin: string | null,
  args: readonly string[],
  opts: { stdin?: 'inherit' | 'ignore'; cwd?: string } = {},
): WranglerResult {
  if (!bin) return { code: 127, out: WRANGLER_MISSING };
  const { command, args: argv } = wranglerSpawnArgs(bin, args);
  const res = spawnSync(command, argv, {
    cwd: opts.cwd,
    encoding: 'utf8',
    stdio: [opts.stdin ?? 'ignore', 'pipe', 'pipe'],
  });
  if (res.error) return { code: 127, out: res.error.message };
  return { code: res.status ?? 1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** Runs Wrangler with `input` written to its stdin, and never rejects. */
export function runWranglerWithInput(bin: string | null, args: readonly string[], input: string): Promise<WranglerResult> {
  if (!bin) return Promise.resolve({ code: 127, out: WRANGLER_MISSING });
  const { command, args: argv } = wranglerSpawnArgs(bin, args);
  return new Promise((done) => {
    const child = spawn(command, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      done({ code, out });
    };
    child.stdout.on('data', (d: Buffer) => (out += String(d)));
    child.stderr.on('data', (d: Buffer) => (out += String(d)));
    // Without these a process that cannot start, or one that exits before
    // reading its input, throws out of the whole script instead of failing
    // this one call. Node may or may not emit close after error.
    child.on('error', (err) => {
      out += err.message;
      finish(127);
    });
    child.stdin.on('error', () => {});
    child.on('close', (code) => finish(code ?? 1));
    child.stdin.end(input);
  });
}
