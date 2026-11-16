import { readJson, writeJson } from './store.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

export const accountKey = (a) => `${a.institution}::${a.accountId ?? a.name}`;
export const holdingKey = (h) => h.ticker || h.key || h.name;

/**
 * Record or update today's portfolio, account, institution, and holding snapshot in history.json.
 */
export function recordSnapshot(asOf, portfolio, { read = readJson, write = writeJson } = {}) {
  const totals = portfolio?.totals ?? portfolio;
  const raw = read('history.json', { snapshots: [] });
  const list = Array.isArray(raw?.snapshots) ? raw.snapshots : [];
  const byDate = new Map(list.filter((s) => s?.date).map((s) => [s.date, s]));

  const accounts = {};
  for (const a of portfolio?.accounts ?? []) {
    accounts[accountKey(a)] = {
      label: a.name && a.name !== a.institution ? `${a.institution} · ${a.name}` : a.institution,
      institution: a.institution,
      value: round2(a.value),
    };
  }

  const institutions = {};
  for (const i of portfolio?.byInstitution ?? []) {
    institutions[i.name] = round2(i.value);
  }

  const holdings = {};
  for (const h of portfolio?.holdings ?? []) {
    const k = holdingKey(h);
    if (!k) continue;
    holdings[k] = {
      label: h.ticker ?? h.name,
      name: h.name,
      value: round2(h.value),
      price: round4(h.price),
    };
  }

  byDate.set(asOf, {
    date: asOf,
    value: round2(totals.value),
    invested: round2(totals.invested),
    cash: round2(totals.cash),
    costBasis: round2(totals.costBasis),
    unrealized: round2(totals.unrealized),
    accounts,
    institutions,
    holdings,
  });

  const snapshots = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  write('history.json', { snapshots });
  return snapshots;
}

/**
 * Generate a deterministic 30-day daily ledger series for demo mode ending on `asOf`.
 */
export function demoHistory(asOf, portfolio) {
  const totals = portfolio?.totals ?? portfolio;
  const days = 30;
  const endMs = Date.parse(asOf);
  const endVal = Number(totals.value) || 0;
  const cash = Number(totals.cash) || 0;
  const costBasis = Number(totals.costBasis) || 0;

  const walk = (seed, drift = 0.002) => {
    let off = 0;
    const arr = [];
    for (let i = 0; i < days; i++) {
      arr.push(off);
      off += Math.sin(i * 0.55 + seed) * 0.009 + Math.cos(i * 0.23 + seed * 1.7) * 0.005 + drift;
    }
    const last = arr[arr.length - 1];
    return arr.map((v) => 1 + (v - last));
  };

  const totalFactors = walk(0, 0.0022);
  const acctList = portfolio?.accounts ?? [];
  const instList = portfolio?.byInstitution ?? [];
  const holdList = portfolio?.holdings ?? [];

  const acctFactors = acctList.map((_, idx) => walk(idx + 1, 0.0018));
  const instFactors = instList.map((_, idx) => walk(idx + 5, 0.002));
  const holdFactors = holdList.map((_, idx) => walk(idx + 11, 0.0025));

  const out = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(endMs - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    const isLast = i === days - 1;
    const value = isLast ? round2(endVal) : round2(endVal * totalFactors[i]);
    const invested = round2(Math.max(0, value - cash));

    const accounts = {};
    acctList.forEach((a, idx) => {
      accounts[accountKey(a)] = {
        label: a.name && a.name !== a.institution ? `${a.institution} · ${a.name}` : a.institution,
        institution: a.institution,
        value: isLast ? round2(a.value) : round2((Number(a.value) || 0) * acctFactors[idx][i]),
      };
    });

    const institutions = {};
    instList.forEach((inst, idx) => {
      institutions[inst.name] = isLast ? round2(inst.value) : round2((Number(inst.value) || 0) * instFactors[idx][i]);
    });

    const holdings = {};
    holdList.forEach((h, idx) => {
      const k = holdingKey(h);
      if (!k) return;
      const f = isLast ? 1 : holdFactors[idx][i];
      holdings[k] = {
        label: h.ticker ?? h.name,
        name: h.name,
        value: round2((Number(h.value) || 0) * f),
        price: round4((Number(h.price) || 0) * f),
      };
    });

    out.push({
      date,
      value,
      invested,
      cash: round2(cash),
      costBasis: round2(costBasis),
      unrealized: round2(invested - costBasis),
      accounts,
      institutions,
      holdings,
    });
  }
  return out;
}
