// Boots the server in hosted mode (demo data) and checks the sign-in gate from outside.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signSession } from '../lib/secure.js';

const PORT = 3600 + Math.floor(Math.random() * 300);
const ORIGIN = `http://localhost:${PORT}`;
const SECRET = 'test-session-secret-0123456789-abcdef';
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-test-'));
let proc;

const get = (path, opts = {}) => fetch(ORIGIN + path, { redirect: 'manual', ...opts });
const post = (path, body, headers = {}) => get(path, {
  method: 'POST', body: JSON.stringify(body ?? {}),
  headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
});

before(async () => {
  proc = spawn(process.execPath, ['server.js'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, DEMO: '1', PORT: String(PORT), PUBLIC_ORIGIN: ORIGIN, DATA_DIR: dataDir,
      SESSION_SECRET: SECRET, SETUP_CODE: 'correct-setup-code-1234', TOKEN_KEY: 'token-key-0123456789abcdef-0123456789' },
    stdio: 'pipe',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${ORIGIN}/auth/status`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
after(() => { proc?.kill(); rmSync(dataDir, { recursive: true, force: true }); });

test('portfolio data and the app need a session', async () => {
  const api = await get('/api/portfolio');
  assert.equal(api.status, 401);
  const page = await get('/');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login.html');
  assert.equal((await get('/app.js')).status, 302);
});

test('login page and its assets are public', async () => {
  for (const p of ['/login.html', '/login.js', '/styles.css', '/vendor/webauthn.js', '/img/dark-wood.jpg']) {
    assert.equal((await get(p)).status, 200, p);
  }
  assert.deepEqual(await (await get('/auth/status')).json(), { registered: false, signedIn: false });
});

test('a valid session cookie unlocks the API; a forged one does not', async () => {
  const good = signSession({ sub: 'owner', v: 1, exp: Date.now() + 60_000 }, SECRET);
  const ok = await get('/api/portfolio', { headers: { Cookie: `session=${good}` } });
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).totals.value > 0);
  const bad = signSession({ sub: 'owner', v: 1, exp: Date.now() + 60_000 }, 'wrong-secret-wrong-secret-wrong-secret');
  assert.equal((await get('/api/portfolio', { headers: { Cookie: `session=${bad}` } })).status, 401);
});

test('wrong host and cross-site POSTs are refused', async () => {
  // fetch can't override Host, so use a raw request.
  const status = await new Promise((ok, fail) => {
    request({ host: '127.0.0.1', port: PORT, path: '/auth/status', headers: { Host: 'evil.example' } }, (r) => { r.resume(); ok(r.statusCode); })
      .on('error', fail).end();
  });
  assert.equal(status, 403);
  assert.equal((await post('/auth/register/options', { setupCode: 'x' }, { Origin: 'https://evil.example' })).status, 403);
});

test('first passkey needs the setup code, and guesses are capped', async () => {
  assert.equal((await post('/auth/register/options', { setupCode: 'wrong' })).status, 403);
  const ok = await post('/auth/register/options', { setupCode: 'correct-setup-code-1234' });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.ok(body.challengeId && body.options.challenge);
  for (let i = 0; i < 5; i++) await post('/auth/register/options', { setupCode: 'wrong' });
  assert.equal((await post('/auth/register/options', { setupCode: 'correct-setup-code-1234' })).status, 429);
});

test('a forged registration response is rejected', async () => {
  const r = await post('/auth/register/verify', { challengeId: 'nope', response: {} });
  assert.equal(r.status, 400);
  assert.deepEqual(await (await get('/auth/status')).json(), { registered: false, signedIn: false });
});

test('a malformed cookie does not crash the server', async () => {
  const r = await post('/auth/register/options', {}, { Cookie: 'x=%' });
  assert.ok([403, 429].includes(r.status));
  assert.equal((await get('/auth/status', { headers: { Cookie: 'x=%; y=%E0%A4%A' } })).status, 200);
});

test('signing out ends every existing session', async () => {
  const tok = signSession({ sub: 'owner', v: 1, exp: Date.now() + 60_000 }, SECRET);
  const cookie = { Cookie: `session=${tok}` };
  assert.equal((await get('/api/portfolio', { headers: cookie })).status, 200);
  assert.equal((await post('/auth/logout', {}, cookie)).status, 200);
  assert.equal((await get('/api/portfolio', { headers: cookie })).status, 401);
});
