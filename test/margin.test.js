import test from 'node:test';
import assert from 'node:assert/strict';
import { addMarginEntry, deleteMarginEntry, summarizeMargin } from '../lib/margin.js';

function memoryStore(initial = { entries: [] }) {
  const files = new Map([['margin.json', initial]]);
  return {
    read: (name, fallback) => files.get(name) ?? fallback,
    write: (name, value) => { files.set(name, value); },
  };
}

test('addMarginEntry, deleteMarginEntry, and summarizeMargin track bought, repaid, and interest', () => {
  const store = memoryStore();
  const e1 = addMarginEntry({ date: '2026-10-01', kind: 'buy', amount: 2000, institution: 'Robinhood', account: 'Individual', ticker: 'NVDA' }, store);
  const e2 = addMarginEntry({ date: '2026-10-15', kind: 'repay', amount: 750, institution: 'Robinhood', account: 'Individual' }, store);
  const e3 = addMarginEntry({ date: '2026-11-01', kind: 'interest', amount: 14.5, institution: 'Robinhood', account: 'Individual' }, store);

  let summary = summarizeMargin(store.read('margin.json').entries);
  assert.equal(summary.totalBought, 2000);
  assert.equal(summary.totalRepaid, 750);
  assert.equal(summary.totalInterest, 14.5);
  assert.equal(summary.trackedBalance, 1250);
  assert.equal(summary.currentBalance, 1250);
  assert.equal(summary.entries[0].id, e3.id);

  assert.equal(deleteMarginEntry(e2.id, store), true);
  assert.equal(deleteMarginEntry('missing-id', store), false);

  summary = summarizeMargin(store.read('margin.json').entries);
  assert.equal(summary.totalRepaid, 0);
  assert.equal(summary.currentBalance, 2000);
  assert.ok(e1.id);
});

test('summarizeMargin detects negative cash (broker margin debit)', () => {
  const portfolio = {
    accounts: [
      { institution: 'Robinhood', name: 'Individual', cash: -1450.25 },
      { institution: 'Charles Schwab', name: 'Individual', cash: 3200 },
    ],
  };
  const summary = summarizeMargin([], portfolio, []);
  assert.equal(summary.brokerMarginDebit, 1450.25);
  assert.equal(summary.currentBalance, 1450.25);
  assert.equal(summary.brokerAccounts.length, 1);
  assert.equal(summary.brokerAccounts[0].debit, 1450.25);
});
