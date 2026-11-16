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

test('recordSnapshot stores daily entries sorted by date and updates same-day value', () => {
  const store = memoryStore();
  recordSnapshot('2026-11-14', { value: 1000, invested: 800, cash: 200, costBasis: 750, unrealized: 50 }, store);
  recordSnapshot('2026-11-16', { value: 1100, invested: 900, cash: 200, costBasis: 750, unrealized: 150 }, store);
  recordSnapshot('2026-11-15', { value: 1050, invested: 850, cash: 200, costBasis: 750, unrealized: 100 }, store);
  const updated = recordSnapshot('2026-11-16', { value: 1125.5, invested: 925.5, cash: 200, costBasis: 750, unrealized: 175.5 }, store);

  assert.equal(updated.length, 3);
  assert.deepEqual(updated.map((s) => s.date), ['2026-11-14', '2026-11-15', '2026-11-16']);
  assert.equal(updated[2].value, 1125.5);
});

test('demoHistory generates 30 sorted daily points ending on asOf with exact final value', () => {
  const series = demoHistory('2026-11-16', { value: 50000, cash: 2000, costBasis: 40000 });
  assert.equal(series.length, 30);
  assert.equal(series[29].date, '2026-11-16');
  assert.equal(series[29].value, 50000);
  assert.ok(series.every((s, i) => i === 0 || s.date > series[i - 1].date));
});
