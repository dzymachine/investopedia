// Pure portfolio + tax analytics over Plaid Investments responses. No I/O.

const EPS = 1e-9;
const DAY_MS = 86_400_000;

const toDate = (s) => new Date(`${s}T00:00:00Z`);
const fmtDate = (d) => d.toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY_MS);

// IRS: long-term means held MORE than one year, so the first long-term sale date
// is the day after the one-year anniversary.
export function longTermOn(acquired) {
  const d = toDate(acquired);
  return fmtDate(new Date(Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate() + 1)));
}

export const isLongTerm = (acquired, onDate) => onDate >= longTermOn(acquired);

// Plaid account subtypes where selling inside the account is not a taxable event.
const SHELTERED = {
  '401k': '401(k)', '401a': '401(a)', '403b': '403(b)', '457b': '457(b)', 'roth 401k': 'Roth 401(k)',
  ira: 'IRA', roth: 'Roth IRA', 'sep ira': 'SEP IRA', 'simple ira': 'SIMPLE IRA', sarsep: 'SARSEP', keogh: 'Keogh',
  pension: 'Pension', retirement: 'Retirement', 'profit sharing plan': 'Profit sharing', 'thrift savings plan': 'TSP',
  hsa: 'HSA', '529': '529', 'education savings account': 'Education savings', 'non-taxable brokerage account': 'Non-taxable',
  rrsp: 'RRSP', tfsa: 'TFSA', rrif: 'RRIF', lira: 'LIRA',
};
export const taxShelterLabel = (acct) => SHELTERED[String(acct?.subtype ?? '').toLowerCase()]
  ?? (acct?.tax_advantaged === true ? 'Tax-advantaged' : null);

const isCash = (sec) => !sec || sec.type === 'cash' || sec.is_cash_equivalent === true;

const securityKey = (sec) =>
  (sec?.ticker_symbol || sec?.name || sec?.security_id || 'UNKNOWN').toUpperCase();

// US netting: short and long net separately, then a net loss in one offsets the other.
export function estimateTax(shortNet, longNet, stRate, ltRate) {
  let s = shortNet;
  let l = longNet;
  if (s < 0 && l > 0) { l = Math.max(0, l + s); s = 0; }
  else if (l < 0 && s > 0) { s = Math.max(0, s + l); l = 0; }
  const short = Math.max(0, s) * stRate;
  const long = Math.max(0, l) * ltRate;
  return { short, long, total: short + long };
}

function buyCost(tx) {
  if (Number.isFinite(tx.amount) && tx.amount > 0) return tx.amount;
  return Math.abs(tx.quantity) * (tx.price ?? 0) + (tx.fees ?? 0);
}

function sellProceeds(tx) {
  if (Number.isFinite(tx.amount) && tx.amount < 0) return -tx.amount;
  return Math.abs(tx.quantity) * (tx.price ?? 0) - (tx.fees ?? 0);
}

const netQty = (txs) => txs.reduce((s, tx) => s + (tx.type === 'buy' ? Math.abs(tx.quantity ?? 0)
  : tx.type === 'sell' ? -Math.abs(tx.quantity ?? 0) : 0), 0);

// FIFO lots for one account+security, plus realized gains from sells inside the history window.
// `openingQty` = shares already held when the window starts (date and cost unknown); sold first.
export function buildLots(transactions, realized, openingQty = 0) {
  const txs = [...transactions].sort((a, b) =>
    a.date === b.date ? (a.type === 'buy' ? -1 : 1) : a.date < b.date ? -1 : 1);
  const lots = openingQty > EPS ? [{ acquired: null, quantity: openingQty, cost: null }] : [];
  for (const tx of txs) {
    const qty = Math.abs(tx.quantity ?? 0);
    if (qty < EPS) continue;
    if (tx.type === 'buy') {
      lots.push({ acquired: tx.date, quantity: qty, cost: buyCost(tx) });
    } else if (tx.type === 'sell') {
      const year = tx.date.slice(0, 4);
      const bucket = (realized[year] ??= { short: 0, long: 0, unknownBasisProceeds: 0 });
      const perUnit = sellProceeds(tx) / qty;
      let left = qty;
      while (left > EPS && lots.length) {
        const lot = lots[0];
        const take = Math.min(left, lot.quantity);
        if (lot.cost == null) {
          bucket.unknownBasisProceeds += perUnit * take;
        } else {
          const costShare = lot.cost * (take / lot.quantity);
          bucket[isLongTerm(lot.acquired, tx.date) ? 'long' : 'short'] += perUnit * take - costShare;
          lot.cost -= costShare;
        }
        lot.quantity -= take;
        left -= take;
        if (lot.quantity < EPS) lots.shift();
      }
      // Shares bought before the history window: purchase price unknown.
      if (left > EPS) bucket.unknownBasisProceeds += perUnit * left;
    }
  }
  return lots;
}

/**
 * @param items [{ institution, holdings: {accounts, holdings, securities}, transactions: [], historyStart }]
 * @param opts  { asOf: 'YYYY-MM-DD', stRate, ltRate }
 */
export function analyze(items, { asOf, stRate = 0.32, ltRate = 0.15 }) {
  const warnings = [];
  const holdingsMap = new Map();
  const lots = [];
  const realized = {};
  const byInstitution = [];
  const byType = new Map();
  const accountsOut = [];
  let cash = 0;
  let shelteredValue = 0;

  for (const item of items) {
    const { accounts = [], holdings = [], securities = [] } = item.holdings ?? {};
    const secById = new Map(securities.map((s) => [s.security_id, s]));
    const acctById = new Map(accounts.map((a) => [a.account_id, a]));
    const inst = { name: item.institution, value: 0, costBasis: 0, gain: 0 };
    const shelter = (accountId) => taxShelterLabel(acctById.get(accountId));
    const NO_TAX = {}; // realized gains inside retirement accounts land here and are ignored
    for (const a of accounts) {
      accountsOut.push({ institution: item.institution, itemId: item.itemId ?? null, accountId: a.account_id,
        name: a.name, mask: a.mask ?? null, subtype: a.subtype ?? null, taxShelter: shelter(a.account_id), value: 0 });
    }
    const acctOut = (id) => accountsOut.find((x) => x.accountId === id && x.institution === item.institution);
    if (item.error) warnings.push(`${item.institution}: ${item.error}`);

    const txByPair = new Map();
    for (const tx of item.transactions ?? []) {
      if (!tx.security_id) continue;
      const k = `${tx.account_id}|${tx.security_id}`;
      if (!txByPair.has(k)) txByPair.set(k, []);
      txByPair.get(k).push(tx);
    }

    for (const h of holdings) {
      const sec = secById.get(h.security_id);
      const acct = acctById.get(h.account_id);
      const value = h.institution_value ?? h.quantity * (h.institution_price ?? 0);
      inst.value += value;
      const sheltered = shelter(h.account_id);
      if (acctOut(h.account_id)) acctOut(h.account_id).value += value;
      if (sheltered) shelteredValue += value;

      if (isCash(sec)) {
        cash += value;
        byType.set('cash', (byType.get('cash') ?? 0) + value);
        continue;
      }
      const type = sec.type || 'other';
      byType.set(type, (byType.get(type) ?? 0) + value);

      const price = h.institution_price ?? (h.quantity ? value / h.quantity : 0);
      const pairKey = `${h.account_id}|${h.security_id}`;
      const pairTx = txByPair.get(pairKey) ?? [];
      txByPair.delete(pairKey);
      const built = buildLots(pairTx, sheltered ? NO_TAX : realized, Math.max(0, h.quantity - netQty(pairTx)));

      // Reconcile reconstructed lots with what the broker says you hold today.
      let lotQty = built.reduce((s, l) => s + l.quantity, 0);
      while (lotQty > h.quantity + EPS && built.length) {
        const extra = lotQty - h.quantity;
        const lot = built[0];
        if (lot.quantity <= extra + EPS) { built.shift(); lotQty -= lot.quantity; }
        else { if (lot.cost != null) lot.cost *= (lot.quantity - extra) / lot.quantity; lot.quantity -= extra; lotQty = h.quantity; }
      }
      let opening = built.find((l) => l.acquired == null);
      if (h.quantity - lotQty > EPS) {
        if (!opening) built.unshift((opening = { acquired: null, quantity: 0, cost: null }));
        opening.quantity += h.quantity - lotQty;
      }
      const knownCost = built.reduce((s, l) => s + (l.cost ?? 0), 0);
      if (opening) opening.cost = h.cost_basis != null ? Math.max(0, h.cost_basis - knownCost) : null;
      const costBasis = h.cost_basis ?? (built.some((l) => l.cost == null) ? null : knownCost);
      if (costBasis != null) inst.costBasis += costBasis;
      if (costBasis != null) inst.gain += value - costBasis;

      const acctLabel = acct ? `${acct.name}${acct.mask ? ` ••${acct.mask}` : ''}` : 'Account';
      for (const l of sheltered ? [] : built) {
        const lotValue = l.quantity * price;
        const ltDate = l.acquired ? longTermOn(l.acquired) : null;
        lots.push({
          institution: item.institution,
          account: acctLabel,
          ticker: sec.ticker_symbol ?? sec.name,
          name: sec.name,
          acquired: l.acquired,
          acquiredBefore: l.acquired ? null : item.historyStart ?? null,
          quantity: l.quantity,
          costBasis: l.cost,
          value: lotValue,
          gain: l.cost == null ? null : lotValue - l.cost,
          term: !l.acquired || ltDate <= asOf ? 'long' : 'short',
          longTermOn: ltDate,
          daysUntilLongTerm: ltDate && ltDate > asOf ? daysBetween(asOf, ltDate) : 0,
        });
      }

      const key = securityKey(sec);
      const agg = holdingsMap.get(key) ?? {
        key, ticker: sec.ticker_symbol ?? null, name: sec.name, type,
        quantity: 0, value: 0, costBasis: 0, costKnown: true, institutions: new Set(), price,
      };
      agg.quantity += h.quantity;
      agg.value += value;
      if (costBasis == null) agg.costKnown = false; else agg.costBasis += costBasis;
      agg.institutions.add(item.institution);
      agg.price = agg.quantity ? agg.value / agg.quantity : price;
      holdingsMap.set(key, agg);
    }
    // Positions sold out completely aren't in holdings, but their sales are still taxable.
    for (const pairTx of txByPair.values()) {
      const sec = secById.get(pairTx[0].security_id);
      if (sec && isCash(sec)) continue;
      buildLots(pairTx, shelter(pairTx[0].account_id) ? NO_TAX : realized, Math.max(0, -netQty(pairTx)));
    }
    byInstitution.push(inst);
  }

  const totalValue = byInstitution.reduce((s, i) => s + i.value, 0);
  const invested = totalValue - cash;
  const holdings = [...holdingsMap.values()]
    .map((h) => {
      const costBasis = h.costKnown ? h.costBasis : null;
      const gain = costBasis == null ? null : h.value - costBasis;
      return {
        key: h.key, ticker: h.ticker, name: h.name, type: h.type,
        quantity: h.quantity, price: h.price, value: h.value, costBasis, gain,
        gainPct: gain == null || !costBasis ? null : gain / costBasis,
        weight: totalValue ? h.value / totalValue : 0,
        institutions: [...h.institutions],
      };
    })
    .sort((a, b) => b.value - a.value);

  const costBasis = holdings.reduce((s, h) => s + (h.costBasis ?? 0), 0);
  const unrealized = holdings.reduce((s, h) => s + (h.gain ?? 0), 0);

  const unrealizedByTerm = { short: 0, long: 0 };
  for (const l of lots) if (l.gain != null) unrealizedByTerm[l.term] += l.gain;

  const taxYear = asOf.slice(0, 4);
  const priorYear = String(Number(taxYear) - 1);
  const emptyRealized = { short: 0, long: 0, unknownBasisProceeds: 0 };
  const realizedYtd = realized[taxYear] ?? emptyRealized;
  const realizedPrior = realized[priorYear] ?? emptyRealized;

  const upcoming = lots
    .filter((l) => l.term === 'short' && l.gain > 0 && l.daysUntilLongTerm <= 120)
    .map((l) => ({ ...l, taxSavedByWaiting: l.gain * (stRate - ltRate) }))
    .sort((a, b) => a.daysUntilLongTerm - b.daysUntilLongTerm);

  // "What I put in vs. what I've made": compares only holdings whose cost is known,
  // then adds every realized gain or loss in the available history.
  const known = holdings.filter((h) => h.costBasis != null);
  const paid = known.reduce((s, h) => s + h.costBasis, 0);
  const worth = known.reduce((s, h) => s + h.value, 0);
  const realizedByYear = Object.entries(realized)
    .map(([year, r]) => ({ year, short: r.short, long: r.long, total: r.short + r.long, unknownBasisProceeds: r.unknownBasisProceeds }))
    .sort((a, b) => (a.year < b.year ? 1 : -1));
  const realizedAll = realizedByYear.reduce((s, r) => s + r.total, 0);
  const starts = items.map((i) => i.historyStart).filter(Boolean).sort();
  const overall = {
    paid, worth, unrealized: worth - paid, realized: realizedAll,
    gain: worth - paid + realizedAll,
    gainPct: paid ? (worth - paid + realizedAll) / paid : null,
    unknownCostValue: holdings.filter((h) => h.costBasis == null).reduce((s, h) => s + h.value, 0),
    historySince: starts[0] ?? null,
    realizedByYear,
  };

  if (lots.some((l) => !l.acquired)) {
    warnings.push('Some shares were bought before your available transaction history, so their purchase dates are unknown. They are treated as long-term.');
  }

  return {
    asOf,
    rates: { shortTerm: stRate, longTerm: ltRate },
    totals: {
      value: totalValue, cash, invested, costBasis, unrealized, taxShelteredValue: shelteredValue,
      unrealizedPct: costBasis ? unrealized / costBasis : null,
    },
    overall,
    accounts: accountsOut,
    byInstitution: byInstitution
      .map((i) => ({ ...i, weight: totalValue ? i.value / totalValue : 0 }))
      .sort((a, b) => b.value - a.value),
    byType: [...byType.entries()]
      .map(([type, value]) => ({ type, value, weight: totalValue ? value / totalValue : 0 }))
      .sort((a, b) => b.value - a.value),
    holdings,
    lots: lots.sort((a, b) => (a.acquired ?? '') < (b.acquired ?? '') ? 1 : -1),
    tax: {
      taxYear,
      filingDeadline: `${Number(taxYear) + 1}-04-15`,
      unrealized: unrealizedByTerm,
      estimatedIfSoldToday: estimateTax(unrealizedByTerm.short, unrealizedByTerm.long, stRate, ltRate),
      realizedYtd,
      estimatedOnRealizedYtd: estimateTax(realizedYtd.short, realizedYtd.long, stRate, ltRate),
      priorYear: { year: priorYear, ...realizedPrior, filingDeadline: `${taxYear}-04-15` },
      upcoming,
    },
    warnings,
  };
}
