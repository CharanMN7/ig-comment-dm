import { b64ToBytes } from './crypto.ts';
import type { Env } from './types.ts';

export type ConfigProblem = {
  secret: string;
  detail: string;
  fix: string;
};

function decodesTo32Bytes(value: string): boolean {
  try {
    return b64ToBytes(value).length === 32;
  } catch {
    return false;
  }
}

/**
 * Every one of these is a misconfiguration that fails *later* and *somewhere
 * unrelated* — a 500 on the first password save, an "Invalid redirect_uri" from
 * Instagram, a webhook silently rejected as unsigned. Each of those has cost
 * people an evening of debugging the wrong thing.
 *
 * Checking the shape of the secrets up front turns all of them into one banner
 * that names the secret and the command that fixes it. This runs on the admin
 * home page only, so it costs nothing on the webhook hot path.
 */
export function findConfigProblems(env: Env): ConfigProblem[] {
  const problems: ConfigProblem[] = [];

  const required: Array<[keyof Env, string]> = [
    ['META_APP_ID', 'Instagram App ID from Business login settings'],
    ['META_APP_SECRET', 'Instagram App Secret from Business login settings'],
    ['WEBHOOK_VERIFY_TOKEN', 'the value you also typed into Meta’s Verify token box'],
    ['TOKEN_ENCRYPTION_KEY', 'the AES key for Instagram tokens at rest'],
    ['SESSION_SIGNING_KEY', 'the HMAC key for admin session cookies'],
    ['ADMIN_URL_SECRET', 'the path segment that hides this page'],
    ['PUBLIC_BASE_URL', 'your Worker URL'],
  ];

  for (const [name, what] of required) {
    const value = (env[name] as string | undefined) ?? '';
    if (value.trim() === '') {
      problems.push({
        secret: String(name),
        detail: `Not set — this is ${what}.`,
        fix: `npx wrangler secret put ${String(name)}`,
      });
    }
  }

  for (const name of ['TOKEN_ENCRYPTION_KEY', 'SESSION_SIGNING_KEY'] as const) {
    const value = (env[name] ?? '').trim();
    if (value !== '' && !decodesTo32Bytes(value)) {
      problems.push({
        secret: name,
        detail:
          'Set, but it does not decode to 32 bytes. A truncated paste looks fine here and then throws at runtime.',
        fix: `npm run keys, then npx wrangler secret put ${name}`,
      });
    }
  }

  if (env.TOKEN_ENCRYPTION_KEY && env.TOKEN_ENCRYPTION_KEY === env.SESSION_SIGNING_KEY) {
    problems.push({
      secret: 'SESSION_SIGNING_KEY',
      detail:
        'Identical to TOKEN_ENCRYPTION_KEY. One key that both encrypts tokens and signs sessions means a single leak costs you both.',
      fix: 'npm run keys, then npx wrangler secret put SESSION_SIGNING_KEY',
    });
  }

  const adminSecret = (env.ADMIN_URL_SECRET ?? '').trim();
  if (adminSecret !== '' && adminSecret.length < 24) {
    problems.push({
      secret: 'ADMIN_URL_SECRET',
      detail: `Only ${adminSecret.length} characters. This is the first of the two things standing between the internet and your admin panel; it should be 32.`,
      fix: 'npm run keys, then npx wrangler secret put ADMIN_URL_SECRET',
    });
  }

  const base = (env.PUBLIC_BASE_URL ?? '').trim();
  if (base !== '' && base.endsWith('/')) {
    problems.push({
      secret: 'PUBLIC_BASE_URL',
      detail: 'Has a trailing slash. Cookie and redirect URLs are built by appending to it.',
      fix: 'npx wrangler secret put PUBLIC_BASE_URL — paste it without the trailing slash',
    });
  }
  if (base !== '' && !/^https?:\/\//.test(base)) {
    problems.push({
      secret: 'PUBLIC_BASE_URL',
      detail: 'Missing the https:// prefix. Session cookies are only marked Secure when it starts with https://.',
      fix: 'npx wrangler secret put PUBLIC_BASE_URL',
    });
  }

  if ((env.FACEBOOK_APP_SECRET ?? '').trim() === '') {
    problems.push({
      secret: 'FACEBOOK_APP_SECRET',
      detail:
        'Not set. Meta signs live comment notifications with the Facebook App Secret, not the Instagram one, so webhooks will be rejected as “Wrong secret” and no DM will ever send. This is the single most common reason a correct-looking setup does nothing.',
      fix: 'App settings → Basic → App secret → Show, then npx wrangler secret put FACEBOOK_APP_SECRET',
    });
  }

  return problems;
}
