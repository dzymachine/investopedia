import { readJson, writeJson } from './store.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const DAY_MS = 86_400_000;

export const accountKey = (a) => `${a.institution}::${a.accountId ?? a.name}`;
export const holdingKey = (h) => h.ticker || h.key || h.name;

const isCashSec = (sec) => !sec || sec.type === 'cash' || sec.is_cash_equivalent === true;

/**
 * Fetch daily close prices { 'YYYY-MM-DD': closePrice } from Yahoo Finance chart API.
 * Returns null if unavailable or timed out so callers can fall back cleanly.
 */
export async function fetchYahooDailyCloses(symbol) {
  if (!symbol) return null;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'investment-dashboard/1.0' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    const ts = result?.timestamp;
    const closes = result?.indicators?.quote?.[0]?.close;
    if (!Array.isArray(ts) || !Array.isArray(closes)) return null;
    const map = {};
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (Number.isFinite(c) && c > 0) {
        const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
        map[d] = c;
      }
    }
    return Object.keys(map).length ? map : null;
  } catch {
    return null;
  }
}

async function fetchCachedCloses(symbol, asOf, { read = readJson, write = writeJson, fetcher = fetchYahooDailyCloses } = {}) {
  if (!symbol) return null;
  const cache = read('price-cache.json', { date: null, symbols: {} });
  const freshCache = cache?.date === asOf && cache?.symbols ? cache : { date: asOf, symbols: {} };
  if (Object.prototype.hasOwnProperty.call(freshCache.symbols, symbol)) {
    return freshCache.symbols[symbol];
  }
  const map = await fetcher(symbol);
  freshCache.symbols[symbol] = map;
  try { write('price-cache.json', freshCache); } catch { /* cache write is best-effort */ }
  return map;
}

function buildDateList(startDate, endDate) {
  const out = [];
  for (let ms = Date.parse(startDate); ms <= Date.parse(endDate); ms += DAY_MS) {
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

function resolvePriceSeries(dates, rawCloses, anchorPoints, fallbackPrice) {
  const out = new Array(dates.length);
  if (rawCloses) {
    let last = null;
    // Seed with earliest known close in rawCloses if available
    const firstKey = Object.keys(rawCloses).sort()[0];
    if (firstKey && firstKey > dates[0]) last = rawCloses[firstKey];
    for (let i = 0; i < dates.length; i++) {
      if (rawCloses[dates[i]] != null) last = rawCloses[dates[i]];
      out[i] = last ?? fallbackPrice;
    }
    if (fallbackPrice > 0) out[out.length - 1] = fallbackPrice;
    return out;
  }

  // Fallback: linearly interpolate between known transaction prices and today's price
  const anchors = anchorPoints.filter((p) => Number.isFinite(p.price) && p.price > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!anchors.length) return dates.map(() => fallbackPrice);
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    if (d <= anchors[0].date) { out[i] = anchors[0].price; continue; }
    if (d >= anchors[anchors.length - 1].date) { out[i] = anchors[anchors.length - 1].price; continue; }
    const hiIdx = anchors.findIndex((a) => a.date >= d);
    const lo = anchors[hiIdx - 1];
    const hi = anchors[hiIdx];
    const span = Math.max(1, Date.parse(hi.date) - Date.parse(lo.date));
    const t = (Date.parse(d) - Date.parse(lo.date)) / span;
    out[i] = lo.price + (hi.price - lo.price) * t;
  }
  return out;
}

/**
 * Reconstruct past daily portfolio/account/holding values using current holdings,
 * Plaid/Kraken transaction history, and daily market close prices.
 * Existing live snapshots in history.json are never overwritten.
 */
export async function backfillHistory(asOf, items, portfolio, {
  days = 90,
  read = readJson,
  write = writeJson,
  fetcher = fetchYahooDailyCloses,
} = {}) {
  const raw = read('history.json', { snapshots: [] });
  const list = Array.isArray(raw?.snapshots) ? raw.snapshots : [];
  const byDate = new Map(list.filter((s) => s?.date).map((s) => [s.date, s]));

  const startDate = new Date(Date.parse(asOf) - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const dates = buildDateList(startDate, asOf);
  const missingDates = dates.filter((d) => d < asOf && !byDate.has(d));
  if (!missingDates.length || !items?.length) return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

  // Collect unique ticker symbols to fetch daily prices in parallel
  const tickerMeta = new Map();
  for (const item of items) {
    if (item.error || !item.holdings) continue;
    for (const sec of item.holdings.securities ?? []) {
      if (isCashSec(sec) || !sec.ticker_symbol) continue;
      const sym = sec.type === 'cryptocurrency' ? `${sec.ticker_symbol}-USD` : sec.ticker_symbol;
      if (!tickerMeta.has(sec.ticker_symbol)) tickerMeta.set(sec.ticker_symbol, sym);
    }
  }

  const priceMaps = new Map();
  await Promise.allSettled(
    [...tickerMeta.entries()].map(async ([ticker, yahooSym]) => {
      const closes = await fetchCachedCloses(yahooSym, asOf, { read, write, fetcher });
      priceMaps.set(ticker, closes);
    }),
  );

  // Build per-(account, security) daily quantity & price series
  const acctInfo = new Map();
  for (const a of portfolio?.accounts ?? []) {
    acctInfo.set(accountKey(a), {
      label: a.name && a.name !== a.institution ? `${a.institution} · ${a.name}` : a.institution,
      institution: a.institution,
    });
  }

  const dayAccounts = dates.map(() => ({}));
  const dayInstitutions = dates.map(() => ({}));
  const dayHoldings = dates.map(() => ({}));
  const dayCash = new Array(dates.length).fill(0);
  const dayTotal = new Array(dates.length).fill(0);

  for (const item of items) {
    if (item.error || !item.holdings) continue;
    const { accounts = [], holdings = [], securities = [] } = item.holdings;
    const secById = new Map(securities.map((s) => [s.security_id, s]));
    const acctById = new Map(accounts.map((a) => [a.account_id, a]));

    const txByPair = new Map();
    for (const tx of item.transactions ?? []) {
      if (!tx.security_id || !tx.date) continue;
      const k = `${tx.account_id}|${tx.security_id}`;
      if (!txByPair.has(k)) txByPair.set(k, []);
      txByPair.get(k).push(tx);
    }

    const seenPairs = new Set();
    const pairs = [];
    for (const h of holdings) {
      const k = `${h.account_id}|${h.security_id}`;
      seenPairs.add(k);
      pairs.push({
        accountId: h.account_id,
        securityId: h.security_id,
        endQty: Number(h.quantity) || 0,
        endPrice: Number(h.institution_price) || (h.quantity ? (Number(h.institution_value) || 0) / h.quantity : 0),
      });
    }
    for (const [k, txs] of txByPair.entries()) {
      if (seenPairs.has(k)) continue;
      const [accountId, securityId] = k.split('|');
      pairs.push({ accountId, securityId, endQty: 0, endPrice: Number(txs[txs.length - 1]?.price) || 0 });
    }

    for (const p of pairs) {
      const sec = secById.get(p.securityId);
      const acct = acctById.get(p.accountId);
      const aKey = accountKey({ institution: item.institution, accountId: p.accountId, name: acct?.name });
      const aLabel = acctInfo.get(aKey)?.label
        ?? (acct?.name && acct.name !== item.institution ? `${item.institution} · ${acct.name}` : item.institution);
      const txs = txByPair.get(`${p.accountId}|${p.securityId}`) ?? [];
      const txByDate = new Map();
      const anchors = [];
      for (const tx of txs) {
        if (!txByDate.has(tx.date)) txByDate.set(tx.date, []);
        txByDate.get(tx.date).push(tx);
        if (Number.isFinite(tx.price) && tx.price > 0) anchors.push({ date: tx.date, price: tx.price });
      }
      if (p.endPrice > 0) anchors.push({ date: asOf, price: p.endPrice });

      // Walk backwards from asOf to startDate to reconstruct quantity on each day
      const qtys = new Array(dates.length);
      let q = p.endQty;
      for (let i = dates.length - 1; i >= 0; i--) {
        qtys[i] = Math.max(0, q);
        const dayTxs = txByDate.get(dates[i]);
        if (dayTxs) {
          for (const tx of dayTxs) {
            const tq = Math.abs(Number(tx.quantity) || 0);
            if (tx.type === 'buy') q -= tq;
            else if (tx.type === 'sell') q += tq;
          }
        }
      }

      const cashFlag = isCashSec(sec);
      const prices = cashFlag
        ? dates.map(() => 1)
        : resolvePriceSeries(dates, sec?.ticker_symbol ? priceMaps.get(sec.ticker_symbol) : null, anchors, p.endPrice);

      const hKey = sec ? (sec.ticker_symbol || sec.name || sec.security_id) : null;
      for (let i = 0; i < dates.length; i++) {
        const val = qtys[i] * prices[i];
        if (val <= 0 && !cashFlag) continue;
        dayTotal[i] += val;
        if (cashFlag) dayCash[i] += val;

        if (!dayAccounts[i][aKey]) {
          dayAccounts[i][aKey] = { label: aLabel, institution: item.institution, value: 0 };
        }
        dayAccounts[i][aKey].value += val;
        dayInstitutions[i][item.institution] = (dayInstitutions[i][item.institution] ?? 0) + val;

        if (!cashFlag && hKey && qtys[i] > 0) {
          const prev = dayHoldings[i][hKey];
          dayHoldings[i][hKey] = {
            label: sec.ticker_symbol ?? sec.name,
            name: sec.name ?? hKey,
            value: (prev?.value ?? 0) + val,
            price: round4(prices[i]),
          };
        }
      }
    }
  }

  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    if (d >= asOf || byDate.has(d)) continue;
    const accounts = {};
    for (const [k, v] of Object.entries(dayAccounts[i])) {
      accounts[k] = { ...v, value: round2(v.value) };
    }
    const institutions = {};
    for (const [k, v] of Object.entries(dayInstitutions[i])) {
      institutions[k] = round2(v);
    }
    const holdings = {};
    for (const [k, v] of Object.entries(dayHoldings[i])) {
      holdings[k] = { ...v, value: round2(v.value) };
    }
    const total = round2(dayTotal[i]);
    const cash = round2(dayCash[i]);
    byDate.set(d, {
      date: d,
      value: total,
      invested: round2(total - cash),
      cash,
      costBasis: round2(portfolio?.totals?.costBasis ?? 0),
      unrealized: round2((total - cash) - (portfolio?.totals?.costBasis ?? 0)),
      accounts,
      institutions,
      holdings,
      reconstructed: true,
    });
  }

  const snapshots = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  write('history.json', { snapshots });
  return snapshots;
}

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
