import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './store.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const VALID_KINDS = new Set(['buy', 'repay', 'interest']);

export function loadMarginEntries({ read = readJson } = {}) {
  const raw = read('margin.json', { entries: [] });
  return Array.isArray(raw?.entries) ? raw.entries : [];
}

export function addMarginEntry(input, { read = readJson, write = writeJson } = {}) {
  const kind = String(input?.kind ?? '').trim();
  if (!VALID_KINDS.has(kind)) throw new Error('Margin entry kind must be buy, repay, or interest.');
  const amount = Number(input?.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be a positive number.');
  const date = String(input?.date ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Date must be YYYY-MM-DD.');

  const entry = {
    id: randomUUID(),
    date,
    kind,
    amount: round2(amount),
    institution: String(input?.institution ?? '').trim().slice(0, 80) || 'Brokerage',
    account: String(input?.account ?? '').trim().slice(0, 80) || '',
    ticker: String(input?.ticker ?? '').trim().toUpperCase().slice(0, 20) || null,
    note: String(input?.note ?? '').trim().slice(0, 200) || null,
  };

  const entries = [...loadMarginEntries({ read }), entry].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  write('margin.json', { entries });
  return entry;
}

export function deleteMarginEntry(id, { read = readJson, write = writeJson } = {}) {
  const entries = loadMarginEntries({ read });
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) return false;
  write('margin.json', { entries: next });
  return true;
}

/**
 * Combine manual margin ledger entries with any negative cash (margin debit)
 * or margin interest transactions detected from linked brokerages.
 */
export function summarizeMargin(entries = [], portfolio = null, items = []) {
  let totalBought = 0;
  let totalRepaid = 0;
  let totalInterest = 0;

  for (const e of entries) {
    const amt = Number(e?.amount) || 0;
    if (e.kind === 'buy') totalBought += amt;
    else if (e.kind === 'repay') totalRepaid += amt;
    else if (e.kind === 'interest') totalInterest += amt;
  }

  const brokerAccounts = [];
  let brokerMarginDebit = 0;
  for (const a of portfolio?.accounts ?? []) {
    if ((a.cash ?? 0) < -0.01) {
      const debit = round2(Math.abs(a.cash));
      brokerMarginDebit += debit;
      brokerAccounts.push({
        institution: a.institution,
        account: a.name && a.name !== a.institution ? `${a.institution} · ${a.name}` : a.institution,
        debit,
      });
    }
  }

  let detectedInterest = 0;
  for (const it of items ?? []) {
    for (const tx of it?.transactions ?? []) {
      const text = `${tx.type ?? ''} ${tx.subtype ?? ''} ${tx.name ?? ''}`;
      if (/margin.*interest|interest.*margin/i.test(text)) {
        detectedInterest += Math.abs(Number(tx.amount) || 0);
      }
    }
  }

  const trackedBalance = round2(Math.max(0, totalBought - totalRepaid));
  const currentBalance = round2(brokerMarginDebit > 0 ? brokerMarginDebit : trackedBalance);

  return {
    totalBought: round2(totalBought),
    totalRepaid: round2(totalRepaid),
    totalInterest: round2(totalInterest + detectedInterest),
    manualInterest: round2(totalInterest),
    detectedInterest: round2(detectedInterest),
    trackedBalance,
    brokerMarginDebit: round2(brokerMarginDebit),
    currentBalance,
    brokerAccounts,
    entries: [...entries].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
  };
}

export function demoMargin(asOf) {
  const ago = (days) => new Date(Date.parse(asOf) - days * 86_400_000).toISOString().slice(0, 10);
  return [
    { id: 'demo-m1', date: ago(45), kind: 'buy', amount: 2400, institution: 'Robinhood', account: 'Robinhood Individual', ticker: 'NVDA', note: 'Bought 15 shares on margin' },
    { id: 'demo-m2', date: ago(20), kind: 'repay', amount: 900, institution: 'Robinhood', account: 'Robinhood Individual', ticker: null, note: 'Cash deposit toward margin' },
    { id: 'demo-m3', date: ago(14), kind: 'interest', amount: 18.42, institution: 'Robinhood', account: 'Robinhood Individual', ticker: null, note: 'Monthly margin interest' },
  ];
}
