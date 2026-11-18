// Pure: turns an analyze() result into ranked "You should know this" notes. No I/O.
import { estimateTax } from './portfolio.js';

export const LT_SOON_DAYS = 60;          // lot turns long-term within this many days
export const LT_URGENT_DAYS = 14;
export const MIN_TAX_SAVED = 50;         // ignore waiting notes that save less than this
export const CONCENTRATION_WEIGHT = 0.2; // one position above this share of the portfolio
export const CONCENTRATION_URGENT = 0.5;
export const INSTITUTION_WEIGHT = 0.5;   // one institution holding more than this share
export const MIN_HARVEST_LOSS = 200;     // unrealized losses worth mentioning
export const IDLE_CASH_WEIGHT = 0.1;
export const IDLE_CASH_MIN = 1000;
export const DEADLINE_DAYS = 120;        // show a filing deadline this close
export const DEADLINE_URGENT_DAYS = 30;

const RANK = { urgent: 0, useful: 1, fyi: 2 };
const DAY_MS = 86_400_000;
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / DAY_MS);
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (n) => usd.format(Math.round(n));
const money2 = (n) => usd2.format(n);
const pc = (n) => `${Math.round(n * 100)}%`;
const day = (s) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function insights(result) {
  const { asOf, totals, tax, holdings = [], byInstitution = [], byType = [], accounts = [], lots = [], items = [], rates, margin, history = [] } = result;
  const notes = [];

  // Accounts that need a sign-in again.
  for (const it of items) {
    if (!it.needsReauth) continue;
    notes.push({
      id: `reauth-${it.itemId}`, urgency: 'urgent',
      title: `Sign in again to ${it.institution}`,
      body: 'Its numbers are missing or stale until you reconnect.',
      details: [['Account', it.institution], ['Status', 'Needs a new sign-in']],
      target: { kind: 'reauth', itemId: it.itemId },
    });
  }

  // Active margin balance or interest.
  if (margin && (margin.currentBalance > 0 || margin.totalInterest > 0)) {
    notes.push({
      id: 'margin-active', urgency: margin.currentBalance > 0 ? 'useful' : 'fyi',
      title: margin.currentBalance > 0
        ? `${money(margin.currentBalance)} currently borrowed on margin`
        : `${money2(margin.totalInterest)} paid in margin interest`,
      body: `Bought ${money(margin.totalBought)} on margin, repaid ${money(margin.totalRepaid)} so far.`,
      details: [
        ['Current margin owed', money2(margin.currentBalance)],
        ['Bought on margin', money2(margin.totalBought)],
        ['Paid back so far', money2(margin.totalRepaid)],
        ['Interest paid', money2(margin.totalInterest)],
      ],
      target: { kind: 'margin' },
    });
  }

  // Gains about to turn long-term.
  const byTicker = new Map();
  for (const l of tax.upcoming ?? []) {
    if (l.daysUntilLongTerm > LT_SOON_DAYS) continue;
    const g = byTicker.get(l.ticker) ?? { ticker: l.ticker, lots: [], saved: 0, gain: 0, days: Infinity, on: null };
    g.lots.push(l);
    g.saved += l.taxSavedByWaiting;
    g.gain += l.gain;
    if (l.daysUntilLongTerm < g.days) { g.days = l.daysUntilLongTerm; g.on = l.longTermOn; }
    byTicker.set(l.ticker, g);
  }
  for (const g of byTicker.values()) {
    if (g.saved < MIN_TAX_SAVED) continue;
    notes.push({
      id: `long-term-${g.ticker}`, urgency: g.days <= LT_URGENT_DAYS ? 'urgent' : 'useful',
      title: `Wait ${plural(g.days, 'day')} on your ${g.ticker} to save ${money(g.saved)}`,
      body: `${plural(g.lots.length, 'lot')} turn${g.lots.length === 1 ? 's' : ''} long-term on ${day(g.on)}.`,
      details: [
        ['Gain on these lots', money2(g.gain)],
        ['Tax if sold today', money2(g.gain * rates.shortTerm)],
        ['Tax after long-term date', money2(g.gain * rates.longTerm)],
        ['Saved by waiting', money2(g.saved)],
      ],
      target: { kind: 'upcoming', ticker: g.ticker },
    });
  }

  // One position is a big share.
  for (const h of holdings) {
    if (h.weight <= CONCENTRATION_WEIGHT) continue;
    notes.push({
      id: `concentration-${h.key}`, urgency: h.weight >= CONCENTRATION_URGENT ? 'urgent' : 'useful',
      title: `${h.ticker ?? h.name} is ${pc(h.weight)} of your portfolio`,
      body: 'A big move in one position moves your whole total.',
      details: [['Position value', money2(h.value)], ['Share of portfolio', pc(h.weight)], ['Next largest', nextLargest(holdings, h)]],
      target: { kind: 'holding', key: h.key },
    });
  }

  // One institution holds most of the money.
  const top = byInstitution[0];
  if (top && top.weight > INSTITUTION_WEIGHT && byInstitution.length > 1) {
    notes.push({
      id: 'institution-share', urgency: 'fyi',
      title: `${pc(top.weight)} of your money is at ${top.name}`,
      body: 'Spreading across brokers limits the damage from one outage or freeze.',
      details: [[top.name, money2(top.value)], ['Everything else', money2(totals.value - top.value)]],
      target: { kind: 'institution', name: top.name },
    });
  }

  // Losses that could cancel gains already realized this year.
  const r = tax.realizedYtd;
  const lossLots = lots.filter((l) => l.gain != null && l.gain < 0);
  const lossShort = sum(lossLots.filter((l) => l.term === 'short'), 'gain');
  const lossLong = sum(lossLots.filter((l) => l.term === 'long'), 'gain');
  const loss = lossShort + lossLong;
  const taxNow = tax.estimatedOnRealizedYtd.total;
  if (-loss >= MIN_HARVEST_LOSS && taxNow > 0) {
    const after = estimateTax(r.short + lossShort, r.long + lossLong, rates.shortTerm, rates.longTerm).total;
    notes.push({
      id: 'loss-offset', urgency: 'useful',
      title: `Selling losers could cut this year's tax by ${money(taxNow - after)}`,
      body: 'Losses cancel gains from sales you already made this year. Buying the same thing back within 30 days cancels the benefit.',
      details: [
        ['Unrealized losses', money2(loss)],
        ['Gains realized this year', money2(r.short + r.long)],
        ['Est. tax now', money2(taxNow)],
        ['Est. tax after selling losers', money2(after)],
      ],
      target: { kind: 'lots', term: 'all' },
    });
  }

  // Idle cash (with per-account breakdown of where it lives).
  if (totals.value > 0 && totals.cash >= IDLE_CASH_MIN && totals.cash / totals.value >= IDLE_CASH_WEIGHT) {
    const cashAccts = accounts
      .filter((a) => (a.cash ?? 0) > 0.01)
      .sort((a, b) => b.cash - a.cash)
      .map((a) => [`${a.institution}${a.name && a.name !== a.institution ? ` · ${a.name}` : ''}`, money2(a.cash)]);
    const whereText = cashAccts.length
      ? ` Sitting in ${cashAccts.map(([k, v]) => `${k} (${v})`).join(', ')}.`
      : '';
    notes.push({
      id: 'idle-cash', urgency: 'fyi',
      title: `${money(totals.cash)} is sitting in cash`,
      body: `That is ${pc(totals.cash / totals.value)} of your portfolio.${whereText}`,
      details: [...cashAccts, ['Total cash', money2(totals.cash)], ['Invested', money2(totals.invested)]],
      target: { kind: 'holdings' },
    });
  }

  // Top winner & biggest loser (only when gain is known).
  const withGain = holdings.filter((h) => h.gain != null && Number.isFinite(h.gain));
  if (withGain.length >= 2) {
    const best = [...withGain].sort((a, b) => b.gain - a.gain)[0];
    if (best && best.gain >= 500) {
      notes.push({
        id: `top-winner-${best.key}`, urgency: 'fyi',
        title: `${best.ticker ?? best.name} is your biggest winner at +${money(best.gain)}`,
        body: `Up ${best.gainPct != null ? pc(best.gainPct) : ''} across ${(best.institutions ?? []).join(', ') || 'your accounts'}.`.trim(),
        details: [
          ['Position value', money2(best.value)],
          ['Cost basis', money2(best.costBasis)],
          ['Unrealized gain', `+${money2(best.gain)}`],
        ],
        target: { kind: 'holding', key: best.key },
      });
    }
    const worst = [...withGain].sort((a, b) => a.gain - b.gain)[0];
    if (worst && worst.gain <= -500) {
      notes.push({
        id: `biggest-loser-${worst.key}`, urgency: 'fyi',
        title: `${worst.ticker ?? worst.name} is down ${money(Math.abs(worst.gain))}`,
        body: `Currently your largest unrealized loss (${worst.gainPct != null ? pc(worst.gainPct) : ''}).`,
        details: [
          ['Position value', money2(worst.value)],
          ['Cost basis', money2(worst.costBasis)],
          ['Unrealized loss', money2(worst.gain)],
        ],
        target: { kind: 'holding', key: worst.key },
      });
    }
  }

  // Daily account high/low movers when history has at least 2 days.
  if (history.length >= 2 && accounts.length >= 2) {
    const prev = history[history.length - 2];
    const curr = history[history.length - 1];
    const movers = [];
    for (const a of accounts) {
      const k = `${a.institution}::${a.accountId ?? a.name}`;
      const pVal = prev?.accounts?.[k]?.value;
      const cVal = curr?.accounts?.[k]?.value;
      if (pVal > 0 && cVal != null) {
        const diff = cVal - pVal;
        movers.push({ label: a.name && a.name !== a.institution ? `${a.institution} · ${a.name}` : a.institution, diff, pct: diff / pVal });
      }
    }
    if (movers.length >= 2) {
      movers.sort((a, b) => b.pct - a.pct);
      const hi = movers[0];
      const lo = movers[movers.length - 1];
      notes.push({
        id: 'daily-movers', urgency: 'fyi',
        title: `Today's high: ${hi.label} (${hi.diff >= 0 ? '+' : ''}${money(hi.diff)})`,
        body: `Day low: ${lo.label} (${lo.diff >= 0 ? '+' : ''}${money(lo.diff)}).`,
        details: movers.map((m) => [m.label, `${m.diff >= 0 ? '+' : ''}${money2(m.diff)} (${(m.pct * 100).toFixed(2)}%)`]),
        target: { kind: 'ledger' },
      });
    }
  }

  // Tax-sheltered share.
  if (totals.taxShelteredValue > 0 && totals.value > 0 && totals.taxShelteredValue < totals.value) {
    notes.push({
      id: 'tax-sheltered', urgency: 'fyi',
      title: `${pc(totals.taxShelteredValue / totals.value)} of your portfolio is tax-sheltered`,
      body: `${money(totals.taxShelteredValue)} sits in retirement accounts where trades aren't taxed.`,
      details: [
        ['Tax-sheltered', money2(totals.taxShelteredValue)],
        ['Taxable', money2(totals.value - totals.taxShelteredValue)],
      ],
      target: { kind: 'totals' },
    });
  }

  // Filing deadlines that are close.
  const hasSales = (b) => Math.abs(b.short) + Math.abs(b.long) + (b.unknownBasisProceeds ?? 0) > 0;
  const deadlines = [
    hasSales(tax.priorYear) ? { year: tax.priorYear.year, on: tax.priorYear.filingDeadline } : null,
    hasSales(r) ? { year: tax.taxYear, on: tax.filingDeadline } : null,
  ].filter(Boolean);
  for (const d of deadlines) {
    const left = daysBetween(asOf, d.on);
    if (left < 0 || left > DEADLINE_DAYS) continue;
    notes.push({
      id: `deadline-${d.year}`, urgency: left <= DEADLINE_URGENT_DAYS ? 'urgent' : 'useful',
      title: `Your ${d.year} tax return is due in ${plural(left, 'day')}`,
      body: `Sales from ${d.year} are reported by ${day(d.on)}.`,
      details: [['Due', day(d.on)], ['Tax year', d.year]],
      target: { kind: 'tax' },
    });
  }

  return notes
    .map((n, i) => [n, i])
    .sort((a, b) => RANK[a[0].urgency] - RANK[b[0].urgency] || a[1] - b[1])
    .map(([n]) => n);
}

const sum = (arr, k) => arr.reduce((s, x) => s + x[k], 0);
const nextLargest = (hs, h) => {
  const o = hs.find((x) => x !== h);
  return o ? `${o.ticker ?? o.name} ${pc(o.weight)}` : 'None';
};
