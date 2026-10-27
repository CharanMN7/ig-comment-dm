import {
  SESSION_TTL_SECONDS,
  bytesToB64Url,
  b64UrlToBytes,
  hmacSignBytes,
  hmacVerifyBytes,
  nowSeconds,
  randomHex,
  sessionSigningKey,
} from './crypto.ts';
import type { SessionData } from './types.ts';

export const SESSION_COOKIE = 'igcdm_session';
export const CONNECT_COOKIE = 'igcdm_connect';
export const OAUTH_STATE_TTL_SECONDS = 600;

function cookieSecure(publicBaseUrl: string): boolean {
  return publicBaseUrl.startsWith('https://');
}

function serializeCookie(
  name: string,
  value: string,
  opts: { path: string; sameSite: 'Strict' | 'Lax'; maxAge: number; publicBaseUrl: string },
): string {
  const parts = [`${name}=${value}`, `Path=${opts.path}`, 'HttpOnly', `SameSite=${opts.sameSite}`, `Max-Age=${opts.maxAge}`];
  if (cookieSecure(opts.publicBaseUrl)) parts.push('Secure');
  return parts.join('; ');
}

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

export function serializeSessionCookie(
  value: string,
  publicBaseUrl: string,
  maxAge: number,
): string {
  return serializeCookie(SESSION_COOKIE, value, { path: '/', sameSite: 'Strict', maxAge, publicBaseUrl });
}

export function clearSessionCookie(publicBaseUrl: string): string {
  return serializeSessionCookie('', publicBaseUrl, 0);
}

const SESSION_EPOCH_KEY = 'session_epoch';

/**
 * What a session's signature covers besides its own payload. Sessions are
 * stateless cookies, so without this a copied cookie would keep working for its
 * full 30 days, through logout and through a password reset. The salt is
 * replaced whenever a password is set, so a reset ends every older session.
 * The epoch goes up on logout, which ends every session, in every browser.
 */
export type SessionBinding = { salt: string | null; epoch: string };

/** The binding, plus whether a password exists, in one read of `system`. */
export async function readSessionBinding(db: D1Database): Promise<{ binding: SessionBinding; hasPassword: boolean }> {
  const { results } = await db
    .prepare(`SELECT key, value FROM system WHERE key IN ('admin_password_hash', 'admin_password_salt', ?)`)
    .bind(SESSION_EPOCH_KEY)
    .all<{ key: string; value: string | null }>();
  const value = (key: string) => results.find((r) => r.key === key)?.value || null;
  const salt = value('admin_password_salt');
  return { binding: { salt, epoch: value(SESSION_EPOCH_KEY) ?? '0' }, hasPassword: !!(salt && value('admin_password_hash')) };
}

export async function endAllSessions(db: D1Database): Promise<void> {
  await db
    .prepare(
      `INSERT INTO system (key, value) VALUES (?, '1')
       ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`,
    )
    .bind(SESSION_EPOCH_KEY)
    .run();
}

// The payload is base64url and the salt base64, neither of which contains a
// '.', so no two bindings sign the same string. The '.' also keeps these
// apart from OAuth state MACs, which sign a bare payload.
function signedText(payload: string, binding: SessionBinding): string {
  return `${payload}.${binding.salt ?? ''}.${binding.epoch}`;
}

export async function makeSession(
  signingKeyB64: string,
  binding: SessionBinding,
  authed: boolean,
  csrf?: string,
): Promise<{ token: string; data: SessionData }> {
  const data: SessionData = {
    exp: nowSeconds() + SESSION_TTL_SECONDS,
    csrf: csrf ?? randomHex(16),
    authed,
  };
  const payload = bytesToB64Url(new TextEncoder().encode(JSON.stringify(data)));
  const mac = await hmacSignBytes(sessionSigningKey(signingKeyB64), signedText(payload, binding));
  return { token: `${payload}.${bytesToB64Url(mac)}`, data };
}

export async function readSession(
  signingKeyB64: string,
  binding: SessionBinding,
  cookieHeader: string | undefined,
): Promise<SessionData | null> {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const macB64 = token.slice(dot + 1);
  let mac: Uint8Array;
  try {
    mac = b64UrlToBytes(macB64);
  } catch {
    return null;
  }
  const ok = await hmacVerifyBytes(sessionSigningKey(signingKeyB64), signedText(payload, binding), mac);
  if (!ok) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(b64UrlToBytes(payload))) as SessionData;
    if (typeof data.exp !== 'number' || data.exp < nowSeconds()) return null;
    if (typeof data.csrf !== 'string' || typeof data.authed !== 'boolean') return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * The admin session cookie is SameSite=Strict, so the browser leaves it off
 * Instagram's cross-site redirect back to /connect/callback. /connect/start
 * does see it, so that is where the admin is checked. It hands Instagram a
 * signed state, and hands this browser a Lax cookie holding a MAC of the
 * state's nonce. The callback needs both. The state alone is not enough: it
 * has been through Instagram and the address bar.
 */
export async function makeOauthState(signingKeyB64: string): Promise<{ state: string; cookie: string }> {
  const key = sessionSigningKey(signingKeyB64);
  const n = randomHex(16);
  const payload = bytesToB64Url(
    new TextEncoder().encode(JSON.stringify({ p: 'oauth', exp: nowSeconds() + OAUTH_STATE_TTL_SECONDS, n })),
  );
  const mac = await hmacSignBytes(key, payload);
  // A base64url payload can't contain ':', so this MAC can never double as a
  // state or session signature made with the same key.
  const binding = await hmacSignBytes(key, `connect:${n}`);
  return { state: `${payload}.${bytesToB64Url(mac)}`, cookie: bytesToB64Url(binding) };
}

export async function verifyOauthState(
  signingKeyB64: string,
  state: string,
  cookieHeader: string | undefined,
): Promise<boolean> {
  const key = sessionSigningKey(signingKeyB64);
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = state.slice(0, dot);
  const cookie = readCookie(cookieHeader, CONNECT_COOKIE);
  if (!cookie) return false;
  let mac: Uint8Array;
  let binding: Uint8Array;
  try {
    mac = b64UrlToBytes(state.slice(dot + 1));
    binding = b64UrlToBytes(cookie);
  } catch {
    return false;
  }
  if (!(await hmacVerifyBytes(key, payload, mac))) return false;
  let data: { p?: unknown; exp?: unknown; n?: unknown };
  try {
    data = JSON.parse(new TextDecoder().decode(b64UrlToBytes(payload))) as typeof data;
  } catch {
    return false;
  }
  if (data.p !== 'oauth' || typeof data.exp !== 'number' || data.exp < nowSeconds()) return false;
  if (typeof data.n !== 'string') return false;
  return hmacVerifyBytes(key, `connect:${data.n}`, binding);
}

export function serializeConnectCookie(value: string, publicBaseUrl: string, maxAge: number): string {
  return serializeCookie(CONNECT_COOKIE, value, { path: '/connect', sameSite: 'Lax', maxAge, publicBaseUrl });
}
