import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'usage-test-'));
const { createUsage, instrument, summarize, DEFAULT_RATES } = await import('../lib/usage.js');

test('calls and connections are counted per month, and survive a restart', async () => {
  const now = () => new Date('2026-11-10T12:00:00');
  const u = createUsage({ now });
  const fake = { investmentsHoldingsGet: async () => ({ data: 1 }), itemRemove: async () => { throw new Error('nope'); }, label: 'x' };
  const p = instrument(fake, u);
  await p.investmentsHoldingsGet({});
  await p.investmentsHoldingsGet({});
  await assert.rejects(p.itemRemove({}));
  assert.equal(p.label, 'x');
  u.connections([{ itemId: 'a', institution: 'Schwab' }, { itemId: 'b', institution: 'Robinhood' }]);
  u.connections([{ itemId: 'a', institution: 'Schwab' }]);

  const again = createUsage({ now }).report();
  assert.equal(again.current.month, '2026-11');
  assert.equal(again.current.calls, 3);
  assert.equal(again.current.errors, 1);
  assert.equal(again.current.byEndpoint.investmentsHoldingsGet, 2);
  assert.equal(again.current.connections.length, 2);
});

test('costs follow the rates', () => {
  const r = { plaidPerConnectionMonth: 0.5, plaidPerCall: 0.01, flyPerHour: 0.01, flyFixedMonthly: 0.15 };
  const s = summarize('2026-11', { calls: { a: 10 }, errors: 0, connections: { x: 'S', y: 'R' }, awakeSeconds: 7200 }, r);
  assert.equal(s.plaid, 2 * 0.5 + 10 * 0.01);
  assert.ok(Math.abs(s.fly - (2 * 0.01 + 0.15)) < 1e-9);
  assert.ok(Math.abs(s.total - (s.plaid + s.fly)) < 1e-9);
});

test('rates are validated and saved', () => {
  const u = createUsage();
  assert.throws(() => u.setRates({ ...DEFAULT_RATES, plaidPerCall: -1 }), /plaidPerCall/);
  assert.throws(() => u.setRates({ ...DEFAULT_RATES, flyPerHour: 'abc' }), /flyPerHour/);
  u.setRates({ ...DEFAULT_RATES, plaidPerConnectionMonth: 0.35 });
  assert.equal(createUsage().report().rates.plaidPerConnectionMonth, 0.35);
});
