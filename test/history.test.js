import test from 'node:test';
import assert from 'node:assert/strict';
import { recordSnapshot, demoHistory } from '../lib/history.js';

function memoryStore(initial = { snapshots: [] }) {
  let state = initial;
  return {
    read: () => state,
    write: (_name, value) => { state = value; },
  };
}

test('recordSnapshot stores daily portfolio, account, institution, and holding entries', () => {
  const store = memoryStore();
  const makePortfolio = (vtiPrice) => ({
    totals: { value: 10 * vtiPrice + 200, invested: 10 * vtiPrice, cash: 200, costBasis: 2500, unrealized: 10 * vtiPrice - 2500 },
    accounts: [{ institution: 'Charles Schwab', accountId: 'a1', name: 'Roth IRA', value: 10 * vtiPrice + 200 }],
    byInstitution: [{ name: 'Charles Schwab', value: 10 * vtiPrice + 200 }],
    holdings: [{ key: 'VTI', ticker: 'VTI', name: 'Vanguard Total Stock', value: 10 * vtiPrice, price: vtiPrice }],
  });

  recordSnapshot('2026-11-14', makePortfolio(280), store);
  recordSnapshot('2026-11-16', makePortfolio(290), store);
  recordSnapshot('2026-11-15', makePortfolio(285), store);
  const updated = recordSnapshot('2026-11-16', makePortfolio(295), store);

  assert.equal(updated.length, 3);
  assert.deepEqual(updated.map((s) => s.date), ['2026-11-14', '2026-11-15', '2026-11-16']);
  assert.equal(updated[2].value, 3150);
  assert.equal(updated[2].accounts['Charles Schwab::a1'].value, 3150);
  assert.equal(updated[2].institutions['Charles Schwab'], 3150);
  assert.equal(updated[2].holdings.VTI.price, 295);
  assert.equal(updated[2].holdings.VTI.value, 2950);
});

test('demoHistory generates 30 sorted daily points with account and holding breakdown', () => {
  const series = demoHistory('2026-11-16', {
    totals: { value: 50000, cash: 2000, costBasis: 40000 },
    accounts: [{ institution: 'Robinhood', accountId: 'rh1', name: 'Individual', value: 50000 }],
    byInstitution: [{ name: 'Robinhood', value: 50000 }],
    holdings: [{ key: 'AAPL', ticker: 'AAPL', name: 'Apple Inc.', value: 48000, price: 240 }],
  });
  assert.equal(series.length, 30);
  assert.equal(series[29].date, '2026-11-16');
  assert.equal(series[29].value, 50000);
  assert.equal(series[29].accounts['Robinhood::rh1'].value, 50000);
  assert.equal(series[29].holdings.AAPL.price, 240);
  assert.ok(series.every((s, i) => i === 0 || s.date > series[i - 1].date));
});
