import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insights } from '../lib/insights.js';
import { analyze } from '../lib/portfolio.js';
import { demoItems } from '../lib/demo.js';

const zero = { short: 0, long: 0, unknownBasisProceeds: 0 };
const base = (over = {}) => ({
  asOf: '2026-11-03',
  rates: { shortTerm: 0.32, longTerm: 0.15 },
  totals: { value: 100000, cash: 0, invested: 100000 },
  items: [], holdings: [], byInstitution: [], lots: [],
  tax: {
    taxYear: '2026', filingDeadline: '2027-04-15', upcoming: [],
    realizedYtd: zero, estimatedOnRealizedYtd: { total: 0 },
    priorYear: { year: '2025', ...zero, filingDeadline: '2026-04-15' },
  },
  ...over,
});
const ids = (r) => insights(r).map((n) => n.id);
const withTax = (t) => { const b = base(); return { ...b, tax: { ...b.tax, ...t } }; };

test('empty portfolio gives no notes', () => assert.deepEqual(insights(base()), []));

test('long-term soon: fires near, not far or tiny', () => {
  const lot = (days, saved, ticker = 'BTC') => ({ ticker, daysUntilLongTerm: days, taxSavedByWaiting: saved, gain: saved / 0.17, longTermOn: '2026-12-09' });
  const n = insights(withTax({ upcoming: [lot(36, 695)] }));
  assert.equal(n.length, 1);
  assert.equal(n[0].title, 'Wait 36 days on your BTC to save $695');
  assert.equal(n[0].urgency, 'useful');
  assert.equal(insights(withTax({ upcoming: [lot(10, 300)] }))[0].urgency, 'urgent');
  assert.deepEqual(ids(withTax({ upcoming: [lot(90, 900)] })), []);
  assert.deepEqual(ids(withTax({ upcoming: [lot(20, 20)] })), []);
});

test('concentration: fires above 20%, not at or below', () => {
  const h = (w) => [{ key: 'NVDA', ticker: 'NVDA', value: w * 1e5, weight: w }, { key: 'AAPL', ticker: 'AAPL', value: 1, weight: 0.01 }];
  assert.deepEqual(ids(base({ holdings: h(0.25) })), ['concentration-NVDA']);
  assert.equal(insights(base({ holdings: h(0.55) }))[0].urgency, 'urgent');
  assert.deepEqual(ids(base({ holdings: h(0.2) })), []);
});

test('institution share: fires above 50% with more than one account', () => {
  const inst = (w) => [{ name: 'Schwab', value: w * 1e5, weight: w }, { name: 'Kraken', value: 1, weight: 1 - w }];
  assert.deepEqual(ids(base({ byInstitution: inst(0.6) })), ['institution-share']);
  assert.deepEqual(ids(base({ byInstitution: inst(0.5) })), []);
  assert.deepEqual(ids(base({ byInstitution: [{ name: 'Schwab', value: 1e5, weight: 1 }] })), []);
});

test('loss offset: needs losses and realized gains owing tax', () => {
  const lots = [{ gain: -1000, term: 'short' }, { gain: 500, term: 'long' }];
  const gains = { realizedYtd: { ...zero, short: 2000 }, estimatedOnRealizedYtd: { total: 640 } };
  const n = insights({ ...withTax(gains), lots });
  assert.equal(n[0].id, 'loss-offset');
  assert.equal(n[0].title, "Selling losers could cut this year's tax by $320");
  assert.deepEqual(ids({ ...withTax(gains), lots: [{ gain: -100, term: 'short' }] }), []);
  assert.deepEqual(ids({ ...base(), lots }), []);
});

test('reauth: fires only for items that need it', () => {
  const items = [{ itemId: 'a', institution: 'Schwab', needsReauth: true }, { itemId: 'b', institution: 'Kraken', needsReauth: false }];
  const n = insights(base({ items }));
  assert.deepEqual(n.map((x) => x.id), ['reauth-a']);
  assert.equal(n[0].urgency, 'urgent');
});

test('idle cash: needs both share and floor', () => {
  assert.deepEqual(ids(base({ totals: { value: 100000, cash: 15000, invested: 85000 } })), ['idle-cash']);
  assert.deepEqual(ids(base({ totals: { value: 100000, cash: 5000, invested: 95000 } })), []);
  assert.deepEqual(ids(base({ totals: { value: 5000, cash: 900, invested: 4100 } })), []);
});

test('deadline: fires inside the window when that year has sales', () => {
  const sold = { ...zero, short: 100 };
  const n = insights(withTax({ priorYear: { year: '2025', ...sold, filingDeadline: '2026-11-20' } }));
  assert.equal(n[0].id, 'deadline-2025');
  assert.equal(n[0].urgency, 'urgent');
  assert.deepEqual(ids(withTax({ priorYear: { year: '2025', ...zero, filingDeadline: '2026-11-20' } })), []);
  assert.deepEqual(ids(withTax({ priorYear: { year: '2025', ...sold, filingDeadline: '2027-06-01' } })), []);
  assert.deepEqual(ids(withTax({ priorYear: { year: '2025', ...sold, filingDeadline: '2026-10-01' } })), []);
});

test('notes are sorted urgent, useful, fyi', () => {
  const r = base({
    items: [{ itemId: 'a', institution: 'Schwab', needsReauth: true }],
    totals: { value: 100000, cash: 20000, invested: 80000 },
    holdings: [{ key: 'X', ticker: 'X', value: 3e4, weight: 0.3 }],
  });
  assert.deepEqual(insights(r).map((n) => n.urgency), ['urgent', 'useful', 'fyi']);
});

test('demo data produces well-formed notes', () => {
  const asOf = '2026-11-03';
  const r = analyze(demoItems(asOf), { asOf });
  r.items = [];
  for (const n of insights(r)) {
    assert.ok(n.id && n.title && n.body && ['urgent', 'useful', 'fyi'].includes(n.urgency));
    assert.ok(n.details.every((d) => d.length === 2 && typeof d[1] === 'string'));
  }
});
