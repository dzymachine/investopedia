import test from 'node:test';
import assert from 'node:assert/strict';
import { recordSnapshot, backfillHistory, demoHistory } from '../lib/history.js';

function memoryStore(initial = { snapshots: [] }) {
  const files = new Map([['history.json', initial]]);
  return {
    read: (name, fallback) => files.get(name) ?? fallback,
    write: (name, value) => { files.set(name, value); },
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

test('backfillHistory reconstructs past daily values from transactions and prices without overwriting live snapshots', async () => {
  const store = memoryStore({
    snapshots: [
      { date: '2026-11-15', value: 9999, invested: 9999, cash: 0, accounts: {}, institutions: {}, holdings: {} },
    ],
  });
  const items = [{
    institution: 'Charles Schwab',
    holdings: {
      accounts: [{ account_id: 'sch1', name: 'Individual' }],
      securities: [{ security_id: 'vti', ticker_symbol: 'VTI', name: 'VTI', type: 'etf', is_cash_equivalent: false }],
      holdings: [{ account_id: 'sch1', security_id: 'vti', quantity: 10, institution_price: 300, institution_value: 3000 }],
    },
    transactions: [
      { account_id: 'sch1', security_id: 'vti', date: '2026-11-14', type: 'buy', quantity: 5, price: 290 },
    ],
  }];
  const portfolio = {
    totals: { costBasis: 2500 },
    accounts: [{ institution: 'Charles Schwab', accountId: 'sch1', name: 'Individual' }],
  };
  const fetcher = async () => ({
    '2026-11-13': 280,
    '2026-11-14': 290,
    '2026-11-15': 295,
    '2026-11-16': 300,
  });

  const snaps = await backfillHistory('2026-11-16', items, portfolio, {
    days: 4,
    read: store.read,
    write: store.write,
    fetcher,
  });

  assert.equal(snaps.length, 3); // 11-13, 11-14, 11-15 (11-16 is recorded by recordSnapshot)
  assert.equal(snaps[0].date, '2026-11-13');
  assert.equal(snaps[0].value, 5 * 280); // before 11-14 buy of 5 shares, held 5 shares
  assert.equal(snaps[1].date, '2026-11-14');
  assert.equal(snaps[1].value, 10 * 290); // on 11-14 after buy, held 10 shares
  assert.equal(snaps[2].date, '2026-11-15');
  assert.equal(snaps[2].value, 9999); // existing live snapshot preserved
});
