// Encryption for stored Plaid tokens and HMAC-signed session cookies.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PREFIX = 'enc:v1:';
const keyFrom = (secret) => createHash('sha256').update(String(secret)).digest();

export function encrypt(plain, secret) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export const isEncrypted = (v) => typeof v === 'string' && v.startsWith(PREFIX);

export function decrypt(value, secret) {
  if (!isEncrypted(value)) return value;
  if (!secret) throw new Error('A stored token is encrypted but TOKEN_KEY is not set.');
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  const d = createDecipheriv('aes-256-gcm', keyFrom(secret), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const mac = (data, secret) => createHmac('sha256', secret).update(data).digest();

export function signSession(payload, secret) {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${b64u(mac(body, secret))}`;
}

// Returns the payload if the signature is valid and it hasn't expired, else null.
export function verifySession(token, secret, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = mac(body, secret);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && payload.exp > now ? payload : null;
  } catch { return null; }
}

export function safeEqual(a, b) {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
}
