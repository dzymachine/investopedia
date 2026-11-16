import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, isEncrypted, signSession, verifySession, safeEqual } from '../lib/secure.js';

test('tokens round-trip through encryption and fail with the wrong key', () => {
  const c = encrypt('access-sandbox-123', 'k'.repeat(32));
  assert.ok(isEncrypted(c));
  assert.ok(!c.includes('access-sandbox'));
  assert.equal(decrypt(c, 'k'.repeat(32)), 'access-sandbox-123');
  assert.throws(() => decrypt(c, 'x'.repeat(32)));
  assert.throws(() => decrypt(c, ''), /TOKEN_KEY/);
  assert.equal(decrypt('plain-token', ''), 'plain-token');
});

test('sessions verify, expire, and reject tampering', () => {
  const s = 's'.repeat(32);
  const tok = signSession({ sub: 'owner', exp: 2000 }, s);
  assert.equal(verifySession(tok, s, 1000).sub, 'owner');
  assert.equal(verifySession(tok, s, 3000), null);
  assert.equal(verifySession(tok, 'other'.repeat(8), 1000), null);
  const [, sig] = tok.split('.');
  const forged = `${Buffer.from(JSON.stringify({ sub: 'owner', exp: 9e15 })).toString('base64url')}.${sig}`;
  assert.equal(verifySession(forged, s, 1000), null);
  assert.equal(verifySession('garbage', s), null);
  assert.equal(verifySession(undefined, s), null);
});

test('safeEqual compares regardless of length', () => {
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abcd'));
});
