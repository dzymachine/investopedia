import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, normalizeAsset, toItem, createKraken } from '../lib/kraken.js';
import { analyze } from '../lib/portfolio.js';

test('signature matches the example in Kraken API docs', () => {
  const secret = 'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==';
  const nonce = '1616492376594';
  const body = 'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25';
  assert.equal(sign('/0/private/AddOrder', nonce, body, secret),
    '4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==');
});

test('asset codes normalize to plain tickers', () => {
  const assets = { XXBT: { altname: 'XBT' }, XETH: { altname: 'ETH' }, ZUSD: { altname: 'USD' }, SOL: { altname: 'SOL' } };
  assert.equal(normalizeAsset('XXBT', assets), 'BTC');
  assert.equal(normalizeAsset('XETH', assets), 'ETH');
  assert.equal(normalizeAsset('ZUSD', assets), 'USD');
  assert.equal(normalizeAsset('SOL.F', assets), 'SOL');
  assert.equal(normalizeAsset('XXDG', {}), 'DOGE');
});

const fixture = {
  balances: { XXBT: '0.15', 'XXBT.F': '0.1', XETH: '1.0', ZUSD: '250.00', DUST: '5' },
  assets: { XXBT: { altname: 'XBT' }, XETH: { altname: 'ETH' }, ZUSD: { altname: 'USD' }, DUST: { altname: 'DUST' } },
  pairs: {
    XXBTZUSD: { altname: 'XBTUSD', base: 'XXBT', quote: 'ZUSD' },
    XETHZUSD: { altname: 'ETHUSD', base: 'XETH', quote: 'ZUSD' },
    XETHXXBT: { altname: 'ETHXBT', base: 'XETH', quote: 'XXBT' },
  },
  tickers: { XXBTZUSD: { c: ['100000.0', '1'] }, XETHZUSD: { c: ['3000.0', '1'] } },
  trades: {
    T1: { pair: 'XXBTZUSD', time: Date.parse('2024-03-01T12:00:00Z') / 1000, type: 'buy', price: '60000', cost: '6000', fee: '12', vol: '0.1' },
    T2: { pair: 'XXBTZUSD', time: Date.parse('2026-06-01T12:00:00Z') / 1000, type: 'buy', price: '80000', cost: '8000', fee: '16', vol: '0.1' },
    T3: { pair: 'XETHZUSD', time: Date.parse('2026-02-01T12:00:00Z') / 1000, type: 'buy', price: '2500', cost: '3750', fee: '0', vol: '1.5' },
    T4: { pair: 'XETHZUSD', time: Date.parse('2026-05-01T12:00:00Z') / 1000, type: 'sell', price: '3500', cost: '1750', fee: '5', vol: '0.5' },
    T5: { pair: 'XETHXXBT', time: Date.parse('2026-05-02T12:00:00Z') / 1000, type: 'buy', price: '0.03', cost: '0.003', fee: '0', vol: '0.1' },
  },
};

test('balances, prices and trades become a Plaid-shaped item', () => {
  const item = toItem(fixture);
  const btc = item.holdings.holdings.find((h) => h.security_id === 'kraken-BTC');
  assert.equal(btc.quantity, 0.25);              // spot + earn combined
  assert.equal(btc.institution_value, 25000);
  const usd = item.holdings.securities.find((s) => s.security_id === 'kraken-USD');
  assert.equal(usd.type, 'cash');
  assert.ok(!item.holdings.securities.some((s) => s.ticker_symbol === 'DUST'));
  assert.equal(item.transactions.length, 4);     // ETH/XBT trade skipped
  const sell = item.transactions.find((t) => t.type === 'sell');
  assert.equal(sell.quantity, -0.5);
  assert.equal(sell.amount, -1745);
  assert.match(item.warning, /DUST/);
  assert.match(item.warning, /1 trades/);
  assert.equal(item.historyStart, '2024-03-01');
});

test('Kraken trades produce real lots and realized gains in analyze', () => {
  const item = { itemId: 'kraken-direct', institution: 'Kraken', ...toItem(fixture) };
  const r = analyze([item], { asOf: '2026-11-03', stRate: 0.3, ltRate: 0.15 });
  const btcLots = r.lots.filter((l) => l.ticker === 'BTC');
  assert.deepEqual(btcLots.map((l) => [l.acquired, l.term]).sort(), [[null, 'long'], ['2024-03-01', 'long'], ['2026-06-01', 'short']]);
  assert.equal(r.tax.realizedYtd.short, 0.5 * 3500 - 5 - 0.5 * 2500);
  const btc = r.holdings.find((h) => h.ticker === 'BTC');
  assert.equal(btc.costBasis, null); // 0.05 BTC (staking rewards, deposits) with no trade history has unknown cost
});

test('a bad key surfaces as a readable account error, not a crash', async () => {
  const fetchImpl = async () => ({ json: async () => ({ error: ['EAPI:Invalid key'] }) });
  const item = await createKraken({ key: 'k', secret: Buffer.from('s').toString('base64'), fetchImpl }).fetchItem();
  assert.equal(item.holdings, null);
  assert.match(item.error, /key or secret is wrong/);
});
