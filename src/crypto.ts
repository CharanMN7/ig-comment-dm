const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const PBKDF2_ITERATIONS = 600_000;
export const COMMENT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const TOKEN_LOOKAHEAD_SECONDS = 10 * 24 * 60 * 60;
export const TOKEN_MIN_AGE_SECONDS = 24 * 60 * 60;
export const RECONNECT_WARN_SECONDS = 14 * 24 * 60 * 60;
export const CRON_STALE_SECONDS = 72 * 60 * 60;
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const DM_TEXT_MAX = 1000;

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.trim().toLowerCase();
  if (h.length % 2 !== 0 || /[^0-9a-f]/.test(h)) throw new Error('invalid hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64Url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function b64UrlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return b64ToBytes(b64);
}

function asBufferSource(bytes: Uint8Array): BufferSource {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a[i] ^ b[i];
  return out === 0;
}

function decodeKey32(b64: string, name: string): Uint8Array {
  const bytes = b64ToBytes(b64);
  if (bytes.length !== 32) {
    throw new Error(`${name} must be 32 random bytes, base64-encoded`);
  }
  return bytes;
}

/** HMAC-SHA256 verify against a hex digest. Timing-safe via subtle.verify. */
export async function verifyHmacSha256Hex(
  secret: string,
  payload: string,
  signatureHex: string,
): Promise<boolean> {
  let sigBytes: Uint8Array;
  try {
    sigBytes = hexToBytes(signatureHex);
  } catch {
    return false;
  }
  if (sigBytes.length !== 32) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  try {
    return await crypto.subtle.verify('HMAC', key, asBufferSource(sigBytes), encoder.encode(payload));
  } catch {
    return false;
  }
}

export async function verifyMetaSignature(
  appSecret: string,
  rawBody: string,
  header: string | null | undefined,
): Promise<boolean> {
  if (!header) return false;
  const match = header.trim().match(/^sha256=([0-9a-fA-F]+)$/);
  if (!match) return false;
  return verifyHmacSha256Hex(appSecret, rawBody, match[1]);
}

/** Used by selftest and session cookies — not by webhook verification. */
export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return bytesToHex(new Uint8Array(sig));
}

async function hmacKey(raw: Uint8Array, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', asBufferSource(raw), { name: 'HMAC', hash: 'SHA-256' }, false, [
    usage,
  ]);
}

export async function hmacSignBytes(keyBytes: Uint8Array, data: string): Promise<Uint8Array> {
  const key = await hmacKey(keyBytes, 'sign');
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return new Uint8Array(sig);
}

export async function hmacVerifyBytes(
  keyBytes: Uint8Array,
  data: string,
  signature: Uint8Array,
): Promise<boolean> {
  const key = await hmacKey(keyBytes, 'verify');
  try {
    return await crypto.subtle.verify('HMAC', key, asBufferSource(signature), encoder.encode(data));
  } catch {
    return false;
  }
}

export async function encryptAesGcm(
  keyB64: string,
  plaintext: string,
): Promise<{ iv: string; ciphertext: string }> {
  const keyBytes = decodeKey32(keyB64, 'TOKEN_ENCRYPTION_KEY');
  const key = await crypto.subtle.importKey('raw', asBufferSource(keyBytes), 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBufferSource(iv) }, key, encoder.encode(plaintext));
  return { iv: bytesToB64(iv), ciphertext: bytesToB64(new Uint8Array(ct)) };
}

export async function decryptAesGcm(keyB64: string, ivB64: string, ciphertextB64: string): Promise<string> {
  const keyBytes = decodeKey32(keyB64, 'TOKEN_ENCRYPTION_KEY');
  const key = await crypto.subtle.importKey('raw', asBufferSource(keyBytes), 'AES-GCM', false, ['decrypt']);
  const iv = b64ToBytes(ivB64);
  const ct = b64ToBytes(ciphertextB64);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBufferSource(iv) }, key, asBufferSource(ct));
  return decoder.decode(pt);
}

async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: asBufferSource(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt);
  return { hash: bytesToB64(hash), salt: bytesToB64(salt) };
}

export async function verifyPassword(password: string, hashB64: string, saltB64: string): Promise<boolean> {
  const salt = b64ToBytes(saltB64);
  const expected = b64ToBytes(hashB64);
  const actual = await pbkdf2(password, salt);
  return timingSafeEqual(actual, expected);
}

export function sessionSigningKey(b64: string): Uint8Array {
  return decodeKey32(b64, 'SESSION_SIGNING_KEY');
}

export function randomHex(nBytes: number): string {
  return bytesToHex(randomBytes(nBytes));
}

export function jitteredDelayMs(baseMs: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const r = buf[0]! / 2 ** 32;
  return Math.floor(baseMs * (0.5 + r));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
