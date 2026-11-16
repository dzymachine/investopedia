import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, longTermOn, estimateTax, buildLots } from '../lib/portfolio.js';
import { demoItems } from '../lib/demo.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test('long-term starts the day after the one-year anniversary', () => {
  assert.equal(longTermOn('2025-03-10'), '2026-03-11');
  assert.equal(longTermOn('2024-02-29'), '2025-03-02');
  assert.equal(longTermOn('2025-12-31'), '2027-01-01');
});

test('tax netting offsets losses across terms', () => {
  close(estimateTax(1000, 2000, 0.3, 0.15).total, 600);
  close(estimateTax(-500, 2000, 0.3, 0.15).total, 225);
  close(estimateTax(1000, -400, 0.3, 0.15).total, 180);
  close(estimateTax(-1000, -400, 0.3, 0.15).total, 0);
});

test('FIFO sells consume oldest lots and classify realized term', () => {
  const realized = {};
  const lots = buildLots([
    { date: '2024-01-02', type: 'buy', quantity: 10, price: 100, amount: 1000 },
    { date: '2025-06-01', type: 'buy', quantity: 10, price: 200, amount: 2000 },
    { date: '2025-09-01', type: 'sell', quantity: -15, price: 300, amount: -4500 },
  ], realized);
  close(realized['2025'].long, 10 * 300 - 1000);
  close(realized['2025'].short, 5 * 300 - 1000);
  assert.equal(lots.length, 1);
  close(lots[0].quantity, 5);
  close(lots[0].cost, 1000);
});

test('shares older than the history window become a long-term lot using broker cost basis', () => {
  const items = [{
    institution: 'Broker', historyStart: '2024-11-01',
    holdings: {
      accounts: [{ account_id: 'a', name: 'Brokerage' }],
      securities: [{ security_id: 's', ticker_symbol: 'XYZ', name: 'XYZ', type: 'equity' }],
      holdings: [{ account_id: 'a', security_id: 's', quantity: 15, institution_price: 50, institution_value: 750, cost_basis: 500 }],
    },
    transactions: [{ account_id: 'a', security_id: 's', date: '2026-06-01', type: 'buy', quantity: 5, price: 40, amount: 200 }],
  }];
  const r = analyze(items, { asOf: '2026-11-03', stRate: 0.3, ltRate: 0.15 });
  const old = r.lots.find((l) => !l.acquired);
  const recent = r.lots.find((l) => l.acquired);
  close(old.quantity, 10); close(old.costBasis, 300); assert.equal(old.term, 'long');
  assert.equal(recent.term, 'short'); assert.equal(recent.longTermOn, '2027-06-02');
  close(r.totals.unrealized, 250);
  assert.ok(r.warnings.length);
});

const oneAccount = (holdings, transactions) => [{
  institution: 'Broker', historyStart: '2024-11-03',
  holdings: {
    accounts: [{ account_id: 'a', name: 'Brokerage' }],
    securities: [{ security_id: 's', ticker_symbol: 'XYZ', name: 'XYZ', type: 'equity' }],
    holdings,
  },
  transactions: transactions.map((t) => ({ account_id: 'a', security_id: 's', ...t })),
}];

test('sales of a position that was sold out completely still count as realized', () => {
  const r = analyze(oneAccount([], [
    { date: '2026-01-05', type: 'buy', quantity: 10, price: 100, amount: 1000 },
    { date: '2026-03-10', type: 'sell', quantity: -10, price: 150, amount: -1500 },
  ]), { asOf: '2026-11-03', stRate: 0.3, ltRate: 0.15 });
  close(r.tax.realizedYtd.short, 500);
  close(r.tax.estimatedOnRealizedYtd.total, 150);
});

test('sells consume shares held before the history window first', () => {
  const r = analyze(oneAccount(
    [{ account_id: 'a', security_id: 's', quantity: 60, institution_price: 130, institution_value: 7800, cost_basis: 6000 }],
    [
      { date: '2026-10-01', type: 'buy', quantity: 10, price: 120, amount: 1200 },
      { date: '2026-10-20', type: 'sell', quantity: -50, price: 130, amount: -6500 },
    ],
  ), { asOf: '2026-11-03', stRate: 0.3, ltRate: 0.15 });
  close(r.tax.realizedYtd.short, 0);
  close(r.tax.realizedYtd.unknownBasisProceeds, 6500);
  const recent = r.lots.find((l) => l.acquired === '2026-10-01');
  close(recent.quantity, 10); assert.equal(recent.term, 'short');
  const old = r.lots.find((l) => !l.acquired);
  close(old.quantity, 50); close(old.costBasis, 4800); assert.equal(old.term, 'long');
});

test('cash counts toward value but not gains; holdings merge across institutions', () => {
  const r = analyze(demoItems('2026-11-03'), { asOf: '2026-11-03', stRate: 0.32, ltRate: 0.15 });
  close(r.totals.cash, 4210.55);
  const aapl = r.holdings.find((h) => h.ticker === 'AAPL');
  close(aapl.quantity, 45);
  assert.deepEqual(aapl.institutions.sort(), ['Charles Schwab', 'Robinhood']);
  close(r.totals.value, r.byInstitution.reduce((s, i) => s + i.value, 0));
  assert.ok(r.lots.every((l) => l.ticker !== 'CUR:USD'));
  assert.ok(r.tax.upcoming.every((l) => l.term === 'short' && l.gain > 0));
});

test('an institution that failed to load does not break the rest', () => {
  const items = [...demoItems('2026-11-03'), { institution: 'Broken', holdings: null, transactions: [], error: 'login required' }];
  const r = analyze(items, { asOf: '2026-11-03' });
  assert.ok(r.warnings.some((w) => w.includes('Broken')));
});

test('overall: paid vs worth on known-cost holdings plus all realized gains', () => {
  const r = analyze(oneAccount(
    [{ account_id: 'a', security_id: 's', quantity: 10, institution_price: 150, institution_value: 1500, cost_basis: 1000 }],
    [
      { date: '2025-01-05', type: 'buy', quantity: 15, price: 100, amount: 1500 },
      { date: '2025-06-10', type: 'sell', quantity: -5, price: 120, amount: -600 },
    ],
  ), { asOf: '2026-11-03' });
  const o = r.overall;
  close(o.paid, 1000); close(o.worth, 1500); close(o.unrealized, 500);
  close(o.realized, 100); close(o.gain, 600); close(o.gainPct, 0.6);
  assert.equal(o.realizedByYear[0].year, '2025');
  assert.equal(o.unknownCostValue, 0);
});

test('overall: holdings with unknown cost are left out of paid and worth', () => {
  const r = analyze(oneAccount(
    [{ account_id: 'a', security_id: 's', quantity: 10, institution_price: 50, institution_value: 500, cost_basis: null }], [],
  ), { asOf: '2026-11-03' });
  close(r.overall.paid, 0); close(r.overall.worth, 0); close(r.overall.unknownCostValue, 500);
  assert.equal(r.overall.gainPct, null);
});

test('retirement accounts count toward value but never toward tax', () => {
  const items = [{
    institution: 'Guideline', historyStart: '2024-11-03',
    holdings: {
      accounts: [{ account_id: 'k', name: '401(k)', subtype: '401k' }],
      securities: [{ security_id: 'f', ticker_symbol: null, name: 'Target Date 2060 Fund', type: 'mutual fund' }],
      holdings: [{ account_id: 'k', security_id: 'f', quantity: 100, institution_price: 30, institution_value: 3000, cost_basis: 2000 }],
    },
    transactions: [
      { account_id: 'k', security_id: 'f', date: '2026-01-05', type: 'buy', quantity: 120, price: 20, amount: 2400 },
      { account_id: 'k', security_id: 'f', date: '2026-06-01', type: 'sell', quantity: -20, price: 28, amount: -560 },
    ],
  }];
  const r = analyze(items, { asOf: '2026-11-03' });
  close(r.totals.value, 3000);
  close(r.totals.taxShelteredValue, 3000);
  close(r.overall.paid, 2000); close(r.overall.worth, 3000);
  assert.equal(r.lots.length, 0);
  close(r.tax.realizedYtd.short, 0);
  close(r.tax.estimatedIfSoldToday.total, 0);
  assert.equal(r.accounts[0].taxShelter, '401(k)');
  close(r.accounts[0].value, 3000);
});
