// Read-only Kraken source. Turns balances, prices and trade history into the same
// shape Plaid Investments returns, so lib/portfolio.js treats it like any other account.
import { createHash, createHmac } from 'node:crypto';

const API = 'https://api.kraken.com';
const CACHE_MS = 10 * 60_000;
const NAMES = {
  BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', ADA: 'Cardano', DOT: 'Polkadot', XRP: 'XRP', DOGE: 'Dogecoin',
  LTC: 'Litecoin', AVAX: 'Avalanche', LINK: 'Chainlink', MATIC: 'Polygon', POL: 'Polygon', ATOM: 'Cosmos', USDC: 'USD Coin', USDT: 'Tether',
};
const FIAT = new Set(['USD']);
const STABLE = new Set(['USDC', 'USDT', 'DAI', 'PYUSD', 'USDG']);
const USD_QUOTES = new Set(['ZUSD', 'USD', 'USDC', 'USDT']);

// Kraken's documented signature: HMAC-SHA512(path + SHA256(nonce + body)) keyed by the base64-decoded secret.
export function sign(path, nonce, body, secret) {
  const hash = createHash('sha256').update(nonce + body).digest();
  return createHmac('sha512', Buffer.from(secret, 'base64')).update(Buffer.concat([Buffer.from(path), hash])).digest('base64');
}

// Kraken asset codes → plain tickers. XXBT→BTC, XETH→ETH, ZUSD→USD, SOL.F (earn) → SOL.
export function normalizeAsset(code, assets = {}) {
  const base = String(code).split('.')[0];
  const alt = assets[base]?.altname ?? base.replace(/^[XZ](?=[A-Z]{3}$)/, '');
  return alt === 'XBT' ? 'BTC' : alt === 'XDG' ? 'DOGE' : alt;
}

const dateIn = (unixSeconds) => new Date(unixSeconds * 1000).toLocaleDateString('en-CA');

/** Pure: Kraken API payloads → Plaid-shaped item. */
export function toItem({ balances, assets, pairs, tickers, trades }) {
  const qty = new Map();
  for (const [code, amount] of Object.entries(balances)) {
    const n = Number(amount);
    if (!(n > 0)) continue;
    const sym = normalizeAsset(code, assets);
    qty.set(sym, (qty.get(sym) ?? 0) + n);
  }

  // USD price per symbol from the ticker of its USD pair.
  const priceOf = new Map([['USD', 1]]);
  for (const [pairName, p] of Object.entries(pairs)) {
    if (p.quote !== 'ZUSD' && p.quote !== 'USD') continue;
    const t = tickers[pairName] ?? tickers[p.altname];
    if (t) priceOf.set(normalizeAsset(p.base, assets), Number(t.c[0]));
  }
  for (const s of STABLE) if (!priceOf.has(s)) priceOf.set(s, 1);

  const securities = [];
  const holdings = [];
  const unpriced = [];
  for (const [sym, n] of qty) {
    const cash = FIAT.has(sym) || STABLE.has(sym);
    const price = priceOf.get(sym);
    if (price == null) { unpriced.push(sym); continue; }
    securities.push({ security_id: `kraken-${sym}`, ticker_symbol: cash ? `CUR:${sym}` : sym, name: NAMES[sym] ?? sym,
      type: cash ? 'cash' : 'cryptocurrency', is_cash_equivalent: cash, close_price: price });
    holdings.push({ account_id: 'kraken', security_id: `kraken-${sym}`, quantity: n,
      institution_price: price, institution_value: n * price, cost_basis: null });
  }

  // Trades quoted in USD or a USD stablecoin become buys and sells with a USD basis.
  const transactions = [];
  let skipped = 0;
  for (const t of Object.values(trades)) {
    const p = pairs[t.pair] ?? Object.values(pairs).find((x) => x.altname === t.pair);
    if (!p || !USD_QUOTES.has(p.quote)) { skipped += 1; continue; }
    const sym = normalizeAsset(p.base, assets);
    const vol = Number(t.vol), cost = Number(t.cost), fee = Number(t.fee);
    const buy = t.type === 'buy';
    transactions.push({
      account_id: 'kraken', security_id: `kraken-${sym}`, date: dateIn(t.time), type: buy ? 'buy' : 'sell',
      quantity: buy ? vol : -vol, price: Number(t.price), fees: fee, amount: buy ? cost + fee : -(cost - fee),
    });
  }

  const warnings = [];
  if (unpriced.length) warnings.push(`no USD price for ${unpriced.join(', ')}, so they are left out`);
  if (skipped) warnings.push(`${skipped} trades priced in another currency or crypto were skipped, so some cost basis is unknown`);
  const first = transactions.map((t) => t.date).sort()[0] ?? null;

  return {
    holdings: { accounts: [{ account_id: 'kraken', name: 'Kraken', mask: null }], securities, holdings },
    transactions,
    historyStart: first,
    warning: warnings.length ? warnings.join('; ') : null,
  };
}

export function createKraken({ key, secret, fetchImpl = fetch }) {
  let lastNonce = 0;
  let cache = null;

  async function pub(path) {
    const res = await fetchImpl(API + path);
    const body = await res.json();
    if (body.error?.length) throw new Error(body.error.join(', '));
    return body.result;
  }

  async function priv(method, params = {}) {
    const path = `/0/private/${method}`;
    lastNonce = Math.max(Date.now() * 1000, lastNonce + 1);
    const body = new URLSearchParams({ nonce: String(lastNonce), ...params }).toString();
    const res = await fetchImpl(API + path, {
      method: 'POST', body,
      headers: { 'API-Key': key, 'API-Sign': sign(path, String(lastNonce), body, secret), 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const out = await res.json();
    if (out.error?.length) throw new Error(out.error.join(', '));
    return out.result;
  }

  async function allTrades() {
    const trades = {};
    let total = Infinity;
    for (let ofs = 0, page = 0; ofs < total; page += 1) {
      if (page >= 5) await new Promise((r) => setTimeout(r, 6000)); // stay under Kraken's private rate limit
      const r = await priv('TradesHistory', { ofs: String(ofs) });
      Object.assign(trades, r.trades);
      total = r.count;
      const got = Object.keys(r.trades).length;
      if (!got) break;
      ofs += got;
    }
    return trades;
  }

  return {
    async fetchItem({ fresh = false } = {}) {
      if (!fresh && cache && cache.at > Date.now() - CACHE_MS) return cache.item;
      const base = { itemId: 'kraken-direct', institution: 'Kraken', source: 'kraken' };
      try {
        const [balances, assets, pairs] = await Promise.all([priv('Balance'), pub('/0/public/Assets'), pub('/0/public/AssetPairs')]);
        const trades = await allTrades();
        const held = new Set(Object.keys(balances).map((c) => normalizeAsset(c, assets)));
        const usdPairs = Object.entries(pairs)
          .filter(([, p]) => (p.quote === 'ZUSD' || p.quote === 'USD') && held.has(normalizeAsset(p.base, assets)))
          .map(([name]) => name);
        const tickers = usdPairs.length ? await pub(`/0/public/Ticker?pair=${usdPairs.join(',')}`) : {};
        const { warning, ...rest } = toItem({ balances, assets, pairs, tickers, trades });
        const item = { ...base, ...rest, error: warning };
        cache = { at: Date.now(), item };
        return item;
      } catch (err) {
        const msg = /Permission denied/i.test(err.message)
          ? 'the API key is missing a permission. It needs Query Funds and Query Closed Orders & Trades.'
          : /Invalid key|Invalid signature/i.test(err.message) ? 'the API key or secret is wrong.' : `could not load (${err.message}).`;
        return { ...base, holdings: null, transactions: [], error: msg };
      }
    },
  };
}
