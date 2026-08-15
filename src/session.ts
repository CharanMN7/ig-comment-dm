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

function cookieSecure(publicBaseUrl: string): boolean {
  return publicBaseUrl.startsWith('https://');
}

export function serializeSessionCookie(
  value: string,
  publicBaseUrl: string,
  maxAge: number,
): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  if (cookieSecure(publicBaseUrl)) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(publicBaseUrl: string): string {
  return serializeSessionCookie('', publicBaseUrl, 0);
}

export async function makeSession(
  signingKeyB64: string,
  authed: boolean,
  csrf?: string,
): Promise<{ token: string; data: SessionData }> {
  const data: SessionData = {
    exp: nowSeconds() + SESSION_TTL_SECONDS,
    csrf: csrf ?? randomHex(16),
    authed,
  };
  const payload = bytesToB64Url(new TextEncoder().encode(JSON.stringify(data)));
  const mac = await hmacSignBytes(sessionSigningKey(signingKeyB64), payload);
  return { token: `${payload}.${bytesToB64Url(mac)}`, data };
}

export async function readSession(
  signingKeyB64: string,
  cookieHeader: string | undefined,
): Promise<SessionData | null> {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  const token = match[1];
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
  const ok = await hmacVerifyBytes(sessionSigningKey(signingKeyB64), payload, mac);
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

export async function makeOauthState(signingKeyB64: string): Promise<string> {
  const payload = bytesToB64Url(
    new TextEncoder().encode(JSON.stringify({ exp: nowSeconds() + 600, n: randomHex(16) })),
  );
  const mac = await hmacSignBytes(sessionSigningKey(signingKeyB64), payload);
  return `${payload}.${bytesToB64Url(mac)}`;
}

export async function verifyOauthState(signingKeyB64: string, state: string): Promise<boolean> {
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = state.slice(0, dot);
  let mac: Uint8Array;
  try {
    mac = b64UrlToBytes(state.slice(dot + 1));
  } catch {
    return false;
  }
  const ok = await hmacVerifyBytes(sessionSigningKey(signingKeyB64), payload, mac);
  if (!ok) return false;
  try {
    const data = JSON.parse(new TextDecoder().decode(b64UrlToBytes(payload))) as { exp?: number };
    return typeof data.exp === 'number' && data.exp >= nowSeconds();
  } catch {
    return false;
  }
}
