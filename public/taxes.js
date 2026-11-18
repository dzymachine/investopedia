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
const money = (n) => (n == null ? '–' : usd.format(n));
const signed = (n) => (n == null ? '–' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${usd.format(Math.abs(n))}`);
const pct = (n, sign = false) => (n == null ? '–'
  : `${sign && n > 0 ? '+' : n < 0 ? '−' : ''}${(Math.abs(n) * 100).toFixed(Math.abs(n) < 0.1 ? 2 : 1)}%`);
const qty = (n) => n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 6 : 4 });
const tone = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const arrow = (n) => (n > 0 ? '▲ ' : n < 0 ? '▼ ' : '');
const date = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '–');
const figNodes = (n, text) => [n ? h('i', { class: 'arr', 'aria-hidden': 'true' }, arrow(n).trim()) : null, text];
const termLabel = (l) => (l.term === 'long' ? 'Long-term' : `Short, long on ${date(l.longTermOn)}`);
const sum = (xs, k) => xs.reduce((a, x) => a + (x[k] ?? 0), 0);

let data = null;
let lotTerm = 'all';

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && body.code === 'AUTH') { location.replace('/login.html'); throw new Error('Sign in required.'); }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function table(el, columns, rows, { empty } = {}) {
  const thead = h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.left ? 'l' : null, scope: 'col' }, c.label))));
  const body = rows.length
    ? rows.map((r) => h('tr', {}, columns.map((c) => h('td', { class: c.left ? 'l' : null }, c.cell(r)))))
    : [h('tr', {}, h('td', { class: 'none', colspan: columns.length }, empty ?? 'Nothing here yet.'))];
  $(el).replaceChildren(thead, h('tbody', {}, body));
}

const gainCell = (n) => h('span', { class: tone(n) }, signed(n));
const dl = (rows) => h('dl', { class: 'tnum' }, rows.filter(Boolean).map(([k, v, cls]) => [h('dt', {}, k), h('dd', { class: cls }, v)]));
const sec = (title, ...kids) => h('section', {}, h('h3', {}, title), kids);
const dtable = (cols, rows, empty = 'Nothing here.') => h('div', { class: 'table-wrap' }, h('table', {},
  h('thead', {}, h('tr', {}, cols.map(([label, , left]) => h('th', { class: left ? 'l' : null, scope: 'col' }, label)))),
  h('tbody', {}, rows.length ? rows.map((r) => h('tr', {}, cols.map(([, f, left]) => h('td', { class: left ? 'l' : null }, f(r)))))
    : h('tr', {}, h('td', { class: 'none', colspan: cols.length }, empty)))));

const drawerEl = $('#drawer');
let opener = null;
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
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

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
      h('p', { class: 'muted' }, "Your broker's 1099-B is the source of truth for this year.")],
  };
}

function taxCard(title, rows, total, drawer) {
  return h('button', { class: 'tax-card', type: 'button', onclick: (e) => showDrawer(drawer, e.currentTarget) },
    h('span', { class: 'glow' }), h('span', { class: 'open' }, 'Open ›'),
    h('h4', {}, title),
    h('dl', {}, rows.map(([k, v, cls]) => [h('dt', {}, k), h('dd', { class: cls }, v)]),
      total ? [h('dt', { class: 'total' }, total[0]), h('dd', { class: 'total' }, total[1])] : null));
}

function renderTax() {
  const { tax, rates } = data;
  $('#t-deadline').textContent = date(tax.filingDeadline);
  const r = tax.realizedYtd;
  const p = tax.priorYear;
  const u = tax.unrealized;
  const rateNote = `${pct(rates.shortTerm)} short · ${pct(rates.longTerm)} long`;
  $('#tax-grid').replaceChildren(
    taxCard(`Sold in ${tax.taxYear}`, [
      ['Short-term gains', signed(r.short), tone(r.short)],
      ['Long-term gains', signed(r.long), tone(r.long)],
      r.unknownBasisProceeds ? ['Sales with unknown cost', money(r.unknownBasisProceeds)] : null,
    ].filter(Boolean), ['Est. tax', money(tax.estimatedOnRealizedYtd.total)], realizedDrawer()),
    taxCard('If you sold everything today', [
      ['Short-term gains', signed(u.short), tone(u.short)],
      ['Long-term gains', signed(u.long), tone(u.long)],
      ['Rates', rateNote],
    ], ['Est. tax', money(tax.estimatedIfSoldToday.total)], soldTodayDrawer()),
    taxCard(`Sold in ${p.year}`, [
      ['Short-term gains', signed(p.short), tone(p.short)],
      ['Long-term gains', signed(p.long), tone(p.long)],
      p.unknownBasisProceeds ? ['Sales with unknown cost', money(p.unknownBasisProceeds)] : null,
      ['Return due', date(p.filingDeadline)],
    ].filter(Boolean), null, priorDrawer()),
  );

  table('#upcoming', [
    { label: 'Holding', left: true, cell: (l) => h('span', { class: 'sym' }, l.ticker) },
    { label: 'Account', left: true, cell: (l) => l.institution },
    { label: 'Bought', cell: (l) => date(l.acquired) },
    { label: 'Long-term on', cell: (l) => h('strong', {}, date(l.longTermOn)) },
    { label: 'Days left', cell: (l) => String(l.daysUntilLongTerm) },
    { label: 'Gain', cell: (l) => gainCell(l.gain) },
    { label: 'Tax saved by waiting', cell: (l) => h('strong', { class: 'up' }, money(l.taxSavedByWaiting)) },
  ], tax.upcoming, { empty: 'No gains turn long-term in the next 120 days.' });
}

function renderLots() {
  const rows = data.lots.filter((l) => lotTerm === 'all' || l.term === lotTerm);
  table('#lots', [
    { label: 'Holding', left: true, cell: (l) => h('span', { class: 'sym' }, l.ticker) },
    { label: 'Account', left: true, cell: (l) => l.institution },
    { label: 'Bought', cell: (l) => (l.acquired ? date(l.acquired) : h('span', { class: 'muted', title: 'Before your available transaction history' }, `before ${date(l.acquiredBefore)}`)) },
    { label: 'Quantity', cell: (l) => qty(l.quantity) },
    { label: 'Cost', cell: (l) => money(l.costBasis) },
    { label: 'Value', cell: (l) => money(l.value) },
    { label: 'Gain / loss', cell: (l) => gainCell(l.gain) },
    { label: 'Term', cell: (l) => h('span', { class: 'pill' }, termLabel(l)) },
  ], rows, { empty: 'No lots match.' });
}

async function load(fresh = false) {
  $('#refresh').disabled = true;
  $('#asof').textContent = 'Loading…';
  try {
    data = await api(fresh === true ? '/api/portfolio?fresh=1' : '/api/portfolio');
    $('#asof').textContent = `As of ${date(data.asOf)}`;
    renderTax();
    renderLots();
  } catch (err) {
    $('#alerts').replaceChildren(h('div', { class: 'alert' }, err.message));
    $('#asof').textContent = '';
  } finally {
    $('#refresh').disabled = false;
  }
}

document.querySelectorAll('#lots-sec .seg button').forEach((b) => b.addEventListener('click', () => {
  lotTerm = b.dataset.term;
  document.querySelectorAll('#lots-sec .seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderLots();
}));

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

const config = await api('/api/config');
$('#env').textContent = config.env;
load();
