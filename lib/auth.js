// Single-user passkey sign-in. The first passkey needs SETUP_CODE; later ones need a signed-in session.
import express from 'express';
import { randomBytes } from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { signSession, verifySession, safeEqual } from './secure.js';
import { readJson, writeJson } from './store.js';

const SESSION_DAYS = 30;
const CHALLENGE_MS = 5 * 60_000;
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 20;     // auth POSTs per IP per window
const MAX_SETUP_FAILS = 5;   // wrong setup codes per window, all IPs combined

const cookieName = (secure) => (secure ? '__Host-session' : 'session');

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip malformed */ }
  }
  return out;
}

export function createAuth({ origin, rpName = 'Portfolio', setupCode, sessionSecret }) {
  const url = new URL(origin);
  const rpID = url.hostname;
  const secure = url.protocol === 'https:';
  const COOKIE = cookieName(secure);
  const challenges = new Map(); // id -> { challenge, kind, exp }
  const attempts = new Map();   // ip -> { n, reset }
  let setupFails = { n: 0, reset: 0 };

  // passkeys.json holds the credentials plus a session version; bumping it signs out every device.
  const file = () => readJson('passkeys.json', { credentials: [], version: 1 });
  const creds = () => file().credentials;
  const saveCreds = (list) => writeJson('passkeys.json', { ...file(), credentials: list });

  const session = (req) => {
    const s = verifySession(parseCookies(req.headers.cookie)[COOKIE], sessionSecret);
    return s && s.v === (file().version ?? 1) ? s : null;
  };
  const setCookie = (res, value, maxAge) => res.append('Set-Cookie',
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  const signIn = (res) => setCookie(res,
    signSession({ sub: 'owner', v: file().version ?? 1, exp: Date.now() + SESSION_DAYS * 86_400_000 }, sessionSecret), SESSION_DAYS * 86_400);
  // Async route wrapper: errors become a 500 instead of an unhandled rejection that kills the process.
  const safe = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error('[auth]', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Try again.' });
  });

  const putChallenge = (kind, challenge) => {
    const now = Date.now();
    for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k);
    const id = randomBytes(16).toString('base64url');
    challenges.set(id, { challenge, kind, exp: now + CHALLENGE_MS });
    return id;
  };
  const takeChallenge = (id, kind) => {
    const c = challenges.get(id);
    challenges.delete(id);
    return c && c.kind === kind && c.exp > Date.now() ? c.challenge : null;
  };

  const limit = (req, res, next) => {
    const now = Date.now();
    const a = attempts.get(req.ip) ?? { n: 0, reset: now + WINDOW_MS };
    if (a.reset < now) { a.n = 0; a.reset = now + WINDOW_MS; }
    a.n += 1;
    attempts.set(req.ip, a);
    if (a.n > MAX_ATTEMPTS) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    next();
  };

  const router = express.Router();
  router.use(express.json({ limit: '20kb' }));

  router.get('/status', (req, res) => {
    res.json({ registered: creds().length > 0, signedIn: !!session(req) });
  });

  router.post('/register/options', limit, safe(async (req, res) => {
    const list = creds();
    const signedIn = !!session(req);
    if (!signedIn) {
      if (list.length) return res.status(403).json({ error: 'Sign in first to add another passkey.' });
      if (!setupCode) return res.status(403).json({ error: 'Setup is turned off. Set SETUP_CODE to create the first passkey.' });
      const now = Date.now();
      if (setupFails.reset < now) setupFails = { n: 0, reset: now + WINDOW_MS };
      if (setupFails.n >= MAX_SETUP_FAILS) return res.status(429).json({ error: 'Too many wrong setup codes. Try again in 15 minutes.' });
      if (typeof req.body?.setupCode !== 'string' || !safeEqual(req.body.setupCode.trim(), setupCode)) {
        setupFails.n += 1;
        return res.status(403).json({ error: 'That setup code is not right.' });
      }
    }
    const options = await generateRegistrationOptions({
      rpName, rpID, userName: 'owner', userDisplayName: 'Owner',
      userID: new TextEncoder().encode('owner'),
      attestationType: 'none',
      excludeCredentials: list.map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    res.json({ challengeId: putChallenge('register', options.challenge), options });
  }));

  router.post('/register/verify', limit, safe(async (req, res) => {
    const list = creds();
    if (list.length && !session(req)) return res.status(403).json({ error: 'Sign in first to add another passkey.' });
    const expectedChallenge = takeChallenge(req.body?.challengeId, 'register');
    if (!expectedChallenge) return res.status(400).json({ error: 'This request expired. Start again.' });
    try {
      const { verified, registrationInfo } = await verifyRegistrationResponse({
        response: req.body.response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID,
        requireUserVerification: true,
      });
      if (!verified) return res.status(400).json({ error: 'The passkey could not be verified.' });
      const { credential } = registrationInfo;
      list.push({
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports ?? [],
        name: String(req.body.name || 'Passkey').slice(0, 60),
        added: new Date().toISOString(),
      });
      saveCreds(list);
      signIn(res);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: 'The passkey could not be verified.' });
    }
  }));

  router.post('/login/options', limit, safe(async (_req, res) => {
    const list = creds();
    if (!list.length) return res.status(400).json({ error: 'No passkey is set up yet.' });
    const options = await generateAuthenticationOptions({
      rpID, userVerification: 'required',
      allowCredentials: list.map((c) => ({ id: c.id, transports: c.transports })),
    });
    res.json({ challengeId: putChallenge('login', options.challenge), options });
  }));

  router.post('/login/verify', limit, safe(async (req, res) => {
    const expectedChallenge = takeChallenge(req.body?.challengeId, 'login');
    if (!expectedChallenge) return res.status(400).json({ error: 'This request expired. Start again.' });
    const list = creds();
    const cred = list.find((c) => c.id === req.body?.response?.id);
    if (!cred) return res.status(400).json({ error: 'That passkey is not registered here.' });
    try {
      const { verified, authenticationInfo } = await verifyAuthenticationResponse({
        response: req.body.response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID,
        requireUserVerification: true,
        credential: { id: cred.id, publicKey: Buffer.from(cred.publicKey, 'base64url'), counter: cred.counter, transports: cred.transports },
      });
      if (!verified) return res.status(401).json({ error: 'Sign-in failed.' });
      cred.counter = authenticationInfo.newCounter;
      cred.lastUsed = new Date().toISOString();
      saveCreds(list);
      signIn(res);
      res.json({ ok: true });
    } catch (err) {
      res.status(401).json({ error: 'Sign-in failed.' });
    }
  }));

  // Signing out ends every session on every device (one user, so this is the simple safe choice).
  router.post('/logout', (req, res) => {
    if (session(req)) { const f = file(); writeJson('passkeys.json', { ...f, version: (f.version ?? 1) + 1 }); }
    setCookie(res, '', 0);
    res.json({ ok: true });
  });

  // Gate for everything that isn't the login page or its assets.
  const requireAuth = (req, res, next) => {
    if (session(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in required.', code: 'AUTH' });
    if (req.method === 'GET') return res.redirect(302, '/login.html');
    return res.status(401).end();
  };

  // Cross-site request guard for state-changing calls.
  const sameOrigin = (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    return req.headers.origin === origin ? next() : res.status(403).json({ error: 'Cross-site request blocked.' });
  };

  return { router, requireAuth, sameOrigin };
}
