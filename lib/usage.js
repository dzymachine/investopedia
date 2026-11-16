// Tracks what running the app costs: Plaid API calls, Plaid connections active each month,
// and how long the server was awake (Fly bills per second while running). Estimates only.
import { readJson, writeJson } from './store.js';

const FILE = 'usage.json';
const SETTINGS = 'settings.json';
const TICK_MS = 60_000;
const FLUSH_EVERY = 5; // ticks

// Defaults are starting points; enter your real prices in Settings.
export const DEFAULT_RATES = {
  plaidPerConnectionMonth: 0,   // Plaid Investments monthly fee per connected account (see your Plaid pricing page)
  plaidPerCall: 0,              // only if your plan bills per request
  flyPerHour: 0.0027,           // shared-cpu-1x, 256MB machine while running
  flyFixedMonthly: 0.15,        // 1 GB volume
};
const RATE_KEYS = Object.keys(DEFAULT_RATES);

const monthOf = (d = new Date()) => d.toLocaleDateString('en-CA').slice(0, 7);
const blankMonth = () => ({ calls: {}, errors: 0, connections: {}, awakeSeconds: 0 });

export function createUsage({ now = () => new Date() } = {}) {
  let state = readJson(FILE, { months: {} });
  let dirty = false;
  let ticks = 0;
  const month = () => (state.months[monthOf(now())] ??= blankMonth());
  const flush = () => { if (dirty) { writeJson(FILE, state); dirty = false; } };

  function call(endpoint, ok) {
    const m = month();
    m.calls[endpoint] = (m.calls[endpoint] ?? 0) + 1;
    if (!ok) m.errors += 1;
    dirty = true;
    flush();
  }

  function connections(list) {
    const m = month();
    for (const { itemId, institution } of list) {
      if (!m.connections[itemId]) { m.connections[itemId] = institution; dirty = true; }
    }
    flush();
  }

  // Awake time: count a minute per tick while the process runs; flush on stop.
  let timer = null;
  function startClock() {
    timer = setInterval(() => {
      month().awakeSeconds += TICK_MS / 1000;
      dirty = true;
      if (++ticks % FLUSH_EVERY === 0) flush();
    }, TICK_MS);
    timer.unref();
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { flush(); process.exit(0); });
  }

  const rates = () => ({ ...DEFAULT_RATES, ...readJson(SETTINGS, {}).rates });
  function setRates(input) {
    const next = {};
    for (const k of RATE_KEYS) {
      const v = Number(input?.[k]);
      if (!Number.isFinite(v) || v < 0 || v > 10_000) throw new Error(`${k} must be a number from 0 to 10000.`);
      next[k] = v;
    }
    writeJson(SETTINGS, { ...readJson(SETTINGS, {}), rates: next });
    return next;
  }

  function report() {
    flush();
    const r = rates();
    const months = Object.entries(state.months)
      .map(([key, m]) => summarize(key, m, r))
      .sort((a, b) => (a.month < b.month ? 1 : -1));
    const current = months.find((m) => m.month === monthOf(now())) ?? summarize(monthOf(now()), blankMonth(), r);
    return { rates: r, defaults: DEFAULT_RATES, current, months, total: months.reduce((s, m) => s + m.total, 0) };
  }

  return { call, connections, startClock, report, setRates, flush };
}

export function summarize(month, m, r) {
  const calls = Object.values(m.calls).reduce((s, n) => s + n, 0);
  const connections = Object.entries(m.connections).map(([itemId, institution]) => ({ itemId, institution }));
  const awakeHours = m.awakeSeconds / 3600;
  const plaid = connections.length * r.plaidPerConnectionMonth + calls * r.plaidPerCall;
  const fly = awakeHours * r.flyPerHour + r.flyFixedMonthly;
  return {
    month, calls, errors: m.errors, byEndpoint: m.calls, connections, awakeHours,
    plaid, fly, total: plaid + fly,
  };
}

// Wraps a Plaid client so every API method call is counted.
export function instrument(client, usage) {
  return new Proxy(client, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== 'function' || prop === 'constructor') return v;
      return async (...args) => {
        try { const r = await v.apply(target, args); usage.call(String(prop), true); return r; }
        catch (err) { usage.call(String(prop), false); throw err; }
      };
    },
  });
}
