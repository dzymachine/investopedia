import express from 'express';
import { join } from 'node:path';
import { analyze } from './lib/portfolio.js';
import { insights } from './lib/insights.js';
import { createPlaid, fetchItem, plaidError } from './lib/plaid.js';
import { loadItems, saveItems } from './lib/store.js';
import { demoItems } from './lib/demo.js';
import { createAuth } from './lib/auth.js';
import { createKraken } from './lib/kraken.js';
import { createUsage, instrument } from './lib/usage.js';
import { recordSnapshot, demoHistory } from './lib/history.js';

const PORT = Number(process.env.PORT) || 3000;
const DEMO = process.env.DEMO === '1';
const rate = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const stRate = rate(process.env.SHORT_TERM_TAX_RATE, 0.32);
const ltRate = rate(process.env.LONG_TERM_TAX_RATE, 0.15);
const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD

const usage = createUsage();
usage.startClock();

let plaid = null;
if (!DEMO) {
  const { PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV = 'sandbox' } = process.env;
  if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
    console.error('Missing PLAID_CLIENT_ID / PLAID_SECRET. Copy .env.example to .env, or run `npm run demo`.');
    process.exit(1);
  }
  plaid = instrument(createPlaid({ clientId: PLAID_CLIENT_ID, secret: PLAID_SECRET, env: PLAID_ENV }), usage);
}

// Optional direct Kraken connection (read-only API key), used alongside or instead of Plaid for Kraken.
const kraken = !DEMO && process.env.KRAKEN_API_KEY && process.env.KRAKEN_API_SECRET
  ? createKraken({ key: process.env.KRAKEN_API_KEY, secret: process.env.KRAKEN_API_SECRET })
  : null;

// Hosted mode: PUBLIC_ORIGIN set (e.g. https://my-ledger.fly.dev). Requires passkey sign-in and encrypted tokens.
const ORIGIN = process.env.PUBLIC_ORIGIN?.replace(/\/$/, '') || null;
let auth = null;
if (ORIGIN) {
  // SETUP_CODE is only needed until the first passkey exists; unset it afterwards.
  const missing = ['SESSION_SECRET', 'TOKEN_KEY'].filter((k) => (process.env[k] ?? '').length < 32);
  if (process.env.SETUP_CODE && process.env.SETUP_CODE.length < 16) missing.push('SETUP_CODE (16+ characters)');
  if (missing.length) {
    console.error(`Hosted mode needs these secrets, each at least 32 characters: ${missing.join(', ')}`);
    process.exit(1);
  }
  process.on('unhandledRejection', (err) => console.error('[unhandled]', err?.message ?? err));
  auth = createAuth({ origin: ORIGIN, setupCode: process.env.SETUP_CODE, sessionSecret: process.env.SESSION_SECRET });
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', ORIGIN ? 1 : false);

// Only answer requests addressed to this app (blocks DNS-rebinding reads of your portfolio).
const allowedHosts = new Set(ORIGIN ? [new URL(ORIGIN).host] : [`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
app.use((req, res, next) => (allowedHosts.has(req.headers.host) ? next() : res.status(403).end()));

app.use((_req, res, next) => {
  res.set({ 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  if (ORIGIN?.startsWith('https:')) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});

const PUBLIC = join(import.meta.dirname, 'public');
if (auth) {
  app.use(auth.sameOrigin);
  app.use('/auth', auth.router);
  for (const f of ['login.html', 'login.js', 'styles.css']) app.get(`/${f}`, (_req, res) => res.sendFile(join(PUBLIC, f)));
  app.use('/img', express.static(join(PUBLIC, 'img')));
  app.get('/vendor/webauthn.js', (_req, res) =>
    res.sendFile(join(import.meta.dirname, 'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js')));
  app.use(auth.requireAuth);
}

app.use(express.json({ limit: '10kb' }));
app.use(express.static(PUBLIC, { index: 'index.html' }));

const fail = (res, err, status = 500) => {
  const e = err?.code ? err : plaidError(err);
  console.error('[error]', e.code, e.message);
  res.status(status).json({ error: e.message, code: e.code });
};

app.get('/api/config', (_req, res) => {
  res.json({ demo: DEMO, env: DEMO ? 'demo' : process.env.PLAID_ENV || 'sandbox', hosted: !!auth });
});

// Link token for adding an account, or for re-authenticating one (update mode) when itemId is given.
app.post('/api/link-token', async (req, res) => {
  if (DEMO) return fail(res, { code: 'DEMO', message: 'Linking is disabled in demo mode.' }, 400);
  try {
    const request = {
      user: { client_user_id: 'local-user' },
      client_name: 'Investment Dashboard',
      country_codes: ['US'],
      language: 'en',
    };
    if (req.body?.itemId) {
      const item = loadItems().find((i) => i.item_id === req.body.itemId);
      if (!item) return fail(res, { code: 'NOT_FOUND', message: 'Unknown account.' }, 404);
      request.access_token = item.access_token;
    } else {
      request.products = ['investments'];
    }
    const { data } = await plaid.linkTokenCreate(request);
    res.json({ linkToken: data.link_token });
  } catch (err) { fail(res, err); }
});

app.post('/api/exchange', async (req, res) => {
  if (DEMO) return fail(res, { code: 'DEMO', message: 'Linking is disabled in demo mode.' }, 400);
  const { publicToken, institution } = req.body ?? {};
  if (typeof publicToken !== 'string') return fail(res, { code: 'BAD_REQUEST', message: 'publicToken required.' }, 400);
  try {
    const { data } = await plaid.itemPublicTokenExchange({ public_token: publicToken });
    const items = loadItems().filter((i) => i.item_id !== data.item_id);
    items.push({
      item_id: data.item_id,
      access_token: data.access_token,
      institution: String(institution?.name || 'Unknown institution').slice(0, 100),
      institution_id: typeof institution?.institution_id === 'string' ? institution.institution_id : null,
      added: new Date().toISOString(),
    });
    saveItems(items);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

app.get('/api/items', (_req, res) => {
  if (DEMO) return res.json(demoItems(today()).map((i) => ({ itemId: i.itemId, institution: i.institution })));
  res.json(loadItems().map((i) => ({ itemId: i.item_id, institution: i.institution, added: i.added })));
});

app.delete('/api/items/:id', async (req, res) => {
  if (DEMO) return fail(res, { code: 'DEMO', message: 'Disabled in demo mode.' }, 400);
  const items = loadItems();
  const item = items.find((i) => i.item_id === req.params.id);
  if (!item) return fail(res, { code: 'NOT_FOUND', message: 'Unknown account.' }, 404);
  try { await plaid.itemRemove({ access_token: item.access_token }); }
  catch (err) { console.error('[warn] itemRemove failed, removing locally anyway:', plaidError(err).message); }
  saveItems(loadItems().filter((i) => i.item_id !== item.item_id)); // re-read: a link may have landed meanwhile
  res.json({ ok: true });
});

// Check whether Plaid supports a brokerage/exchange for Investments before you try to link it.
app.get('/api/institutions', async (req, res) => {
  if (DEMO) return res.json([]);
  const query = String(req.query.q ?? '').slice(0, 100);
  if (!query) return res.json([]);
  try {
    const { data } = await plaid.institutionsSearch({ query, products: ['investments'], country_codes: ['US'] });
    res.json(data.institutions.map((i) => ({ id: i.institution_id, name: i.name, oauth: i.oauth })));
  } catch (err) { fail(res, err); }
});

app.get('/api/portfolio', async (req, res) => {
  const asOf = today();
  try {
    const items = DEMO
      ? demoItems(asOf)
      : await Promise.all([
        ...loadItems().map((item) => fetchItem(plaid, item, asOf)),
        ...(kraken ? [kraken.fetchItem({ fresh: req.query.fresh === '1' })] : []),
      ]);
    if (!DEMO) usage.connections(loadItems().map((i) => ({ itemId: i.item_id, institution: i.institution })));
    const result = analyze(items, { asOf, stRate, ltRate });
    result.items = items.map((i) => ({
      itemId: i.itemId, institution: i.institution, error: i.error ?? null,
      needsReauth: i.errorCode === 'ITEM_LOGIN_REQUIRED',
      removable: i.source !== 'kraken',
    }));
    result.insights = insights(result);
    result.history = DEMO ? demoHistory(asOf, result) : recordSnapshot(asOf, result);
    res.json(result);
  } catch (err) { fail(res, err); }
});

// What running the app costs (estimates from tracked usage and your rates).
app.get('/api/usage', (_req, res) => res.json(usage.report()));
app.put('/api/settings/rates', (req, res) => {
  try { res.json({ rates: usage.setRates(req.body) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.listen(PORT, ORIGIN ? '0.0.0.0' : '127.0.0.1', () => {
  const where = ORIGIN ?? `http://localhost:${PORT}`;
  console.log(`Investment dashboard: ${where}  (${DEMO ? 'demo data' : `Plaid ${process.env.PLAID_ENV || 'sandbox'}`}${auth ? ', passkey sign-in' : ''})`);
});
