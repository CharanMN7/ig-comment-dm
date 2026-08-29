/**
 * Prints correctly-sized values for the four secrets you generate yourself.
 *
 * Two of them (TOKEN_ENCRYPTION_KEY, SESSION_SIGNING_KEY) must decode to exactly
 * 32 bytes or the Worker throws at runtime, which is a confusing failure to debug
 * from a 500 page. Generating them here removes the chance of pasting a truncated
 * `openssl rand` output.
 *
 *   npm run keys
 */
import { webcrypto } from 'node:crypto';

type Spec = {
  name: string;
  value: () => string;
  note: string;
};

function randomBytes(n: number): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(n));
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

const SPECS: Spec[] = [
  {
    name: 'TOKEN_ENCRYPTION_KEY',
    value: () => b64(randomBytes(32)),
    note: 'AES-256-GCM key for Instagram tokens at rest. Must be 32 bytes, base64.',
  },
  {
    name: 'SESSION_SIGNING_KEY',
    value: () => b64(randomBytes(32)),
    note: 'HMAC key for admin session cookies. Must be 32 bytes, base64. Never reuse the one above.',
  },
  {
    name: 'ADMIN_URL_SECRET',
    value: () => hex(randomBytes(16)),
    note: 'The /a/<this> path segment that hides the admin panel. 32 hex characters.',
  },
  {
    name: 'WEBHOOK_VERIFY_TOKEN',
    value: () => hex(randomBytes(16)),
    note: 'Type this same value into Meta’s webhook Verify token box.',
  },
];

const wantsEnv = process.argv.includes('--env');

if (wantsEnv) {
  for (const spec of SPECS) console.log(`${spec.name}=${spec.value()}`);
} else {
  console.log('\nFour secrets you generate. The other four come from Meta or from your Worker URL.\n');
  for (const spec of SPECS) {
    console.log(`  \x1b[1m${spec.name}\x1b[0m`);
    console.log(`  \x1b[2m${spec.note}\x1b[0m`);
    console.log(`  ${spec.value()}\n`);
  }
  console.log('\x1b[2mThese are freshly generated and shown once. Nothing was written to disk.');
  console.log('Paste them into .dev.vars for local work, or `npx wrangler secret put <NAME>` for a deploy.');
  console.log('Run `npm run keys -- --env` to get them as KEY=value lines instead.\x1b[0m\n');
}
