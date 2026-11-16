import { readJson, writeJson } from './store.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Record or update today's portfolio snapshot in history.json and return the sorted daily series.
 */
export function recordSnapshot(asOf, totals, { read = readJson, write = writeJson } = {}) {
  const raw = read('history.json', { snapshots: [] });
  const list = Array.isArray(raw?.snapshots) ? raw.snapshots : [];
  const byDate = new Map(list.filter((s) => s?.date).map((s) => [s.date, s]));
  byDate.set(asOf, {
    date: asOf,
    value: round2(totals.value),
    invested: round2(totals.invested),
    cash: round2(totals.cash),
    costBasis: round2(totals.costBasis),
    unrealized: round2(totals.unrealized),
  });
  const snapshots = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  write('history.json', { snapshots });
  return snapshots;
}

/**
 * Generate a deterministic 30-day daily ledger series for demo mode ending on `asOf`.
 */
export function demoHistory(asOf, totals) {
  const days = 30;
  const endMs = Date.parse(asOf);
  const endVal = Number(totals.value) || 0;
  const cash = Number(totals.cash) || 0;
  const costBasis = Number(totals.costBasis) || 0;
  const out = [];
  // Deterministic gentle upward walk that lands exactly on `endVal` on `asOf`.
  let offset = 0;
  const offsets = [];
  for (let i = 0; i < days; i++) {
    offsets.push(offset);
    const wave = Math.sin(i * 0.55) * 0.008 + Math.cos(i * 0.23) * 0.005 + 0.0022;
    offset += wave;
  }
  const finalOffset = offsets[offsets.length - 1];
  for (let i = 0; i < days; i++) {
    const date = new Date(endMs - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    const factor = 1 + (offsets[i] - finalOffset);
    const value = i === days - 1 ? round2(endVal) : round2(endVal * factor);
    const invested = round2(Math.max(0, value - cash));
    out.push({
      date,
      value,
      invested,
      cash: round2(cash),
      costBasis: round2(costBasis),
      unrealized: round2(invested - costBasis),
    });
  }
  return out;
}
