const $ = (s) => document.querySelector(s);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') for (const [p, x] of Object.entries(v)) (p.startsWith('--') ? el.style.setProperty(p, x) : (el.style[p] = x));
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const money = (n) => (n == null ? '–' : usd.format(n));
const signed0 = (n) => (n == null ? '–' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${usd0.format(Math.abs(n))}`);
const signed = (n) => (n == null ? '–' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${usd.format(Math.abs(n))}`);
const pct = (n, sign = false) => (n == null ? '–'
  : `${sign && n > 0 ? '+' : n < 0 ? '−' : ''}${(Math.abs(n) * 100).toFixed(Math.abs(n) < 0.1 ? 2 : 1)}%`);
const qty = (n) => n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 6 : 4 });
const tone = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const arrow = (n) => (n > 0 ? '▲ ' : n < 0 ? '▼ ' : '');
const date = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '–');

const TYPE_LABEL = { equity: 'Stocks', etf: 'ETFs', 'mutual fund': 'Mutual funds', cryptocurrency: 'Crypto', cash: 'Cash', 'fixed income': 'Bonds', derivative: 'Options', other: 'Other' };
const TYPE_ORDER = ['equity', 'etf', 'cryptocurrency', 'cash', 'mutual fund', 'fixed income', 'derivative', 'other'];
const slot = (i) => `var(--s${(i % 8) + 1})`;
const sum = (xs, k) => xs.reduce((a, x) => a + (x[k] ?? 0), 0);
const figNodes = (n, text) => [n ? h('i', { class: 'arr', 'aria-hidden': 'true' }, arrow(n).trim()) : null, text];
const termLabel = (l) => (l.term === 'long' ? 'Long-term' : `Short, long on ${date(l.longTermOn)}`);

let config = {};
let data = null;
let instColor = new Map();
let holdingsSort = { key: 'where', dir: 1 };
let holdingsView = 'account';
let ledgerRange = '1M';
let ledgerFilter = 'compare';
let ledgerScale = 'val';
let yZoom = 1;
let yOffset = 0;
let hiddenLines = new Set();
let acctIndex = 0;
let noteOffset = Number(sessionStorage.getItem('noteOffset') || 0);

// --- tooltip -------------------------------------------------------------
const tip = $('#tip');
function bindTip(el, text) {
  el.addEventListener('mousemove', (e) => {
    tip.textContent = text;
    tip.hidden = false;
    tip.style.left = `${Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${e.clientY + 14}px`;
  });
  el.addEventListener('mouseleave', () => { tip.hidden = true; });
}

// --- data ---------------------------------------------------------------
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && body.code === 'AUTH') { location.replace('/login.html'); throw new Error('Sign in required.'); }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

async function load(fresh = false) {
  $('#refresh').disabled = true;
  $('#asof').textContent = 'Loading…';
  if (fresh === true) {
    noteOffset += 1;
    sessionStorage.setItem('noteOffset', String(noteOffset));
  }
  try {
    data = await api(fresh === true ? '/api/portfolio?fresh=1' : '/api/portfolio');
    data.items.forEach((it) => { if (!instColor.has(it.institution)) instColor.set(it.institution, slot(instColor.size)); });
    render();
  } catch (err) {
    $('#alerts').replaceChildren(h('div', { class: 'alert' }, err.message));
    $('#asof').textContent = '';
  } finally {
    $('#refresh').disabled = false;
  }
}

// --- Plaid Link -----------------------------------------------------------
async function openLink(itemId) {
  try {
    const { linkToken } = await api('/api/link-token', { method: 'POST', body: JSON.stringify(itemId ? { itemId } : {}) });
    const handler = Plaid.create({
      token: linkToken,
      onSuccess: async (publicToken, metadata) => {
        if (!itemId) {
          await api('/api/exchange', { method: 'POST', body: JSON.stringify({ publicToken, institution: metadata.institution }) });
        }
        load();
      },
      onExit: (err) => { if (err) alert(err.display_message || err.error_message || 'Linking was cancelled.'); },
    });
    handler.open();
  } catch (err) {
    alert(err.message);
  }
}

async function removeItem(item) {
  if (!confirm(`Disconnect ${item.institution}? You can link it again later.`)) return;
  try {
    await api(`/api/items/${encodeURIComponent(item.itemId)}`, { method: 'DELETE' });
    load();
  } catch (err) { alert(err.message); }
}

function renderAccountExplorer() {
  const secEl = $('#acct-sec');
  const accts = data?.accounts ?? [];
  if (!accts.length) { secEl.hidden = true; return; }
  secEl.hidden = false;
  acctIndex = ((acctIndex % accts.length) + accts.length) % accts.length;
  const a = accts[acctIndex];
  const totalVal = data?.totals?.value || 0;
  const share = totalVal ? a.value / totalVal : 0;
  const gainPct = a.costBasis ? a.gain / a.costBasis : null;

  $('#acct-idx').textContent = `${acctIndex + 1} / ${accts.length}`;
  $('#acct-prev').disabled = accts.length <= 1;
  $('#acct-next').disabled = accts.length <= 1;

  $('#acct-meta').replaceChildren(
    h('span', { class: 'swatch', style: { background: instColor.get(a.institution) } }),
    h('strong', {}, a.institution),
    a.name && a.name !== a.institution ? h('span', { class: 'muted' }, `· ${a.name}`) : null,
    a.mask ? h('span', { class: 'muted' }, `••${a.mask}`) : null,
    a.subtype ? h('span', { class: 'pill' }, a.subtype) : null,
    a.taxShelter ? h('span', { class: 'pill shelter' }, a.taxShelter) : null,
  );

  $('#acct-stats').replaceChildren(...[
    ['Total value', money(a.value), ''],
    ['Portfolio share', pct(share), ''],
    ['Invested', money(a.invested), ''],
    ['Cash', money(a.cash), ''],
    ['Cost basis', money(a.costBasis), ''],
    ['Unrealized gain', `${arrow(a.gain)}${signed(a.gain)}${gainPct != null ? ` (${pct(gainPct, true)})` : ''}`, tone(a.gain)],
  ].map(([k, v, cls]) => h('div', {}, h('dt', { class: 'label' }, k), h('dd', { class: cls }, v))));

  table('#acct-positions', [
    { label: 'Holding', left: true, cell: (p) => h('div', {}, h('div', { class: 'sym' }, p.ticker ?? p.name), h('div', { class: 'nm', title: p.name }, p.name)) },
    { label: 'Type', left: true, cell: (p) => TYPE_LABEL[p.type] ?? p.type },
    { label: 'Qty', cell: (p) => qty(p.quantity) },
    { label: 'Price', cell: (p) => money(p.price) },
    { label: 'Value', cell: (p) => money(p.value) },
    { label: 'Cost basis', cell: (p) => money(p.costBasis) },
    { label: 'Gain / loss', cell: (p) => gainCell(p.gain) },
    { label: 'Return', cell: (p) => (p.gainPct != null ? h('span', { class: tone(p.gainPct) }, `${arrow(p.gainPct)}${pct(p.gainPct, true)}`) : '–') },
  ], a.positions ?? [], {
    empty: 'No investment positions in this account (cash only).',
    onRow: {
      label: (p) => p.ticker ?? p.name,
      open: (p, el) => {
        const match = data.holdings.find((x) => (x.ticker || x.key || x.name) === p.key);
        if (match) showDrawer(holdingDrawer(match), el);
      },
    },
  });
}

// --- daily ledger stock graph ---------------------------------------------
const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, kids = []) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const k of kids) if (k) el.append(k);
  return el;
};

function sliceHistory(history, range) {
  if (!history.length || range === 'ALL') return history;
  const end = history[history.length - 1].date;
  const endMs = Date.parse(end);
  const days = { '1W': 7, '1M': 30, '3M': 90, '1Y': 365 }[range];
  const cutoff = days
    ? new Date(endMs - (days - 1) * 86_400_000).toISOString().slice(0, 10)
    : `${end.slice(0, 4)}-01-01`;
  const sliced = history.filter((p) => p.date >= cutoff);
  return sliced.length ? sliced : history;
}

function computeYBounds(vals, zoom = 1, allowNegative = false, offset = 0) {
  const autoMin = Math.min(...vals);
  const autoMax = Math.max(...vals);
  const span = autoMax - autoMin;
  const padV = span > 0 ? span * 0.12 : Math.max(Math.abs(autoMax) * 0.05, allowNegative ? 5 : 100);
  const baseMin = allowNegative ? autoMin - padV : Math.max(0, autoMin - padV);
  const baseMax = autoMax + padV;
  const baseSpan = baseMax - baseMin || 1;
  if (zoom === 1 && offset === 0) return { minV: baseMin, maxV: baseMax, rangeV: baseSpan };

  const half = (baseSpan / 2) / zoom;
  const mid = (baseMin + baseMax) / 2 + offset * baseSpan;
  let minV = mid - half;
  let maxV = mid + half;
  if (!allowNegative && minV < 0) {
    minV = 0;
    maxV = zoom >= 1 ? 2 * half : Math.max(baseMax, baseSpan / zoom);
  }
  return { minV, maxV, rangeV: maxV - minV || 1 };
}

function clampYOffset() {
  if (yZoom <= 1) { yOffset = 0; return; }
  const maxOff = (1 - 1 / yZoom) / 2;
  yOffset = Math.max(-maxOff, Math.min(maxOff, yOffset));
}

function bindYPan(hit, svg, ph) {
  if (yZoom <= 1) return;
  hit.classList.add('pannable');
  let dragStartY = null;
  let startOffset = 0;
  hit.addEventListener('pointerdown', (e) => {
    dragStartY = e.clientY;
    startOffset = yOffset;
    hit.classList.add('panning');
    hit.setPointerCapture?.(e.pointerId);
  });
  hit.addEventListener('pointermove', (e) => {
    if (dragStartY == null) return;
    const rect = svg.getBoundingClientRect();
    const dy = (e.clientY - dragStartY) / (rect.height || ph || 1);
    yOffset = startOffset + dy / yZoom;
    clampYOffset();
    renderLedger();
  });
  const endDrag = () => {
    if (dragStartY == null) return;
    dragStartY = null;
    hit.classList.remove('panning');
  };
  hit.addEventListener('pointerup', endDrag);
  hit.addEventListener('pointercancel', endDrag);
}

function populateLedgerFilter() {
  const sel = $('#ledger-filter');
  const groups = [
    h('option', { value: 'compare' }, 'All accounts (Compare lines)'),
    h('option', { value: 'compare-stocks' }, 'All stocks (Compare lines)'),
    h('option', { value: 'all' }, 'All accounts (Total)'),
  ];

  const insts = data?.byInstitution ?? [];
  if (insts.length) {
    groups.push(h('optgroup', { label: 'Institutions' },
      insts.map((i) => h('option', { value: `inst:${i.name}` }, i.name))));
  }

  const accts = data?.accounts ?? [];
  if (accts.length) {
    groups.push(h('optgroup', { label: 'Accounts' },
      accts.map((a) => {
        const key = `${a.institution}::${a.accountId ?? a.name}`;
        const label = a.name && a.name !== a.institution ? `${a.institution} · ${a.name}` : a.institution;
        return h('option', { value: `acct:${key}` }, label);
      })));
  }

  const holds = [...(data?.holdings ?? [])].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  if (holds.length) {
    groups.push(h('optgroup', { label: 'Stocks & Assets' },
      holds.map((x) => {
        const k = x.ticker || x.key || x.name;
        const label = x.ticker && x.name && x.ticker !== x.name ? `${x.ticker} · ${x.name}` : (x.ticker ?? x.name);
        return h('option', { value: `hold:${k}` }, label);
      })));
  }

  sel.replaceChildren(...groups);
  const has = [...sel.options].some((o) => o.value === ledgerFilter);
  if (!has) ledgerFilter = 'compare';
  sel.value = ledgerFilter;
}

const lineColor = (idx) => (idx < 8 ? slot(idx) : `hsl(${(idx * 47 + 25) % 360} 58% 60%)`);

function withPlotPts(series) {
  return series.map((s) => {
    if (ledgerScale !== 'pct') return { ...s, plotPts: s.pts.map((p) => p.value) };
    const first = s.pts.find((p) => p.value != null && p.value > 0)?.value;
    return {
      ...s,
      plotPts: s.pts.map((p) => (p.value != null && first ? ((p.value - first) / first) * 100 : null)),
    };
  });
}

function buildCompareSeries(history, mode) {
  const series = [];
  if (mode === 'compare-stocks') {
    const holds = [...(data?.holdings ?? [])].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    holds.forEach((x, idx) => {
      const k = x.ticker || x.key || x.name;
      const pts = history.map((s) => ({ date: s.date, value: s.holdings?.[k]?.value ?? null }));
      if (pts.some((p) => p.value != null)) {
        const label = x.ticker ?? x.name;
        series.push({ id: `hold:${k}`, label, color: lineColor(idx), pts });
      }
    });
    return withPlotPts(series);
  }

  const accts = data?.accounts ?? [];
  accts.forEach((a, idx) => {
    const key = `${a.institution}::${a.accountId ?? a.name}`;
    const label = a.name && a.name !== a.institution ? `${a.institution} · ${a.name}` : a.institution;
    const pts = history.map((s) => ({ date: s.date, value: s.accounts?.[key]?.value ?? null }));
    if (pts.some((p) => p.value != null)) {
      series.push({ id: `acct:${key}`, label, color: lineColor(idx), pts });
    }
  });
  // Also include Bitcoin as its own line if held alongside other crypto or alone
  const btcHold = (data?.holdings ?? []).find((x) => (x.ticker || '').toUpperCase() === 'BTC');
  if (btcHold && history.some((s) => s.holdings?.BTC?.value != null)) {
    const pts = history.map((s) => ({ date: s.date, value: s.holdings?.BTC?.value ?? null }));
    series.push({ id: 'hold:BTC', label: 'Bitcoin (BTC)', color: lineColor(accts.length), pts });
  }
  return withPlotPts(series);
}

function renderCompareLedger(raw) {
  const wrap = $('#ledger-chart');
  const note = $('#ledger-note');
  const hlEl = $('#ledger-hl');
  const legEl = $('#ledger-legend');

  const sliced = sliceHistory(raw, ledgerRange);
  const allSeries = buildCompareSeries(sliced, ledgerFilter);
  if (!sliced.length || !allSeries.length) {
    wrap.replaceChildren();
    hlEl.hidden = true;
    legEl.hidden = true;
    note.hidden = false;
    note.textContent = 'Link an account to start recording your daily ledger.';
    $('#ledger-val').textContent = '–';
    $('#ledger-chg').textContent = '';
    $('#ledger-day').textContent = '';
    $('#ledger-date').textContent = '';
    return;
  }

  const visibleSeries = allSeries.filter((s) => !hiddenLines.has(s.id));
  const activeSeries = visibleSeries.length ? visibleSeries : allSeries;

  // Build Day High / Day Low slots once so hovering never shifts layout
  const hasMovers = sliced.length >= 2 && allSeries.filter((s) => s.id !== 'hold:BTC').length >= 2;
  const makeHlSlot = (tag) => {
    const sw = h('span', { class: 'swatch' });
    const nm = h('strong', { class: 'hl-name' }, '–');
    const st = h('span', { class: 'hl-stat' }, '–');
    const el = h('span', { class: 'hl-item' }, h('span', { class: 'label' }, tag), sw, nm, st);
    return { el, sw, nm, st };
  };
  const hiSlot = makeHlSlot('Day high');
  const loSlot = makeHlSlot('Day low');
  hlEl.hidden = !hasMovers;
  if (hasMovers) hlEl.replaceChildren(hiSlot.el, loSlot.el);

  // Build legend pills once and update values in-place on hover
  legEl.hidden = false;
  const legSlots = allSeries.map((s) => {
    const off = hiddenLines.has(s.id);
    const valEl = h('span', { class: 'leg-val' }, '–');
    const chgEl = h('span', { class: 'leg-chg' }, '–');
    const btn = h('button', {
      type: 'button',
      class: `leg-pill${off ? ' off' : ''}`,
      'aria-pressed': String(!off),
      onclick: () => {
        if (hiddenLines.has(s.id)) hiddenLines.delete(s.id);
        else if (allSeries.length - hiddenLines.size > 1) hiddenLines.add(s.id);
        renderLedger();
      },
    },
    h('span', { class: 'swatch', style: { background: s.color } }),
    h('span', { class: 'leg-name' }, s.label),
    valEl,
    chgEl);
    return { s, btn, valEl, chgEl };
  });
  legEl.replaceChildren(...legSlots.map((x) => x.btn));

  const setReadout = (idx) => {
    const snap = sliced[idx];
    const firstSnap = sliced[0];
    const prevSnap = idx > 0 ? sliced[idx - 1] : null;
    const diff = snap.value - firstSnap.value;
    const diffPct = firstSnap.value ? diff / firstSnap.value : null;
    const dayDiff = prevSnap ? snap.value - prevSnap.value : null;
    const dayPct = prevSnap?.value ? dayDiff / prevSnap.value : null;

    $('#ledger-val').textContent = money(snap.value);
    const chgEl = $('#ledger-chg');
    chgEl.className = `ledger-chg ${tone(diff)}`;
    chgEl.textContent = sliced.length > 1
      ? `${arrow(diff)}${signed(diff)}${diffPct != null ? ` (${pct(diffPct, true)})` : ''}`
      : '';
    $('#ledger-day').textContent = dayDiff != null ? `Day: ${signed(dayDiff)}${dayPct != null ? ` (${pct(dayPct, true)})` : ''}` : '';
    $('#ledger-date').textContent = date(snap.date);

    if (hasMovers) {
      const movers = [];
      for (const s of allSeries) {
        if (ledgerFilter === 'compare' && s.id === 'hold:BTC') continue;
        const cur = s.pts[idx]?.value;
        const prv = idx > 0 ? s.pts[idx - 1]?.value : null;
        if (cur != null && prv != null && prv > 0) {
          const d = cur - prv;
          movers.push({ label: s.label, color: s.color, diff: d, pct: d / prv });
        }
      }
      if (movers.length >= 2) {
        movers.sort((a, b) => b.pct - a.pct);
        const hi = movers[0];
        const lo = movers[movers.length - 1];
        hiSlot.sw.style.background = hi.color;
        hiSlot.nm.textContent = hi.label;
        hiSlot.st.className = `hl-stat ${tone(hi.diff)}`;
        hiSlot.st.textContent = `${signed(hi.diff)} (${pct(hi.pct, true)})`;
        loSlot.sw.style.background = lo.color;
        loSlot.nm.textContent = lo.label;
        loSlot.st.className = `hl-stat ${tone(lo.diff)}`;
        loSlot.st.textContent = `${signed(lo.diff)} (${pct(lo.pct, true)})`;
      } else {
        hiSlot.sw.style.background = 'transparent';
        hiSlot.nm.textContent = '–';
        hiSlot.st.className = 'hl-stat muted';
        hiSlot.st.textContent = 'Start of range';
        loSlot.sw.style.background = 'transparent';
        loSlot.nm.textContent = '–';
        loSlot.st.className = 'hl-stat muted';
        loSlot.st.textContent = 'Start of range';
      }
    }

    for (const { s, valEl, chgEl: lChg } of legSlots) {
      const cur = s.pts[idx]?.value;
      const prv = idx > 0 ? s.pts[idx - 1]?.value : null;
      const d = cur != null && prv != null ? cur - prv : null;
      const dp = d != null && prv > 0 ? d / prv : null;
      valEl.textContent = money(cur);
      if (d != null) {
        lChg.className = `leg-chg ${tone(d)}`;
        lChg.textContent = `${signed(d)} (${pct(dp, true)})`;
      } else {
        lChg.className = 'leg-chg muted';
        lChg.textContent = '–';
      }
    }
  };
  setReadout(sliced.length - 1);

  note.hidden = sliced.length > 1;
  if (sliced.length === 1) {
    note.textContent = "Today's snapshot is recorded. Check back on future days to see your daily trend.";
  }

  const W = 860, H = 250;
  const pad = { l: 10, r: 78, t: 18, b: 28 };
  const pw = W - pad.l - pad.r;
  const ph = H - pad.t - pad.b;

  const isPct = ledgerScale === 'pct';
  const vals = activeSeries.flatMap((s) => s.plotPts.filter((v) => v != null));
  const { minV, rangeV } = computeYBounds(vals, yZoom, isPct, yOffset);

  const xAt = (i) => (sliced.length === 1 ? pad.l + pw / 2 : pad.l + (i / (sliced.length - 1)) * pw);
  const yAt = (v) => pad.t + (1 - (v - minV) / rangeV) * ph;

  const clipId = 'ledger-clip-cmp';
  const defs = svgEl('defs', {}, [
    svgEl('clipPath', { id: clipId }, [
      svgEl('rect', { x: pad.l - 4, y: pad.t - 4, width: pw + 8, height: ph + 8 }),
    ]),
  ]);

  const grid = [];
  for (let i = 0; i <= 3; i++) {
    const v = minV + (rangeV * i) / 3;
    const y = yAt(v);
    const lbl = isPct ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%` : usd0.format(v);
    grid.push(
      svgEl('line', { x1: pad.l, y1: y, x2: W - pad.r, y2: y, class: 'l-grid' }),
      svgEl('text', { x: W - pad.r + 8, y: y + 4, class: 'l-ylab' }, [lbl]),
    );
  }
  if (isPct && minV < 0 && minV + rangeV > 0) {
    grid.push(svgEl('line', { x1: pad.l, y1: yAt(0), x2: W - pad.r, y2: yAt(0), class: 'l-base' }));
  }

  const tickCount = Math.min(5, sliced.length);
  const xLabels = [];
  const shortDate = (s) => new Date(`${s}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const usedIdx = new Set();
  for (let t = 0; t < tickCount; t++) {
    const idx = tickCount === 1 ? 0 : Math.round((t / (tickCount - 1)) * (sliced.length - 1));
    if (usedIdx.has(idx)) continue;
    usedIdx.add(idx);
    const anchor = idx === 0 && sliced.length > 1 ? 'start' : idx === sliced.length - 1 && sliced.length > 1 ? 'end' : 'middle';
    xLabels.push(svgEl('text', { x: xAt(idx), y: H - 6, 'text-anchor': anchor, class: 'l-xlab' }, [shortDate(sliced[idx].date)]));
  }

  const paths = [];
  const dots = [];
  for (const s of activeSeries) {
    const coords = [];
    s.plotPts.forEach((v, i) => {
      if (v != null) coords.push(`${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`);
    });
    if (coords.length > 1) {
      paths.push(svgEl('path', {
        d: `M ${coords.join(' L ')}`, fill: 'none', stroke: s.color,
        'stroke-width': '2.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }));
    }
    const lastV = s.plotPts[sliced.length - 1];
    const dot = svgEl('circle', {
      cx: xAt(sliced.length - 1), cy: lastV != null ? yAt(lastV) : -20,
      r: 4, fill: s.color, class: 'l-dot', visibility: lastV != null ? 'visible' : 'hidden',
    });
    dots.push({ s, dot });
  }

  const cross = svgEl('line', { x1: 0, y1: pad.t, x2: 0, y2: pad.t + ph, class: 'l-cross', visibility: 'hidden' });
  const hit = svgEl('rect', { x: pad.l, y: pad.t, width: pw, height: ph, fill: 'transparent', class: 'l-hit' });

  const move = (clientX, svg) => {
    const rect = svg.getBoundingClientRect();
    const relX = ((clientX - rect.left) / (rect.width || 1)) * W;
    const norm = Math.max(0, Math.min(1, (relX - pad.l) / (pw || 1)));
    const idx = sliced.length === 1 ? 0 : Math.round(norm * (sliced.length - 1));
    const cx = xAt(idx);
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    cross.setAttribute('visibility', 'visible');
    for (const { s, dot } of dots) {
      const v = s.plotPts[idx];
      if (v != null) {
        dot.setAttribute('cx', cx);
        dot.setAttribute('cy', yAt(v));
        dot.setAttribute('visibility', 'visible');
      } else {
        dot.setAttribute('visibility', 'hidden');
      }
    }
    setReadout(idx);
  };
  const leave = () => {
    cross.setAttribute('visibility', 'hidden');
    const lastIdx = sliced.length - 1;
    for (const { s, dot } of dots) {
      const v = s.plotPts[lastIdx];
      if (v != null) {
        dot.setAttribute('cx', xAt(lastIdx));
        dot.setAttribute('cy', yAt(v));
        dot.setAttribute('visibility', 'visible');
      } else {
        dot.setAttribute('visibility', 'hidden');
      }
    }
    setReadout(lastIdx);
  };

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Daily comparison chart' }, [
    defs,
    ...grid,
    ...xLabels,
    svgEl('g', { 'clip-path': `url(#${clipId})` }, [...paths, ...dots.map((d) => d.dot)]),
    cross,
    hit,
  ]);
  hit.addEventListener('pointermove', (e) => move(e.clientX, svg));
  hit.addEventListener('pointerleave', leave);
  bindYPan(hit, svg, ph);
  wrap.replaceChildren(svg);
}

function extractLedgerSeries(history, filter) {
  if (filter === 'all') return history.map((s) => ({ date: s.date, value: s.value, price: null }));
  const [kind, ...rest] = filter.split(':');
  const key = rest.join(':');
  const out = [];
  for (const s of history) {
    if (kind === 'inst' && s.institutions && s.institutions[key] != null) {
      out.push({ date: s.date, value: s.institutions[key], price: null });
    } else if (kind === 'acct' && s.accounts && s.accounts[key] != null) {
      out.push({ date: s.date, value: s.accounts[key].value, price: null });
    } else if (kind === 'hold' && s.holdings && s.holdings[key] != null) {
      out.push({ date: s.date, value: s.holdings[key].value, price: s.holdings[key].price });
    }
  }
  return out;
}

function renderLedger() {
  populateLedgerFilter();
  const isCompare = ledgerFilter === 'compare' || ledgerFilter === 'compare-stocks';
  $('#ledger-scale').hidden = !isCompare;
  $('#y-zoom-reset').setAttribute('aria-pressed', String(yZoom === 1 && yOffset === 0));
  $('#y-zoom-reset').textContent = yZoom === 1 ? 'Auto' : `${yZoom.toFixed(1)}×`;
  $('#y-pan-up').disabled = yZoom <= 1;
  $('#y-pan-down').disabled = yZoom <= 1;
  const raw = data?.history ?? [];
  if (isCompare) return renderCompareLedger(raw);
  $('#ledger-hl').hidden = true;
  $('#ledger-legend').hidden = true;
  const all = extractLedgerSeries(raw, ledgerFilter);
  const wrap = $('#ledger-chart');
  const note = $('#ledger-note');
  if (!all.length) {
    wrap.replaceChildren();
    note.hidden = false;
    note.textContent = raw.length
      ? 'No daily history recorded for this selection yet — check back after today’s snapshot.'
      : 'Link an account to start recording your daily ledger.';
    $('#ledger-val').textContent = '–';
    $('#ledger-chg').textContent = '';
    $('#ledger-day').textContent = '';
    $('#ledger-date').textContent = '';
    return;
  }

  const pts = sliceHistory(all, ledgerRange);
  const first = pts[0];
  const last = pts[pts.length - 1];
  const up = last.value >= first.value;
  const stroke = up ? 'var(--gain)' : 'var(--loss)';

  const setReadout = (idx) => {
    const pt = pts[idx];
    const diff = pt.value - first.value;
    const diffPct = first.value ? diff / first.value : null;
    const prev = idx > 0 ? pts[idx - 1] : null;
    const dayDiff = prev ? pt.value - prev.value : null;
    const dayPct = prev?.value ? dayDiff / prev.value : null;

    $('#ledger-val').textContent = money(pt.value);
    const chgEl = $('#ledger-chg');
    chgEl.className = `ledger-chg ${tone(diff)}`;
    chgEl.textContent = pts.length > 1
      ? `${arrow(diff)}${signed(diff)}${diffPct != null ? ` (${pct(diffPct, true)})` : ''}`
      : '';
    const parts = [];
    if (pt.price != null) parts.push(`Price: ${money(pt.price)}`);
    if (dayDiff != null) parts.push(`Day: ${signed(dayDiff)}${dayPct != null ? ` (${pct(dayPct, true)})` : ''}`);
    $('#ledger-day').textContent = parts.join(' · ');
    $('#ledger-date').textContent = date(pt.date);
  };
  setReadout(pts.length - 1);

  note.hidden = all.length > 1;
  if (all.length === 1) {
    note.textContent = "Today's snapshot is recorded. Check back on future days to see your daily trend.";
  }

  const W = 860, H = 240;
  const pad = { l: 10, r: 78, t: 18, b: 28 };
  const pw = W - pad.l - pad.r;
  const ph = H - pad.t - pad.b;

  const vals = pts.map((p) => p.value);
  const { minV, rangeV } = computeYBounds(vals, yZoom, false, yOffset);

  const xAt = (i) => (pts.length === 1 ? pad.l + pw / 2 : pad.l + (i / (pts.length - 1)) * pw);
  const yAt = (v) => pad.t + (1 - (v - minV) / rangeV) * ph;

  const gradId = 'ledger-grad';
  const clipId = 'ledger-clip-single';
  const defs = svgEl('defs', {}, [
    svgEl('clipPath', { id: clipId }, [
      svgEl('rect', { x: pad.l - 4, y: pad.t - 4, width: pw + 8, height: ph + 8 }),
    ]),
    svgEl('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' }, [
      svgEl('stop', { offset: '0%', 'stop-color': stroke, 'stop-opacity': '0.28' }),
      svgEl('stop', { offset: '100%', 'stop-color': stroke, 'stop-opacity': '0' }),
    ]),
  ]);

  const grid = [];
  for (let i = 0; i <= 3; i++) {
    const v = minV + (rangeV * i) / 3;
    const y = yAt(v);
    grid.push(
      svgEl('line', { x1: pad.l, y1: y, x2: W - pad.r, y2: y, class: 'l-grid' }),
      svgEl('text', { x: W - pad.r + 8, y: y + 4, class: 'l-ylab' }, [usd0.format(v)]),
    );
  }

  // Baseline at period start
  const baseY = yAt(first.value);
  grid.push(svgEl('line', { x1: pad.l, y1: baseY, x2: W - pad.r, y2: baseY, class: 'l-base' }));

  // X-axis date ticks (up to 5)
  const tickCount = Math.min(5, pts.length);
  const xLabels = [];
  const shortDate = (s) => new Date(`${s}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const usedIdx = new Set();
  for (let t = 0; t < tickCount; t++) {
    const idx = tickCount === 1 ? 0 : Math.round((t / (tickCount - 1)) * (pts.length - 1));
    if (usedIdx.has(idx)) continue;
    usedIdx.add(idx);
    const anchor = idx === 0 && pts.length > 1 ? 'start' : idx === pts.length - 1 && pts.length > 1 ? 'end' : 'middle';
    xLabels.push(svgEl('text', { x: xAt(idx), y: H - 6, 'text-anchor': anchor, class: 'l-xlab' }, [shortDate(pts[idx].date)]));
  }

  const linePts = pts.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.value).toFixed(1)}`);
  const areaD = pts.length > 1
    ? `M ${xAt(0).toFixed(1)},${(pad.t + ph).toFixed(1)} L ${linePts.join(' L ')} L ${xAt(pts.length - 1).toFixed(1)},${(pad.t + ph).toFixed(1)} Z`
    : '';
  const lineD = pts.length > 1 ? `M ${linePts.join(' L ')}` : '';

  const cross = svgEl('line', { x1: 0, y1: pad.t, x2: 0, y2: pad.t + ph, class: 'l-cross', visibility: 'hidden' });
  const dot = svgEl('circle', { cx: xAt(pts.length - 1), cy: yAt(last.value), r: 4.5, fill: stroke, class: 'l-dot' });
  const hit = svgEl('rect', { x: pad.l, y: pad.t, width: pw, height: ph, fill: 'transparent', class: 'l-hit' });

  const move = (clientX, svg) => {
    const rect = svg.getBoundingClientRect();
    const relX = ((clientX - rect.left) / (rect.width || 1)) * W;
    const norm = Math.max(0, Math.min(1, (relX - pad.l) / (pw || 1)));
    const idx = pts.length === 1 ? 0 : Math.round(norm * (pts.length - 1));
    const cx = xAt(idx);
    const cy = yAt(pts[idx].value);
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', cy);
    setReadout(idx);
  };
  const leave = () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('cx', xAt(pts.length - 1));
    dot.setAttribute('cy', yAt(last.value));
    setReadout(pts.length - 1);
  };

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Daily portfolio value chart' }, [
    defs,
    ...grid,
    ...xLabels,
    svgEl('g', { 'clip-path': `url(#${clipId})` }, [
      areaD ? svgEl('path', { d: areaD, fill: `url(#${gradId})` }) : null,
      lineD ? svgEl('path', { d: lineD, fill: 'none', stroke, 'stroke-width': '2.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }) : null,
      dot,
    ]),
    cross,
    hit,
  ]);
  hit.addEventListener('pointermove', (e) => move(e.clientX, svg));
  hit.addEventListener('pointerleave', leave);
  bindYPan(hit, svg, ph);
  wrap.replaceChildren(svg);
}

// --- render ---------------------------------------------------------------
function render() {
  const { totals, items, margin } = data;
  $('#asof').textContent = `As of ${date(data.asOf)}`;

  const alerts = [
    ...items.filter((i) => i.needsReauth).map((i) => h('div', { class: 'alert' },
      `${i.institution} needs you to sign in again.`, h('button', { class: 'link', type: 'button', onclick: () => openLink(i.itemId) }, 'Reconnect'))),
    ...data.warnings.map((w) => h('div', { class: 'alert' }, w)),
  ];
  $('#alerts').replaceChildren(...alerts);

  renderAccounts();
  renderAccountExplorer();
  renderLedger();
  renderOverall();

  $('#k-value').textContent = usd0.format(totals.value);
  $('#k-value-sub').textContent = `${usd0.format(totals.invested)} invested · ${usd0.format(totals.cash)} cash`;
  $('#k-gain').className = `fig tnum ${tone(totals.unrealized)}`;
  $('#k-gain').replaceChildren(...figNodes(totals.unrealized, signed0(totals.unrealized)));
  $('#k-gain-sub').textContent = `${pct(totals.unrealizedPct, true)} on ${usd0.format(totals.costBasis)} cost basis`;

  const cashAccts = (data.accounts ?? []).filter((a) => Math.abs(a.cash ?? 0) > 0.01).sort((a, b) => b.cash - a.cash);
  $('#k-cash').textContent = usd0.format(totals.cash);
  $('#k-cash-sub').textContent = cashAccts.length
    ? cashAccts.slice(0, 2).map((a) => `${a.institution} ${usd0.format(a.cash)}`).join(' · ')
    : 'No cash held';

  const mBal = margin?.currentBalance ?? 0;
  $('#k-margin').className = `fig tnum ${mBal > 0 ? 'down' : ''}`;
  $('#k-margin').textContent = usd0.format(mBal);
  $('#k-margin-sub').textContent = margin
    ? `Bought ${usd0.format(margin.totalBought)} · Paid ${usd0.format(margin.totalRepaid)}`
    : 'No margin tracked';

  $('#k-side').replaceChildren(...[
    ['Invested', usd0.format(totals.invested), ''],
    ['Cash', usd0.format(totals.cash), ''],
    ['Margin owed', usd0.format(mBal), mBal > 0 ? 'down' : ''],
  ].map(([k, v, c]) => h('div', {}, h('dt', { class: 'label' }, k), h('dd', { class: `tnum ${c}` }, v))));
  renderNotes();

  renderStack('#alloc-inst', data.byInstitution.map((i) => ({ label: i.institution ?? i.name, value: i.value, weight: i.weight, color: instColor.get(i.name) })));
  renderStack('#alloc-type', [...data.byType]
    .sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type))
    .map((t) => ({ label: TYPE_LABEL[t.type] ?? t.type, value: t.value, weight: t.weight, color: slot(Math.max(0, TYPE_ORDER.indexOf(t.type))) })));

  renderHoldings();
  renderMargin();
}

function renderAccounts() {
  const el = $('#accounts');
  if (!data.items.length) {
    el.replaceChildren(h('div', { class: 'empty' },
      h('p', {}, 'No accounts linked yet. Add Charles Schwab, Robinhood, and Kraken to get started.'),
      h('button', { class: 'btn', type: 'button', onclick: () => openLink() }, 'Add account')));
    return;
  }
  const valueOf = new Map(data.byInstitution.map((i) => [i.name, i.value]));
  el.replaceChildren(...data.items.map((it, n) => h('div', { class: `acct panel rise${config.demo || it.removable === false ? '' : ' has-x'}`, style: { '--i': String(n) } },
    h('span', { class: 'glow' }),
    h('button', { class: 'chip', type: 'button', onclick: (e) => showDrawer(institutionDrawer(it), e.currentTarget) },
      h('span', { class: 'swatch', style: { background: instColor.get(it.institution) } }),
      h('strong', {}, it.institution),
      h('span', { class: 'val' }, money(valueOf.get(it.institution) ?? 0)),
      ...shelterTags(it.institution).map((t) => h('span', { class: 'pill shelter', title: 'Tax-advantaged: left out of tax figures' }, t)),
      it.error ? h('span', { class: 'pill', title: it.error }, 'issue') : null),
    config.demo || it.removable === false ? null : h('button', { class: 'x', type: 'button', 'aria-label': `Disconnect ${it.institution}`, onclick: () => removeItem(it) }, '✕'))));
}

function renderStack(sel, parts) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const bar = h('div', { class: 'stack', role: 'img', 'aria-label': parts.map((p) => `${p.label} ${pct(p.weight)}`).join(', ') },
    parts.filter((p) => p.value > 0).map((p) => {
      const seg = h('span', { style: { flex: `${p.value / (total || 1)} 1 0`, background: p.color } });
      bindTip(seg, `${p.label}: ${money(p.value)} (${pct(p.weight)})`);
      return seg;
    }));
  const legend = h('ul', { class: 'legend' }, parts.map((p) => h('li', {},
    h('span', { class: 'swatch', style: { background: p.color } }), h('span', {}, p.label),
    h('span', {}, usd0.format(p.value)), h('span', { class: 'pct' }, pct(p.weight)))));
  $(sel).replaceChildren(bar, legend);
}

function table(el, columns, rows, { sort, onSort, empty, onRow } = {}) {
  const thead = h('thead', {}, h('tr', {}, columns.map((c) => h('th', {
    class: c.left ? 'l' : null, scope: 'col', 'data-key': c.sortable ? c.key : null,
    'aria-sort': sort && sort.key === c.key ? (sort.dir > 0 ? 'ascending' : 'descending') : null,
    tabindex: c.sortable ? '0' : null,
    onclick: c.sortable ? () => onSort(c.key) : null,
    onkeydown: c.sortable ? (e) => { if (e.key === 'Enter') onSort(c.key); } : null,
  }, c.label))));
  const body = rows.length
    ? rows.map((r) => h('tr', onRow ? {
        class: 'row-click', tabindex: '0', role: 'button', 'aria-label': `${onRow.label(r)}, open detail`,
        onclick: (e) => onRow.open(r, e.currentTarget),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRow.open(r, e.currentTarget); } },
      } : {}, columns.map((c) => h('td', { class: c.left ? 'l' : null }, c.cell(r)))))
    : [h('tr', {}, h('td', { class: 'none', colspan: columns.length }, empty ?? 'Nothing here yet.'))];
  $(el).replaceChildren(thead, h('tbody', {}, body));
}

const gainCell = (n, p) => h('span', { class: tone(n) }, signed(n), p !== undefined ? h('span', { class: 'muted' }, ` (${pct(p, true)})`) : null);

function buildAccountHoldingRows() {
  const totalVal = data?.totals?.value || 0;
  const rows = [];
  for (const a of data?.accounts ?? []) {
    const acctLabel = a.name && a.name !== a.institution ? `${a.institution} · ${a.name}` : a.institution;
    const where = `${a.institution} · ${a.name ?? ''}${a.mask ? ` ••${a.mask}` : ''}`;
    for (const p of a.positions ?? []) {
      rows.push({
        key: p.ticker ?? p.name,
        ticker: p.ticker,
        name: p.name,
        type: p.type,
        institution: a.institution,
        accountName: a.name ?? a.institution,
        where: acctLabel,
        whereFull: where,
        isCash: false,
        quantity: p.quantity,
        price: p.price,
        value: p.value,
        costBasis: p.costBasis,
        gain: p.gain,
        gainPct: p.gainPct,
        weight: totalVal ? p.value / totalVal : 0,
      });
    }
    if (Math.abs(a.cash ?? 0) > 0.01) {
      rows.push({
        key: 'Cash',
        ticker: 'Cash',
        name: a.cash < 0 ? 'Margin debit / cash' : 'Cash balance',
        type: 'cash',
        institution: a.institution,
        accountName: a.name ?? a.institution,
        where: acctLabel,
        whereFull: where,
        isCash: true,
        quantity: a.cash,
        price: 1,
        value: a.cash,
        costBasis: a.cash,
        gain: 0,
        gainPct: 0,
        weight: totalVal ? a.cash / totalVal : 0,
      });
    }
  }
  return rows;
}

function renderHoldings() {
  const sub = $('#holdings-sub');
  if (holdingsView === 'account') {
    sub.textContent = 'Sorted by app and account, including cash. Click a column to sort, a row for detail.';
    const rawRows = buildAccountHoldingRows();
    const maxW = Math.max(...rawRows.map((x) => Math.abs(x.weight)), 0.0001);
    const rows = [...rawRows].sort((a, b) => {
      if (holdingsSort.key === 'where') {
        const cmp = a.where.localeCompare(b.where) * holdingsSort.dir;
        return cmp !== 0 ? cmp : b.value - a.value;
      }
      const av = a[holdingsSort.key] ?? -Infinity;
      const bv = b[holdingsSort.key] ?? -Infinity;
      return (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * holdingsSort.dir;
    });
    table('#holdings', [
      {
        key: 'where', label: 'Where', left: true, sortable: true,
        cell: (r) => h('div', { class: 'where-cell' },
          h('span', { class: 'swatch', style: { background: instColor.get(r.institution) } }),
          h('div', {}, h('div', { class: 'sym' }, r.institution), h('div', { class: 'nm' }, r.accountName))),
      },
      { key: 'key', label: 'Holding', left: true, sortable: true, cell: (r) => h('div', {}, h('div', { class: 'sym' }, r.ticker ?? r.name), h('div', { class: 'nm', title: r.name }, r.name)) },
      { key: 'quantity', label: 'Quantity', sortable: true, cell: (r) => (r.isCash ? '–' : qty(r.quantity)) },
      { key: 'price', label: 'Price', sortable: true, cell: (r) => (r.isCash ? '–' : money(r.price)) },
      { key: 'value', label: 'Value', sortable: true, cell: (r) => h('span', { class: r.value < 0 ? 'down' : '' }, money(r.value)) },
      { key: 'costBasis', label: 'Cost basis', sortable: true, cell: (r) => (r.isCash ? '–' : money(r.costBasis)) },
      { key: 'gain', label: 'Gain / loss', sortable: true, cell: (r) => (r.isCash ? '–' : gainCell(r.gain)) },
      { key: 'gainPct', label: 'Return', sortable: true, cell: (r) => (r.isCash ? '–' : h('span', { class: tone(r.gainPct) }, `${arrow(r.gainPct)}${pct(r.gainPct, true)}`)) },
      { key: 'weight', label: 'Weight', sortable: true, cell: (r) => h('span', { class: 'weight' }, h('i', { style: { width: `${(Math.max(0, r.weight) / maxW) * 48}px` } }), pct(r.weight)) },
    ], rows, {
      sort: holdingsSort,
      onRow: {
        label: (r) => `${r.where} ${r.ticker ?? r.name}`,
        open: (r, el) => {
          if (r.isCash) return showDrawer(cashDrawer(), el);
          const match = data.holdings.find((x) => (x.ticker || x.key || x.name) === (r.ticker || r.name));
          if (match) showDrawer(holdingDrawer(match), el);
        },
      },
      empty: 'No holdings. Link an account to see your positions.',
      onSort: (key) => {
        holdingsSort = { key, dir: holdingsSort.key === key ? -holdingsSort.dir : key === 'where' || key === 'key' ? 1 : -1 };
        renderHoldings();
      },
    });
    return;
  }

  sub.textContent = 'Combined across accounts. Click a column to sort, a row for detail.';
  const maxW = Math.max(...data.holdings.map((x) => x.weight), 0.0001);
  const rows = [...data.holdings].sort((a, b) => {
    const av = a[holdingsSort.key] ?? -Infinity;
    const bv = b[holdingsSort.key] ?? -Infinity;
    return (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * holdingsSort.dir;
  });
  table('#holdings', [
    { key: 'key', label: 'Holding', left: true, sortable: true, cell: (r) => h('div', {}, h('div', { class: 'sym' }, r.ticker ?? r.name), h('div', { class: 'nm', title: r.name }, r.name)) },
    { key: 'inst', label: 'Held at', left: true, cell: (r) => h('span', {}, r.institutions.map((i, n) => [n ? ', ' : '', i])) },
    { key: 'quantity', label: 'Quantity', sortable: true, cell: (r) => qty(r.quantity) },
    { key: 'price', label: 'Price', sortable: true, cell: (r) => money(r.price) },
    { key: 'value', label: 'Value', sortable: true, cell: (r) => money(r.value) },
    { key: 'costBasis', label: 'Cost basis', sortable: true, cell: (r) => money(r.costBasis) },
    { key: 'gain', label: 'Gain / loss', sortable: true, cell: (r) => gainCell(r.gain) },
    { key: 'gainPct', label: 'Return', sortable: true, cell: (r) => h('span', { class: tone(r.gainPct) }, `${arrow(r.gainPct)}${pct(r.gainPct, true)}`) },
    { key: 'weight', label: 'Weight', sortable: true, cell: (r) => h('span', { class: 'weight' }, h('i', { style: { width: `${(r.weight / maxW) * 48}px` } }), pct(r.weight)) },
  ], rows, {
    sort: holdingsSort,
    onRow: { label: (r) => r.ticker ?? r.name, open: (r, el) => showDrawer(holdingDrawer(r), el) },
    empty: 'No holdings. Link an account to see your positions.',
    onSort: (key) => {
      holdingsSort = { key, dir: holdingsSort.key === key ? -holdingsSort.dir : key === 'key' ? 1 : -1 };
      renderHoldings();
    },
  });
}

function cashDrawer() {
  const cashAccts = (data.accounts ?? [])
    .filter((a) => Math.abs(a.cash ?? 0) > 0.01)
    .sort((a, b) => b.cash - a.cash);
  return {
    label: 'Cash across accounts',
    title: money(data.totals.cash),
    sub: `${pct(data.totals.value ? data.totals.cash / data.totals.value : 0)} of your total portfolio.`,
    body: [
      sec('Where your cash lives', dtable([
        ['App', (a) => a.institution, true],
        ['Account', (a) => a.name + (a.mask ? ` ••${a.mask}` : ''), true],
        ['Cash', (a) => h('span', { class: a.cash < 0 ? 'down' : '' }, money(a.cash))],
      ], cashAccts, 'No cash balances found.')),
    ],
  };
}

const MARGIN_KIND = { buy: 'Bought on margin', repay: 'Paid back', interest: 'Interest paid' };

function renderMargin() {
  const m = data?.margin;
  if (!m) return;
  $('#margin-stats').replaceChildren(...[
    ['Current margin owed', money(m.currentBalance), m.currentBalance > 0 ? 'down' : ''],
    ['Bought on margin', money(m.totalBought), ''],
    ['Paid back so far', money(m.totalRepaid), m.totalRepaid > 0 ? 'up' : ''],
    ['Interest paid', money(m.totalInterest), m.totalInterest > 0 ? 'down' : ''],
  ].map(([k, v, cls]) => h('div', {}, h('dt', { class: 'label' }, k), h('dd', { class: cls }, v))));

  const sel = $('#margin-acct');
  const accts = data?.accounts ?? [];
  sel.replaceChildren(
    ...accts.map((a) => {
      const label = a.name && a.name !== a.institution ? `${a.institution} · ${a.name}` : a.institution;
      return h('option', { value: `${a.institution}::${a.name ?? ''}` }, label);
    }),
    h('option', { value: 'Other::Margin' }, 'Other'),
  );
  if (!$('#margin-date').value) $('#margin-date').value = data.asOf;

  table('#margin-table', [
    { label: 'Date', left: true, cell: (e) => date(e.date) },
    { label: 'Type', left: true, cell: (e) => h('span', { class: `pill${e.kind === 'repay' ? ' shelter' : ''}` }, MARGIN_KIND[e.kind] ?? e.kind) },
    { label: 'Where', left: true, cell: (e) => (e.account ? `${e.institution} · ${e.account}` : e.institution) },
    { label: 'Ticker', left: true, cell: (e) => (e.ticker ? h('span', { class: 'sym' }, e.ticker) : '–') },
    { label: 'Amount', cell: (e) => h('span', { class: e.kind === 'repay' ? 'up' : e.kind === 'buy' ? 'down' : '' }, money(e.amount)) },
    { label: 'Note', left: true, cell: (e) => h('span', { class: 'muted' }, e.note ?? '–') },
    {
      label: '',
      cell: (e) => (config.demo ? null : h('button', {
        class: 'link',
        type: 'button',
        onclick: async () => {
          try {
            await api(`/api/margin/${encodeURIComponent(e.id)}`, { method: 'DELETE' });
            load();
          } catch (err) { alert(err.message); }
        },
      }, 'Remove')),
    },
  ], m.entries ?? [], { empty: 'No margin activity logged yet. Click "+ Log margin" to track margin buys, repayments, or interest.' });
}

// --- drawer ---------------------------------------------------------------
const drawerEl = $('#drawer');
let opener = null;
const dl = (rows) => h('dl', { class: 'tnum' }, rows.filter(Boolean).map(([k, v, cls]) => [h('dt', {}, k), h('dd', { class: cls }, v)]));
const sec = (title, ...kids) => h('section', {}, h('h3', {}, title), kids);
const dtable = (cols, rows, empty = 'Nothing here.') => h('div', { class: 'table-wrap' }, h('table', {},
  h('thead', {}, h('tr', {}, cols.map(([label, , left]) => h('th', { class: left ? 'l' : null, scope: 'col' }, label)))),
  h('tbody', {}, rows.length ? rows.map((r) => h('tr', {}, cols.map(([, f, left]) => h('td', { class: left ? 'l' : null }, f(r)))))
    : h('tr', {}, h('td', { class: 'none', colspan: cols.length }, empty)))));

function showDrawer(d, from) {
  opener = from ?? document.activeElement;
  $('#d-label').textContent = d.label;
  const t = $('#d-title');
  t.className = d.tone ?? '';
  t.replaceChildren(...[d.title].flat().filter((x) => x != null));
  $('#d-sub').textContent = d.sub ?? '';
  $('#d-body').replaceChildren(...d.body);
  drawerEl.scrollTop = 0;
  $('#app').inert = true;
  document.body.classList.add('open');
  drawerEl.focus({ preventScroll: true });
  $('#close').focus();
}
function closeDrawer() {
  if (!document.body.classList.contains('open')) return;
  document.body.classList.remove('open');
  $('#app').inert = false;
  if (opener && opener.isConnected) opener.focus({ preventScroll: true });
  opener = null;
}
$('#close').addEventListener('click', closeDrawer);
$('#back').addEventListener('click', closeDrawer);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
  if (e.key === 'Tab' && document.body.classList.contains('open')) {
    const f = [...drawerEl.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

const lotCols = (withTicker) => [
  withTicker ? ['Holding', (l) => h('span', { class: 'sym' }, l.ticker), true] : null,
  ['Account', (l) => (withTicker ? `${l.institution}` : l.account), true],
  ['Bought', (l) => (l.acquired ? date(l.acquired) : `before ${date(l.acquiredBefore)}`)],
  ['Qty', (l) => qty(l.quantity)],
  ['Value', (l) => money(l.value)],
  ['Gain', (l) => gainCell(l.gain)],
  ['Term', (l) => (l.term === 'long' ? 'Long' : `Short, long ${date(l.longTermOn)}`)],
].filter(Boolean);

const termSummary = (lots) => ['short', 'long'].map((t) => {
  const ls = lots.filter((l) => l.term === t);
  return [`${t === 'short' ? 'Short-term' : 'Long-term'} (${ls.length} ${ls.length === 1 ? 'lot' : 'lots'}, ${money(sum(ls, 'value'))})`, signed(sum(ls, 'gain')), tone(sum(ls, 'gain'))];
});

function totalDrawer() {
  const { totals, tax } = data;
  const valueOf = new Map(data.byInstitution.map((i) => [i.name, i]));
  return {
    label: 'Total value', title: money(totals.value), sub: `${money(totals.invested)} invested, ${money(totals.cash)} cash. As of ${date(data.asOf)}.`,
    body: [
      sec('By account', dtable([
        ['Account', (i) => i.name, true], ['Value', (i) => money(i.value)], ['Gain', (i) => gainCell(i.gain)], ['Share', (i) => pct(i.weight)],
      ], data.byInstitution)),
      sec('By asset type', dl(data.byType.map((t) => [TYPE_LABEL[t.type] ?? t.type, `${money(t.value)} · ${pct(t.weight)}`]))),
      sec('Unrealized, by holding period', dl(termSummary(data.lots)), h('p', { class: 'muted' }, `Shares held more than a year are long-term. Estimated tax if sold today: ${money(tax.estimatedIfSoldToday.total)}.`)),
    ],
  };
}

function renderOverall() {
  const o = data.overall;
  $('#ov-paid').textContent = usd0.format(o.paid);
  $('#ov-worth').textContent = usd0.format(o.worth);
  $('#ov-gain').className = `fig tnum ${tone(o.gain)}`;
  $('#ov-gain').replaceChildren(...figNodes(o.gain, `${o.gain > 0 ? '+' : o.gain < 0 ? '−' : ''}${usd0.format(Math.abs(o.gain))}`));
  $('#ov-pct').className = `ov-pct tnum ${tone(o.gain)}`;
  $('#ov-pct').textContent = o.gainPct == null ? '' : `${pct(o.gainPct, true)} on what you paid`;

  // Bar: brass = what you paid; green extends past it for a gain, hatched red eats into it for a loss.
  const scale = Math.max(o.paid, o.paid + o.gain, 1);
  const [paidEl, deltaEl] = $('#ov-bar').children;
  paidEl.style.flex = `${(o.gain >= 0 ? o.paid : o.paid + o.gain) / scale} 0 0`;
  deltaEl.style.flex = `${Math.abs(o.gain) / scale} 0 0`;
  deltaEl.className = `ov-delta ${o.gain >= 0 ? 'up' : 'down'}`;

  const notes = [];
  if (o.realized) notes.push(`Includes ${signed(o.realized)} from shares you sold${o.historySince ? ` since ${date(o.historySince)}` : ''}.`);
  if (o.unknownCostValue > 0) notes.push(`${usd0.format(o.unknownCostValue)} of holdings with unknown cost are left out.`);
  $('#ov-sub').textContent = notes.join(' ') || 'Cash is not counted.';
}

function overallDrawer() {
  const o = data.overall;
  const accts = data.byInstitution.filter((i) => i.costBasis > 0 || i.gain);
  const held = data.holdings.filter((x) => x.costBasis != null).sort((a, b) => b.costBasis - a.costBasis);
  return {
    label: "What you put in, and what you've made", title: figNodes(o.gain, signed(o.gain)), tone: tone(o.gain),
    sub: `You paid ${money(o.paid)} for what you own now. It's worth ${money(o.worth)}.`,
    body: [
      sec('The math', dl([
        ['You paid for what you hold', money(o.paid)],
        ['It is worth today', money(o.worth)],
        ['Gain or loss on what you hold', signed(o.unrealized), tone(o.unrealized)],
        ['Gain or loss from shares you sold', signed(o.realized), tone(o.realized)],
        ['Total gain or loss', signed(o.gain), tone(o.gain)],
        o.gainPct == null ? null : ['Return on what you paid', pct(o.gainPct, true), tone(o.gainPct)],
      ])),
      sec('By account', dtable([
        ['Account', (i) => i.name, true], ['Paid', (i) => money(i.costBasis)], ['Worth', (i) => money(i.costBasis + i.gain)], ['Gain', (i) => gainCell(i.gain)],
      ], accts, 'No accounts with known cost yet.')),
      sec('By holding', dtable([
        ['Holding', (x) => h('span', { class: 'sym' }, x.ticker ?? x.name), true], ['Paid', (x) => money(x.costBasis)], ['Worth', (x) => money(x.value)], ['Gain', (x) => gainCell(x.gain, x.gainPct)],
      ], held, 'No holdings with known cost yet.')),
      o.realizedByYear.length ? sec('From shares you sold', dtable([
        ['Year', (r) => r.year, true], ['Short-term', (r) => gainCell(r.short)], ['Long-term', (r) => gainCell(r.long)], ['Total', (r) => gainCell(r.total)],
      ], o.realizedByYear)) : null,
      h('p', { class: 'muted' }, `"You paid" is the cost of the shares and coins you hold now, not every dollar you ever deposited. Cash isn't counted.${o.historySince ? ` Sales are counted back to ${date(o.historySince)}, as far as your account history goes.` : ''}${o.unknownCostValue > 0 ? ` ${money(o.unknownCostValue)} of holdings have no known cost (for example coins from staking or transfers) and are left out.` : ''}`),
    ],
  };
}

function gainDrawer() {
  const { totals } = data;
  const withGain = data.holdings.filter((x) => x.gain != null);
  const best = [...withGain].sort((a, b) => b.gain - a.gain).slice(0, 3);
  const worst = [...withGain].filter((x) => x.gain < 0).sort((a, b) => a.gain - b.gain).slice(0, 3);
  const hcols = [['Holding', (x) => h('span', { class: 'sym' }, x.ticker ?? x.name), true], ['Gain', (x) => gainCell(x.gain)], ['Return', (x) => h('span', { class: tone(x.gainPct) }, pct(x.gainPct, true))]];
  return {
    label: 'Unrealized gain or loss', title: figNodes(totals.unrealized, signed(totals.unrealized)), tone: tone(totals.unrealized),
    sub: `${pct(totals.unrealizedPct, true)} on ${money(totals.costBasis)} cost basis. Not taxed until you sell.`,
    body: [
      sec('By holding period', dl(termSummary(data.lots))),
      sec('Biggest winners', dtable(hcols, best.filter((x) => x.gain > 0), 'No winners yet.')),
      sec('Biggest losers', dtable(hcols, worst, 'No holdings are down.')),
    ],
  };
}

function realizedDrawer() {
  const { tax } = data;
  const r = tax.realizedYtd;
  const total = r.short + r.long;
  return {
    label: `Realized in ${tax.taxYear}`, title: figNodes(total, signed(total)), tone: tone(total),
    sub: 'Gains and losses from shares you already sold.',
    body: [
      sec('This year', dl([['Short-term', signed(r.short), tone(r.short)], ['Long-term', signed(r.long), tone(r.long)], r.unknownBasisProceeds ? ['Sales with unknown cost', money(r.unknownBasisProceeds)] : null,
        ['Est. tax after netting', money(tax.estimatedOnRealizedYtd.total)]])),
      sec(`Last year (${tax.priorYear.year})`, dl([['Short-term', signed(tax.priorYear.short), tone(tax.priorYear.short)], ['Long-term', signed(tax.priorYear.long), tone(tax.priorYear.long)], ['Return due', date(tax.priorYear.filingDeadline)]])),
      h('p', { class: 'muted' }, 'Sales are matched oldest shares first, using the transaction history your brokers share.'),
    ],
  };
}

function taxDrawer() {
  const { tax, rates } = data;
  const saved = sum(tax.upcoming, 'taxSavedByWaiting');
  return {
    label: `Estimated tax, ${tax.taxYear} sales`, title: money(tax.estimatedOnRealizedYtd.total),
    sub: `Due with your return on ${date(tax.filingDeadline)}.`,
    body: [
      sec('How it adds up', dl([
        ['Short-term gains', signed(tax.realizedYtd.short), tone(tax.realizedYtd.short)], ['Short-term rate', pct(rates.shortTerm)],
        ['Long-term gains', signed(tax.realizedYtd.long), tone(tax.realizedYtd.long)], ['Long-term rate', pct(rates.longTerm)],
        ['Estimated tax', money(tax.estimatedOnRealizedYtd.total)]])),
      sec('If you sold everything today', dl([['Estimated tax', money(tax.estimatedIfSoldToday.total)], ['Saved by waiting on lots about to turn long-term', money(saved)]])),
      sec('Lots turning long-term soon', dtable(lotCols(true).filter((c) => c[0] !== 'Term'), tax.upcoming, 'None in the next 120 days.')),
    ],
  };
}

function soldTodayDrawer() {
  const { tax } = data;
  const lots = data.lots.filter((l) => l.gain != null).sort((a, b) => b.gain - a.gain);
  return {
    label: 'If you sold everything today', title: money(tax.estimatedIfSoldToday.total), sub: 'Estimated tax on unrealized gains, before any other income.',
    body: [sec('By holding period', dl(termSummary(data.lots))), sec('The lots behind it', dtable(lotCols(true), lots))],
  };
}

function priorDrawer() {
  const p = data.tax.priorYear;
  return {
    label: `Sold in ${p.year}`, title: figNodes(p.short + p.long, signed(p.short + p.long)), tone: tone(p.short + p.long),
    sub: `Reported on the return due ${date(p.filingDeadline)}.`,
    body: [sec('By holding period', dl([['Short-term', signed(p.short), tone(p.short)], ['Long-term', signed(p.long), tone(p.long)], p.unknownBasisProceeds ? ['Sales with unknown cost', money(p.unknownBasisProceeds)] : null])),
      h('p', { class: 'muted' }, 'Your broker\'s 1099-B is the source of truth for this year.')],
  };
}

function holdingDrawer(r) {
  const key = r.ticker ?? r.name;
  const lots = data.lots.filter((l) => l.ticker === key);
  const { rates } = data;
  const st = lots.filter((l) => l.term === 'short');
  const lt = lots.filter((l) => l.term === 'long');
  const taxNow = Math.max(0, sum(st, 'gain')) * rates.shortTerm + Math.max(0, sum(lt, 'gain')) * rates.longTerm;
  return {
    label: r.name, title: key, sub: `${qty(r.quantity)} at ${money(r.price)}. ${TYPE_LABEL[r.type] ?? r.type}.`,
    body: [
      sec('Position', dl([['Value', money(r.value)], ['Cost basis', money(r.costBasis)], ['Gain or loss', `${arrow(r.gain)}${signed(r.gain)}`, tone(r.gain)], ['Return', pct(r.gainPct, true), tone(r.gainPct)], ['Share of portfolio', pct(r.weight)]])),
      sec('Tax status', dl([...termSummary(lots), ['Est. tax if sold today', money(taxNow)]]), h('p', { class: 'muted' }, 'This holding alone, before losses elsewhere offset it.')),
      sec('Accounts', dl(r.institutions.map((i) => [i, money(sum(lots.filter((l) => l.institution === i), 'value'))]))),
      sec('Lots', dtable(lotCols(false), lots)),
    ],
  };
}

const shelterTags = (institution) => [...new Set((data.accounts ?? []).filter((a) => a.institution === institution && a.taxShelter).map((a) => a.taxShelter))];

function institutionDrawer(it) {
  const inst = data.byInstitution.find((i) => i.name === it.institution);
  const lots = data.lots.filter((l) => l.institution === it.institution);
  const accts = (data.accounts ?? []).filter((a) => a.institution === it.institution);
  const sheltered = accts.some((a) => a.taxShelter);
  // Retirement accounts have no tax lots, so fall back to holdings held here.
  const byTicker = lots.length
    ? [...lots.reduce((m, l) => m.set(l.ticker, [...(m.get(l.ticker) ?? []), l]), new Map())]
      .map(([ticker, ls]) => ({ ticker, value: sum(ls, 'value'), gain: ls.some((l) => l.gain == null) ? null : sum(ls, 'gain') }))
      .sort((a, b) => b.value - a.value)
    : data.holdings.filter((x) => x.institutions.includes(it.institution)).map((x) => ({ ticker: x.ticker ?? x.name, value: x.value, gain: x.gain }));
  const actions = [
    it.needsReauth ? h('button', { class: 'btn', type: 'button', onclick: () => { closeDrawer(); openLink(it.itemId); } }, 'Reconnect') : null,
    config.demo || it.removable === false ? null : h('button', { class: 'btn ghost', type: 'button', onclick: () => { closeDrawer(); removeItem(it); } }, 'Disconnect'),
  ].filter(Boolean);
  return {
    label: 'Account', title: it.institution, sub: it.error ?? (inst ? `${pct(inst.weight)} of your portfolio.` : ''),
    body: [
      sec('Totals', dl([['Value', money(inst?.value ?? 0)], ['Cost basis', money(inst?.costBasis)], ['Gain or loss', signed(inst?.gain), tone(inst?.gain)]])),
      sec('Holdings here', dtable([['Holding', (x) => h('span', { class: 'sym' }, x.ticker), true], ['Value', (x) => money(x.value)], ['Gain', (x) => gainCell(x.gain)]], byTicker, 'No investments found.')),
      accts.length > 1 || sheltered ? sec('Accounts', dl(accts.map((a) => [`${a.name}${a.mask ? ` ••${a.mask}` : ''}${a.taxShelter && !a.name.includes(a.taxShelter) ? ` · ${a.taxShelter}` : ''}`, money(a.value)]))) : null,
      sheltered ? h('p', { class: 'muted' }, 'Buying and selling inside a retirement account is not taxed, so these accounts are left out of the tax figures and tax lots. They still count toward your total value and gains.') : null,
      lots.length ? sec('By holding period', dl(termSummary(lots))) : null,
      actions.length ? h('div', { class: 'd-actions' }, actions) : null,
    ].filter(Boolean),
  };
}

function upcomingDrawer(ticker) {
  const lots = data.tax.upcoming.filter((l) => l.ticker === ticker);
  const saved = sum(lots, 'taxSavedByWaiting');
  return {
    label: 'Turning long-term soon', title: ticker, sub: `Waiting saves about ${money(saved)} in tax.`,
    body: [sec('Lots', dtable([
      ['Account', (l) => l.account, true], ['Bought', (l) => date(l.acquired)], ['Long-term on', (l) => date(l.longTermOn)], ['Days', (l) => String(l.daysUntilLongTerm)],
      ['Gain', (l) => gainCell(l.gain)], ['Saved', (l) => h('strong', { class: 'up' }, money(l.taxSavedByWaiting))],
    ], lots))],
  };
}

// --- You should know this -------------------------------------------------
const URG = { urgent: 'Needs attention', useful: 'Worth acting on', fyi: 'Good to know' };
const ACTION = {
  upcoming: 'See the lots', holding: 'See the holding', institution: 'See the account',
  lots: 'See your lots', reauth: 'Reconnect', totals: 'See the breakdown',
  tax: 'See taxes', holdings: 'See holdings', margin: 'See margin', ledger: 'See daily ledger',
};
function runTarget(t, el) {
  const scroll = (sel) => document.querySelector(sel)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  if (t.kind === 'upcoming') showDrawer(upcomingDrawer(t.ticker), el);
  else if (t.kind === 'holding') { const x = data.holdings.find((k) => k.key === t.key); if (x) showDrawer(holdingDrawer(x), el); }
  else if (t.kind === 'institution') { const it = data.items.find((i) => i.institution === t.name); if (it) showDrawer(institutionDrawer(it), el); }
  else if (t.kind === 'reauth') openLink(t.itemId);
  else if (t.kind === 'totals') showDrawer(totalDrawer(), el);
  else if (t.kind === 'holdings') scroll('#holdings-sec');
  else if (t.kind === 'margin') scroll('#margin-sec');
  else if (t.kind === 'ledger') scroll('#ledger-sec');
  else if (t.kind === 'tax' || t.kind === 'lots') location.href = '/taxes.html';
}
const noteSig = (n) => `${n.id}|${n.title}`;
const getDismissed = () => {
  try { return new Set(JSON.parse(localStorage.getItem('dismissedNotes') || '[]')); }
  catch { return new Set(); }
};
const saveDismissed = (set) => localStorage.setItem('dismissedNotes', JSON.stringify([...set]));

function renderNotes() {
  const rawAll = data.insights ?? [];
  const dismissed = getDismissed();
  const all = rawAll.filter((n) => n.urgency === 'urgent' || !dismissed.has(noteSig(n)));
  $('#notes-sec').hidden = !all.length;
  const maxShow = 4;
  const urgent = all.filter((n) => n.urgency === 'urgent');
  const rest = all.filter((n) => n.urgency !== 'urgent');
  const slots = Math.max(0, maxShow - urgent.length);
  const rotated = [];
  if (rest.length && slots > 0) {
    const start = (noteOffset * Math.max(1, Math.min(slots, rest.length))) % rest.length;
    for (let i = 0; i < Math.min(slots, rest.length); i++) {
      rotated.push(rest[(start + i) % rest.length]);
    }
  }
  const list = [...urgent, ...rotated].slice(0, Math.max(maxShow, urgent.length));
  $('#notes-next').hidden = rest.length <= slots;

  $('#notes').replaceChildren(...list.map((n, i) => {
    const id = `note-${i}`;
    const root = h('article', { class: 'note parchment rise', style: { '--i': String(i) } });
    const head = h('button', { class: 'note-head', type: 'button', 'aria-expanded': 'false', 'aria-controls': id,
      onclick: () => { const o = root.classList.toggle('open'); head.setAttribute('aria-expanded', String(o)); } },
      h('span', { class: 'seal', 'aria-hidden': 'true' }, '✶'),
      h('span', { class: 'label' }, URG[n.urgency]), h('h3', {}, n.title), h('p', {}, n.body));
    const dismissBtn = n.urgency === 'urgent' ? null : h('button', {
      class: 'note-dismiss', type: 'button', title: 'Dismiss this note', 'aria-label': `Dismiss ${n.title}`,
      onclick: (e) => {
        e.stopPropagation();
        const d = getDismissed();
        d.add(noteSig(n));
        saveDismissed(d);
        renderNotes();
      },
    }, '✕');
    root.append(head, dismissBtn, h('div', { class: 'more', id },
      h('div', {}, dl(n.details), n.target ? h('button', { class: 'link act', type: 'button', onclick: (e) => runTarget(n.target, e.currentTarget) }, ACTION[n.target.kind] ?? 'Open') : null)));
    return root;
  }));
}

// --- panel wiring -----------------------------------------------------------
const bindPanel = (id, build) => $(id).addEventListener('click', (e) => { if (data) showDrawer(build(), e.currentTarget); });
bindPanel('#p-total', totalDrawer);
bindPanel('#p-gain', gainDrawer);
bindPanel('#p-cash', cashDrawer);
bindPanel('#p-overall', overallDrawer);
$('#p-margin').addEventListener('click', () => {
  $('#margin-sec').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
});

// --- settings: running costs ----------------------------------------------
const RATE_FIELDS = [
  ['plaidPerConnectionMonth', 'Plaid, per connected account per month', 'From your Plaid Dashboard pricing page (Investments).'],
  ['plaidPerCall', 'Plaid, per API call', 'Leave at 0 unless your plan bills per request.'],
  ['flyPerHour', 'Fly.io server, per hour awake', 'shared-cpu-1x with 256 MB. Check fly.io/docs/about/pricing.'],
  ['flyFixedMonthly', 'Fly.io disk, per month', '1 GB volume.'],
];
const money4 = (n) => (n < 1 && n > 0 ? `$${n.toFixed(4)}` : money(n));

async function settingsDrawer() {
  const u = await api('/api/usage');
  const c = u.current;
  const form = h('form', { class: 'rates', onsubmit: async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(RATE_FIELDS.map(([k]) => [k, form.elements[k].value]));
    try {
      await api('/api/settings/rates', { method: 'PUT', body: JSON.stringify(body) });
      showDrawer(await settingsDrawer(), opener);
    } catch (err) { form.querySelector('.msg').textContent = err.message; }
  } },
  RATE_FIELDS.map(([k, label, hint]) => h('label', { class: 'rate' },
    h('span', {}, label), h('input', { id: `rate-${k}`, name: k, type: 'number', step: 'any', min: '0', inputmode: 'decimal', value: String(u.rates[k]) }),
    h('small', { class: 'muted' }, hint))),
  h('div', { class: 'd-actions' }, h('button', { class: 'btn', type: 'submit' }, 'Save rates'), h('span', { class: 'msg muted', role: 'status' })));

  return {
    label: 'Settings', title: ['Running costs ', h('span', { class: 'muted' }, `· ${new Date(`${c.month}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`)],
    sub: `Estimated ${money(c.total)} this month: ${money(c.plaid)} Plaid, ${money(c.fly)} Fly.io. ${money(u.total)} since tracking started.`,
    body: [
      sec('This month', dl([
        ['Plaid accounts connected', String(c.connections.length)],
        ['Plaid API calls', `${c.calls}${c.errors ? ` (${c.errors} failed)` : ''}`],
        ['Plaid estimate', money4(c.plaid)],
        ['Server awake', `${c.awakeHours.toFixed(1)} hours`],
        ['Fly.io estimate', money4(c.fly)],
        ['Total estimate', money4(c.total)],
      ])),
      c.calls ? sec('Plaid calls this month', dl(Object.entries(c.byEndpoint).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, String(n)]))) : null,
      c.connections.length ? sec('Connected through Plaid', dl(c.connections.map((x) => [x.institution, money4(u.rates.plaidPerConnectionMonth)]))) : null,
      u.months.length > 1 ? sec('By month', dtable([
        ['Month', (m) => m.month, true], ['Plaid', (m) => money4(m.plaid)], ['Fly.io', (m) => money4(m.fly)], ['Total', (m) => money4(m.total)],
      ], u.months)) : null,
      sec('Your rates', form),
      h('p', { class: 'muted' }, 'These are estimates from what this app tracks and the rates above. Your real bills are in the Plaid Dashboard (Billing) and on fly.io/dashboard (Billing). Kraken direct is free.'),
    ].filter(Boolean),
  };
}
$('#settings').addEventListener('click', async (e) => {
  const from = e.currentTarget;
  try { showDrawer(await settingsDrawer(), from); } catch (err) { alert(err.message); }
});

// --- wiring ---------------------------------------------------------------
$('#notes-next').addEventListener('click', () => {
  noteOffset += 1;
  sessionStorage.setItem('noteOffset', String(noteOffset));
  renderNotes();
});
document.querySelectorAll('#holdings-view button').forEach((b) => b.addEventListener('click', () => {
  holdingsView = b.dataset.hview;
  holdingsSort = holdingsView === 'account' ? { key: 'where', dir: 1 } : { key: 'value', dir: -1 };
  document.querySelectorAll('#holdings-view button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderHoldings();
}));
$('#margin-toggle').addEventListener('click', () => {
  const form = $('#margin-form');
  form.hidden = !form.hidden;
  $('#margin-toggle').textContent = form.hidden ? '+ Log margin' : 'Cancel';
});
$('#margin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const msg = $('#margin-msg');
  if (config.demo) { msg.textContent = 'Disabled in demo mode.'; return; }
  const [institution, account] = (f.elements.accountKey.value || 'Brokerage::').split('::');
  try {
    await api('/api/margin', {
      method: 'POST',
      body: JSON.stringify({
        kind: f.elements.kind.value,
        institution,
        account,
        date: f.elements.date.value,
        amount: Number(f.elements.amount.value),
        ticker: f.elements.ticker.value,
        note: f.elements.note.value,
      }),
    });
    f.elements.amount.value = '';
    f.elements.ticker.value = '';
    f.elements.note.value = '';
    f.hidden = true;
    $('#margin-toggle').textContent = '+ Log margin';
    msg.textContent = '';
    load();
  } catch (err) { msg.textContent = err.message; }
});
document.querySelectorAll('.ledger-range button').forEach((b) => b.addEventListener('click', () => {
  ledgerRange = b.dataset.range;
  document.querySelectorAll('.ledger-range button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderLedger();
}));
$('#ledger-filter').addEventListener('change', (e) => {
  ledgerFilter = e.target.value;
  hiddenLines.clear();
  yZoom = 1;
  yOffset = 0;
  renderLedger();
});
document.querySelectorAll('#ledger-scale button').forEach((b) => b.addEventListener('click', () => {
  ledgerScale = b.dataset.scale;
  yZoom = 1;
  yOffset = 0;
  document.querySelectorAll('#ledger-scale button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderLedger();
}));
$('#y-pan-up').addEventListener('click', () => { yOffset += 0.25 / yZoom; clampYOffset(); renderLedger(); });
$('#y-pan-down').addEventListener('click', () => { yOffset -= 0.25 / yZoom; clampYOffset(); renderLedger(); });
$('#y-zoom-in').addEventListener('click', () => { yZoom = Math.min(16, yZoom * 1.4); clampYOffset(); renderLedger(); });
$('#y-zoom-out').addEventListener('click', () => { yZoom = Math.max(0.25, yZoom / 1.4); clampYOffset(); renderLedger(); });
$('#y-zoom-reset').addEventListener('click', () => { yZoom = 1; yOffset = 0; renderLedger(); });
$('#acct-prev').addEventListener('click', () => { acctIndex -= 1; renderAccountExplorer(); });
$('#acct-next').addEventListener('click', () => { acctIndex += 1; renderAccountExplorer(); });
const blurBtn = $('#blur');
const setBlur = (on) => {
  document.body.classList.toggle('blurred', on);
  blurBtn.setAttribute('aria-pressed', String(on));
  blurBtn.textContent = on ? 'Unblur' : 'Blur';
};
setBlur(localStorage.getItem('blur') === '1');
blurBtn.addEventListener('click', () => {
  const on = !document.body.classList.contains('blurred');
  localStorage.setItem('blur', on ? '1' : '0');
  setBlur(on);
});
$('#refresh').addEventListener('click', () => load(true));
$('#add').addEventListener('click', () => openLink());

config = await api('/api/config');
$('#env').textContent = config.env;
if (config.demo) $('#add').disabled = true;
if (config.hosted) {
  await new Promise((ok) => document.head.append(h('script', { src: '/vendor/webauthn.js', onload: ok, onerror: ok })));
  const { startRegistration } = window.SimpleWebAuthnBrowser ?? {};
  const addKey = async () => {
    try {
      const { challengeId, options } = await api('/auth/register/options', { method: 'POST', body: '{}' });
      const response = await startRegistration({ optionsJSON: options });
      await api('/auth/register/verify', { method: 'POST', body: JSON.stringify({ challengeId, response, name: navigator.platform || 'Device' }) });
      alert('Passkey added. You can sign in with it now.');
    } catch (err) { if (err.name !== 'NotAllowedError') alert(err.message); }
  };
  const signOut = async () => { await api('/auth/logout', { method: 'POST', body: '{}' }).catch(() => {}); location.replace('/login.html'); };
  $('.actions').append(
    startRegistration ? h('button', { class: 'btn ghost', type: 'button', onclick: addKey, title: 'Add a passkey from another device or password manager' }, 'Add passkey') : null,
    h('button', { class: 'btn ghost', type: 'button', onclick: signOut }, 'Sign out'),
  );
}
load();
