// public/app.js - logika dashboardu: przelacznik portfeli, taby, tabele, wykresy, CRUD.
import {
  api, setCsrf, $, $$, el, clear, td, toast, debounce, todayIso,
  fmtPln, fmtK, fmtNum, fmtPct, fmtSigned, fmtDateTime, signClass, isNum, ApiError,
} from './ui.js';
import { lineChart, multiLineChart, barChart, seriesMeta } from './charts.js';
import { renderImportTab } from './import.js';
import { t, applyStatic, languageSwitcher, getLocale } from './i18n.js';

const STORE_KEY = 'mpd.v2.prefs';
const RANGE_POINTS = { T: 7, M: 31, Q: 92, Y: 366, A: Infinity };
const BENCHMARK_TTL_MS = 15 * 60 * 1000;
const BENCHMARK_COLORS = { WIG20: '#f6c85f', MWIG40TR: '#ff8d8d', NDX: '#7a5cff', SPX: '#7cffb2' };

const state = {
  user: null,
  portfolios: [],
  scope: 'all',            // 'all' albo id portfela
  data: null,
  tab: 'portfolio',
  valueRange: 'Q',
  symbolRange: 'Y',
  region: 'ALL',
  selectedSymbol: null,
  sort: { key: 'valuePln', dir: -1 },
  txFilter: { text: '', side: 'ALL' },
  editingTx: null,
  editingCf: null,
  hiddenBenchmarks: new Set(),
  benchmarks: new Map(),   // id -> { at, points }
  loading: false,
};

// ---------------------------------------------------------------- preferencje

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
    Object.assign(state, {
      scope: saved.scope ?? 'all',
      tab: saved.tab ?? 'portfolio',
      valueRange: saved.valueRange ?? 'Q',
      symbolRange: saved.symbolRange ?? 'Y',
      region: saved.region ?? 'ALL',
    });
  } catch { /* preferencje sa opcjonalne */ }
}

const savePrefs = debounce(() => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      scope: state.scope, tab: state.tab, valueRange: state.valueRange,
      symbolRange: state.symbolRange, region: state.region,
    }));
  } catch { /* prywatny tryb przegladarki */ }
}, 300);

// ---------------------------------------------------------------- start

async function boot() {
  loadPrefs();
  applyStatic();
  bindStaticHandlers();
  $('#lang-switch').append(languageSwitcher(() => {
    // Zmiana jezyka przerysowuje caly widok - dane zostaja, zmienia sie tylko warstwa prezentacji.
    applyStatic();
    if (state.data) render(); else renderTabs();
  }));
  try {
    const me = await api('/auth/me');
    setCsrf(me.csrfToken);
    state.user = me.user;
    state.portfolios = me.portfolios;
    if (state.scope !== 'all' && !state.portfolios.some((p) => p.id === state.scope)) state.scope = 'all';
    $('#panel-admin').classList.toggle('hidden', !['owner', 'admin'].includes(me.user.role));
    await refresh();
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) toast(err.message, 'error');
  }
}

async function refresh({ force = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  $('#btn-refresh').disabled = true;
  try {
    const query = `portfolio=${encodeURIComponent(state.scope)}${force ? '&force=1' : ''}`;
    state.data = await api(`/dashboard?${query}`);
    state.portfolios = state.data.portfolios?.length
      ? state.data.portfolios.map((p) => ({ ...p }))
      : state.portfolios;
    render();
  } catch (err) {
    toast(t('toast.loadFailed', { error: err.message }), 'error');
  } finally {
    state.loading = false;
    $('#btn-refresh').disabled = false;
  }
}

// ---------------------------------------------------------------- render glowny

function render() {
  renderSwitcher();
  renderHeader();
  renderBanners();
  renderCards();
  renderBreakdown();
  renderTabs();

  const renderers = {
    portfolio: renderPortfolioTab,
    transactions: renderTransactionsTab,
    closed: renderClosedTab,
    cash: renderCashTab,
    perticker: renderPerTickerTab,
    manage: renderManageTab,
    import: renderImport,
    account: renderAccountTab,
  };
  renderers[state.tab]?.();
}

const isAll = () => state.scope === 'all';
const activePortfolio = () => state.portfolios.find((p) => p.id === state.scope) ?? null;

function renderHeader() {
  const data = state.data;
  const parts = [`${t('app.updated')}: ${fmtDateTime(data?.asOf)}`];
  if (data?.cached) parts.push(t('app.cache', { seconds: Math.round(data.cacheAgeMs / 1000) }));
  if (data?.marketDataStatus?.offline) parts.push(t('app.offlineMode'));
  const coverage = data?.marketDataStatus?.quoteCoverage;
  if (coverage?.total) parts.push(t('app.quotes', { fresh: coverage.fresh, total: coverage.total }));
  $('#as-of').textContent = parts.join(' | ');
}

function renderSwitcher() {
  const host = clear($('#pf-switch'));
  const total = state.data?.totals?.totalPln;

  host.append(el('button', {
    class: 'pf-chip all',
    'aria-pressed': String(isAll()),
    onclick: () => selectScope('all'),
  }, [
    el('span', { class: 'dot' }),
    t('app.allPortfolios'),
    isAll() && isNum(total) ? el('span', { class: 'val', text: fmtPln(total) }) : null,
  ]));

  for (const portfolio of state.portfolios) {
    const selected = state.scope === portfolio.id;
    host.append(el('button', {
      class: 'pf-chip',
      'aria-pressed': String(selected),
      title: `${portfolio.name}${portfolio.broker ? ` (${portfolio.broker})` : ''}`,
      onclick: () => selectScope(portfolio.id),
    }, [
      el('span', { class: 'dot', style: `background:${portfolio.color}` }),
      portfolio.name,
      isNum(portfolio.totalPln) ? el('span', { class: 'val', text: fmtPln(portfolio.totalPln) }) : null,
    ]));
  }
}

function selectScope(scope) {
  if (state.scope === scope) return;
  state.scope = scope;
  state.selectedSymbol = null;
  savePrefs();
  refresh();
}

function renderBanners() {
  const host = clear($('#banners'));
  const status = state.data?.marketDataStatus;

  if (state.data?.empty) {
    host.append(el('div', { class: 'banner', text: t('banner.noPortfolios') }));
    return;
  }
  if (status?.historyBlocked) {
    host.append(el('div', {
      class: 'banner',
      text: t('banner.historyBlocked', {
        fresh: status.quoteCoverage.fresh,
        total: status.quoteCoverage.total,
      }),
    }));
  }
  for (const warning of state.data?.warnings ?? []) {
    host.append(el('div', { class: 'banner', text: t('banner.warning', { message: warning.message }) }));
  }
  const brokenProviders = (status?.providers ?? []).filter((p) => p.open);
  if (brokenProviders.length) {
    host.append(el('div', {
      class: 'banner',
      text: t('banner.providersDown', { list: brokenProviders.map((p) => p.provider).join(', ') }),
    }));
  }
}

// ---------------------------------------------------------------- karty

function card(key, value, sub, cls = '') {
  return el('div', { class: 'card' }, [
    el('div', { class: 'k', text: key }),
    el('div', { class: `v ${cls}`, text: value }),
    sub ? el('div', { class: 's', text: sub }) : null,
  ]);
}

function renderCards() {
  const host = clear($('#cards'));
  const data = state.data;
  if (!data || data.empty) return;

  const sum = data.totals;
  const p = data.performance ?? {};
  const fx = data.fx?.rates ?? {};

  const perf = (labelKey, entry) => card(
    t(labelKey),
    entry ? fmtSigned(entry.pln) : '-',
    entry ? t('card.perfSub', { pct: fmtPct(entry.pct), day: entry.baseDay }) : t('card.noHistory'),
    signClass(entry?.pln),
  );

  host.append(
    card(t('card.totalValue'), fmtPln(sum.totalPln),
      isAll() ? t('card.portfolioCount', { count: data.scope.portfolioCount }) : activePortfolio()?.broker || ''),
    perf('card.day', p.day),
    perf('card.mtd', p.mtd),
    perf('card.ytd', p.ytd),
    card(t('card.sinceStart'), p.sinceStart ? fmtSigned(p.sinceStart.pln) : '-',
      p.sinceStart ? t('card.sinceStartSub', { day: p.sinceStart.baseDay }) : '', signClass(p.sinceStart?.pln)),
    card(t('card.netDeposits'), fmtPln(sum.externalNetPln), t('card.netDepositsSub')),
    card(t('card.returnOnCapital'), fmtPct(sum.returnOnCapitalPct), t('card.returnOnCapitalSub'), signClass(sum.returnOnCapitalPct)),
    card(t('card.invested'), fmtPln(sum.investedPln),
      t('card.investedSub', { pct: fmtPct((sum.investedPln / (sum.totalPln || 1)) * 100, { sign: false }) })),
    card(t('card.cash'), fmtPln(sum.cashPln), Object.entries(data.cash?.byCurrency ?? {})
      .filter(([, v]) => Math.abs(v) > 0.01)
      .map(([code, v]) => `${fmtNum(v, 0)} ${code}`).join(' | ')),
    card(t('card.realized'), fmtSigned(sum.realizedPlnTotal),
      `${sum.taxYear}: ${fmtSigned(sum.realizedPlnCurrentYear)}`, signClass(sum.realizedPlnTotal)),
    card(t('card.tax', { year: sum.taxYear }), fmtPln(sum.estimatedTaxPln), t('card.taxSub', { rate: '19%' })),
    card(t('card.dividends'), fmtPln(sum.dividendsPln), t('card.dividendsSub')),
    card(t('card.top5'), fmtPct(sum.top5Pct, { sign: false }), t('card.top5Sub')),
    card('USDPLN', fmtNum(fx.USDPLN, 4), data.fx?.sources?.USDPLN),
    card('EURPLN', fmtNum(fx.EURPLN, 4), data.fx?.sources?.EURPLN),
  );
}

function renderBreakdown() {
  const panel = $('#panel-breakdown');
  panel.classList.toggle('hidden', !isAll() || !state.data?.portfolios?.length);
  if (panel.classList.contains('hidden')) return;

  const body = clear($('#tbl-breakdown tbody'));
  for (const portfolio of state.data.portfolios) {
    body.append(el('tr', { class: 'clickable', onclick: () => selectScope(portfolio.id) }, [
      el('td', { class: 'left' }, [
        el('span', { class: 'pf-tag' }, [el('span', { class: 'dot', style: `background:${portfolio.color}` }), portfolio.name]),
      ]),
      td(fmtPln(portfolio.totalPln)),
      td(fmtPln(portfolio.investedPln)),
      td(fmtPln(portfolio.cashPln)),
      td(String(portfolio.positionCount)),
      td(fmtSigned(portfolio.realizedPln), { cls: signClass(portfolio.realizedPln) }),
      td(fmtPct(portfolio.weightPct, { sign: false })),
    ]));
  }
}

function renderTabs() {
  for (const button of $$('#tabs button')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === state.tab));
  }
  for (const tab of ['portfolio', 'transactions', 'closed', 'cash', 'perticker', 'manage', 'import', 'account']) {
    $(`#tab-${tab}`).classList.toggle('hidden', tab !== state.tab);
  }
}

// ---------------------------------------------------------------- TAB: import

/**
 * Import dotyczy zawsze jednego portfela - w widoku skonsolidowanym nie ma
 * odpowiedzi na pytanie, do ktorego portfela mialyby trafic wiersze z pliku.
 */
function renderImport() {
  const portfolio = activePortfolio();
  renderImportTab({
    portfolioId: portfolio?.id ?? null,
    portfolioName: portfolio?.name ?? '',
    onImported: () => { refresh(); },
  });
}

// ---------------------------------------------------------------- TAB: portfel

function slicedHistory() {
  const history = state.data?.history ?? [];
  const limit = RANGE_POINTS[state.valueRange];
  return limit === Infinity ? history : history.slice(-limit);
}

function metaRow(host, entries) {
  const node = clear(host);
  for (const [label, value, cls] of entries) {
    if (value === null || value === undefined) continue;
    node.append(el('span', {}, [`${label}: `, el('b', { class: cls ?? '', text: String(value) })]));
  }
}

function renderPortfolioTab() {
  if (!state.data || state.data.empty) return;

  // --- wykres wartosci
  const history = slicedHistory().map((p) => ({ day: p.day, value: p.totalPln, provisional: p.provisional }));
  clear($('#chart-value')).append(lineChart(history, { format: (v) => `${Math.round(v / 1000)}k` }));
  const meta = seriesMeta(history);
  const last = state.data.history[state.data.history.length - 1];
  const externalInRange = (state.data.cashFlows ?? [])
    .filter((f) => ['Deposit', 'Withdrawal'].includes(f.type) && meta && f.flow_date >= meta.from)
    .reduce((sum, f) => sum + f.amount * (state.data.fx.rates[`${f.currency}PLN`] ?? 1), 0);

  metaRow($('#meta-value'), meta ? [
    [t('meta.points'), meta.count],
    [t('meta.range'), `${meta.from} - ${meta.to}`],
    [t('meta.last'), `${fmtPln(meta.last)}${last?.provisional ? ` (${t('meta.intraday')})` : ''}`],
    [t('meta.max'), `${fmtPln(meta.maxValue)} (${meta.maxDay})`],
    [t('meta.change'), fmtSigned(meta.change), signClass(meta.change)],
    [t('meta.exDeposits'), fmtSigned(meta.change - externalInRange), signClass(meta.change - externalInRange)],
  ] : [[t('meta.status'), t('meta.noHistory')]]);

  // --- indeks TWR + benchmarki
  renderIndexChart();

  // --- sektory
  const sectors = clear($('#sectors'));
  if (!state.data.sectors?.length) {
    sectors.append(el('div', { class: 'empty', text: t('table.noSectors') }));
  }
  for (const item of state.data.sectors ?? []) {
    sectors.append(el('div', { class: 'sector-row' }, [
      el('span', { class: 'nowrap', title: item.sector, text: item.sector }),
      el('div', { class: 'bar' }, [el('i', { style: `width:${Math.max(1, item.pct).toFixed(1)}%` })]),
      el('span', { class: 'right muted', text: fmtPct(item.pct, { sign: false, decimals: 1 }) }),
    ]));
  }

  renderPositions();
  renderSymbolChart();
}

async function renderIndexChart() {
  const index = state.data.twrIndex ?? [];
  const limit = RANGE_POINTS[state.valueRange];
  const sliced = limit === Infinity ? index : index.slice(-limit);
  if (sliced.length < 2) {
    clear($('#chart-index')).append(multiLineChart([]));
    metaRow($('#meta-index'), [[t('meta.status'), t('meta.notEnoughTwr')]]);
    return;
  }
  const base = sliced[0].index || 100;
  const portfolioSeries = sliced.map((p) => ({ day: p.day, value: (p.index / base) * 100 }));
  const from = portfolioSeries[0].day;

  const series = [{ label: t('chart.portfolio'), color: '#4fc3f7', points: portfolioSeries, emphasis: true }];
  for (const [id, points] of await loadBenchmarks(state.valueRange)) {
    if (state.hiddenBenchmarks.has(id)) continue;
    const inRange = points.filter((p) => p.day >= from);
    if (inRange.length < 2) continue;
    const first = inRange[0].value;
    series.push({
      label: id, color: BENCHMARK_COLORS[id] ?? '#8b98c4', dashed: true,
      points: inRange.map((p) => ({ day: p.day, value: (p.value / first) * 100 })),
    });
  }

  clear($('#chart-index')).append(multiLineChart(series, { format: (v) => v.toFixed(0) }));

  const legend = clear($('#legend-index'));
  legend.append(el('span', {}, [el('i', { style: 'background:#4fc3f7' }), t('chart.portfolio')]));
  for (const id of Object.keys(BENCHMARK_COLORS)) {
    const hidden = state.hiddenBenchmarks.has(id);
    legend.append(el('span', {
      class: hidden ? 'off' : '',
      onclick: () => {
        if (hidden) state.hiddenBenchmarks.delete(id); else state.hiddenBenchmarks.add(id);
        renderIndexChart();
      },
    }, [el('i', { style: `background:${BENCHMARK_COLORS[id]}` }), id]));
  }

  const meta = seriesMeta(portfolioSeries);
  metaRow($('#meta-index'), meta ? [
    [t('meta.range'), `${meta.from} - ${meta.to}`],
    [t('meta.start'), fmtNum(meta.first, 1)],
    [t('meta.end'), fmtNum(meta.last, 1)],
    [t('meta.max'), `${fmtNum(meta.maxValue, 1)} (${meta.maxDay})`],
    [t('meta.change'), fmtPct(meta.last - 100), signClass(meta.last - 100)],
  ] : []);
}

/** Benchmarki sa cache'owane po stronie przegladarki - nie odpytujemy ich przy kazdym renderze. */
async function loadBenchmarks(range) {
  const out = new Map();
  const wanted = Object.keys(BENCHMARK_COLORS).filter((id) => !state.hiddenBenchmarks.has(id));
  await Promise.all(wanted.map(async (id) => {
    const key = `${id}|${range}`;
    const hit = state.benchmarks.get(key);
    if (hit && Date.now() - hit.at < BENCHMARK_TTL_MS) { out.set(id, hit.points); return; }
    try {
      const symbol = { WIG20: '^WIG20', MWIG40TR: 'MWIG40TR', NDX: '^NDX', SPX: '^GSPC' }[id];
      const res = await api(`/price-history?symbol=${encodeURIComponent(symbol)}&range=${range}`);
      state.benchmarks.set(key, { at: Date.now(), points: res.points });
      out.set(id, res.points);
    } catch { /* benchmark jest opcjonalny - brak danych nie psuje wykresu portfela */ }
  }));
  return out;
}

function visiblePositions() {
  const rows = (state.data.positions ?? []).filter((p) => state.region === 'ALL' || p.region === state.region);
  const { key, dir } = state.sort;
  return [...rows].sort((a, b) => {
    const va = a[key];
    const vb = b[key];
    if (typeof va === 'string' || typeof vb === 'string') return String(va).localeCompare(String(vb)) * dir;
    return ((va ?? -Infinity) - (vb ?? -Infinity)) * dir;
  });
}

function renderPositions() {
  const body = clear($('#tbl-positions tbody'));
  const rows = visiblePositions();

  if (!rows.length) {
    body.append(el('tr', {}, [el('td', { colspan: 11, class: 'empty left', text: t('table.noPositions') })]));
  }

  for (const position of rows) {
    const nameCell = el('td', { class: 'left clickable', onclick: () => selectSymbol(position.symbol) }, [
      el('span', { class: 'trunc', title: `${position.name} (${position.symbol})`, text: position.name }),
      isAll() && position.sources?.length > 1
        ? el('span', { class: 'pf-tag', title: position.sources.map((s) => s.portfolioName).join(', '), text: ` ${position.sources.length}x` })
        : (isAll() && position.sources?.length === 1
          ? el('span', { class: 'pf-tag' }, [el('span', { class: 'dot', style: `background:${position.sources[0].color}` })])
          : null),
    ]);

    const noteInput = el('input', {
      value: position.note ?? '',
      placeholder: '-',
      disabled: isAll(),
      title: isAll() ? t('form.noteReadOnlyInAll') : '',
    });
    const saveNote = debounce(() => persistNote(position.symbol, { note: noteInput.value }), 700);
    noteInput.addEventListener('input', saveNote);
    noteInput.addEventListener('blur', () => persistNote(position.symbol, { note: noteInput.value }));

    body.append(el('tr', {}, [
      nameCell,
      td(fmtK(position.valuePln), { title: fmtPln(position.valuePln, { decimals: true }) }),
      td(fmtPct(position.dayPct), { cls: signClass(position.dayPct) }),
      td(`${fmtK(position.pnlPln)} / ${fmtPct(position.pnlPct)}`, { cls: signClass(position.pnlPln) }),
      td(`${fmtNum(position.price, 2)} ${position.currency}`, {
        title: `${t('meta.source')}: ${position.priceSource}${position.priceFresh ? '' : ` (${t('banner.priceStale')})`}`,
        cls: position.priceFresh ? '' : 'warn',
      }),
      td(fmtNum(position.qty, 0)),
      td(fmtPct(position.weight, { sign: false, decimals: 1 })),
      el('td', { class: 'left' }, [el('span', { class: 'trunc', title: position.plan ?? '', text: position.plan ?? '-' })]),
      td(position.stopLoss ? fmtNum(position.stopLoss, 2) : '-'),
      el('td', { class: 'left', text: position.sector }),
      el('td', { class: 'left' }, [noteInput]),
    ]));
  }

  const totals = rows.reduce((acc, p) => ({
    value: acc.value + p.valuePln,
    pnl: acc.pnl + p.pnlPln,
    day: acc.day + (p.dayPln ?? 0),
  }), { value: 0, pnl: 0, day: 0 });

  clear($('#tbl-positions tfoot')).append(el('tr', {}, [
    el('td', { class: 'left', text: t('table.positionCount', { count: rows.length }) }),
    td(fmtK(totals.value)),
    td(fmtSigned(totals.day, fmtK), { cls: signClass(totals.day) }),
    td(fmtSigned(totals.pnl, fmtK), { cls: signClass(totals.pnl) }),
    td(''), td(''), td(''), el('td', {}), el('td', {}), el('td', {}), el('td', {}),
  ]));
}

async function persistNote(symbol, payload) {
  if (isAll()) return;
  try {
    await api(`/portfolios/${state.scope}/notes`, { method: 'PUT', body: { symbol, ...payload } });
  } catch (err) {
    toast(t('toast.noteFailed', { error: err.message }), 'error');
  }
}

function selectSymbol(symbol) {
  state.selectedSymbol = symbol;
  renderSymbolChart();
  $('#chart-symbol').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function renderSymbolChart() {
  const symbol = state.selectedSymbol;
  $('#symbol-title').textContent = symbol ?? t('chart.pickInstrument');
  if (!symbol) {
    clear($('#chart-symbol')).append(lineChart([]));
    metaRow($('#meta-symbol'), []);
    return;
  }
  try {
    const res = await api(`/price-history?symbol=${encodeURIComponent(symbol)}&range=${state.symbolRange}`);
    let points = res.points;
    if (!points.length) {
      // Fallback: odtworzenie sciezki z wlasnych transakcji i biezacej ceny.
      const own = (state.data.transactions ?? [])
        .filter((row) => row.ticker === symbol)
        .map((row) => ({ day: row.trade_date, value: row.price }));
      const position = (state.data.positions ?? []).find((p) => p.symbol === symbol);
      if (position) own.push({ day: todayIso(), value: position.price });
      points = own;
    }
    clear($('#chart-symbol')).append(lineChart(points, { color: '#f6c85f', fill: false, format: (v) => fmtNum(v, 2) }));
    const meta = seriesMeta(points);
    metaRow($('#meta-symbol'), meta ? [
      [t('meta.source'), res.provider === 'none' ? t('meta.ownTransactions') : res.provider],
      [t('meta.range'), `${meta.from} - ${meta.to}`],
      [t('meta.start'), fmtNum(meta.first, 2)],
      [t('meta.end'), fmtNum(meta.last, 2)],
      [t('meta.max'), `${fmtNum(meta.maxValue, 2)} (${meta.maxDay})`],
      [t('meta.change'), fmtPct(meta.changePct), signClass(meta.changePct)],
    ] : [[t('meta.status'), t('meta.noData')]]);
  } catch (err) {
    toast(t('toast.historyUnavailable', { error: err.message }), 'error');
  }
}

// ---------------------------------------------------------------- TAB: transakcje

function scopeFormState(formId, hintId, submitId) {
  const disabled = isAll();
  for (const field of $$(`#${formId} input, #${formId} select, #${formId} button`)) field.disabled = disabled;
  $(`#${hintId}`).textContent = disabled
    ? t('form.pickPortfolioFirst')
    : t('form.writesTo', { portfolio: activePortfolio()?.name ?? '' });
  void submitId;
}

function pfTag(row) {
  if (!isAll()) return el('td', { class: 'left hidden' });
  return el('td', { class: 'left' }, [
    el('span', { class: 'pf-tag' }, [
      el('span', { class: 'dot', style: `background:${row.portfolioColor ?? '#4fc3f7'}` }),
      row.portfolioName ?? '',
    ]),
  ]);
}

function togglePortfolioColumns(tableId, index) {
  const table = $(`#${tableId}`);
  const show = isAll();
  const header = table.querySelectorAll('thead th')[index];
  if (header) header.classList.toggle('hidden', !show);
  for (const row of table.querySelectorAll('tbody tr, tfoot tr')) {
    const cell = row.children[index];
    if (cell) cell.classList.toggle('hidden', !show);
  }
}

function renderTransactionsTab() {
  scopeFormState('form-tx', 'tx-form-hint', 'tx-submit');
  const body = clear($('#tbl-tx tbody'));
  const filter = state.txFilter;
  const rows = (state.data?.transactions ?? []).filter((row) => {
    if (filter.side !== 'ALL' && row.side !== filter.side) return false;
    if (!filter.text) return true;
    const needle = filter.text.toLowerCase();
    return row.ticker.toLowerCase().includes(needle) || String(row.name).toLowerCase().includes(needle);
  }).slice().reverse();

  if (!rows.length) {
    body.append(el('tr', {}, [el('td', { colspan: 14, class: 'empty left', text: t('table.noTransactions') })]));
  }

  let sumQty = 0;
  let sumValue = 0;
  let sumRealized = 0;

  for (const row of rows) {
    sumQty += row.qty;
    sumValue += (row.side === 'BUY' ? -1 : 1) * row.valuePln;
    sumRealized += row.realizedPnlPln ?? 0;

    body.append(el('tr', {}, [
      el('td', { class: 'left', text: row.trade_date }),
      pfTag(row),
      td(row.ticker, { cls: 'left', onClick: () => { $('#tx-search').value = row.ticker; state.txFilter.text = row.ticker; renderTransactionsTab(); } }),
      el('td', { class: 'left' }, [el('span', { class: 'trunc', title: row.name, text: row.name || '-' })]),
      td(row.side, { cls: row.side === 'BUY' ? '' : 'muted' }),
      td(fmtNum(row.qty, 0)),
      td(fmtNum(row.price, 2)),
      td(fmtNum(row.grossValue, 2)),
      td(fmtSigned((row.side === 'BUY' ? -1 : 1) * row.valuePln), { cls: row.side === 'BUY' ? 'neg' : 'pos' }),
      td(row.currency),
      td(isNum(row.realizedPnlPln) ? fmtSigned(row.realizedPnlPln) : '-', { cls: signClass(row.realizedPnlPln) }),
      td(fmtPct(row.realizedPct), { cls: signClass(row.realizedPct) }),
      el('td', { class: 'left' }, [el('span', { class: 'trunc', title: row.note ?? '', text: row.note || '-' })]),
      el('td', {}, [
        el('button', { class: 'ghost', text: t('app.edit'), disabled: isAll(), onclick: () => startEditTx(row) }),
        el('button', { class: 'ghost', text: t('app.delete'), disabled: isAll(), onclick: () => removeTx(row) }),
      ]),
    ]));
  }

  clear($('#tbl-tx tfoot')).append(el('tr', {}, [
    el('td', { class: 'left', text: t('table.transactionCount', { count: rows.length }) }),
    el('td', { class: 'left' }),
    el('td', {}), el('td', {}), el('td', {}),
    td(fmtNum(sumQty, 0)),
    el('td', {}), el('td', {}),
    td(fmtSigned(sumValue), { cls: signClass(sumValue) }),
    el('td', {}),
    td(fmtSigned(sumRealized), { cls: signClass(sumRealized) }),
    el('td', {}), el('td', {}), el('td', {}),
  ]));

  togglePortfolioColumns('tbl-tx', 1);
}

function startEditTx(row) {
  state.editingTx = row.id;
  const form = $('#form-tx');
  form.date.value = row.trade_date;
  form.ticker.value = row.ticker;
  form.name.value = row.name ?? '';
  form.side.value = row.side;
  form.qty.value = row.qty;
  form.price.value = row.price;
  form.fee.value = row.fee ?? 0;
  form.currency.value = row.currency;
  form.note.value = row.note ?? '';
  $('#tx-form-title').textContent = t('section.editTransaction', { ticker: row.ticker });
  $('#tx-submit').textContent = t('app.save');
  $('#tx-cancel').classList.remove('hidden');
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function resetTxForm() {
  state.editingTx = null;
  $('#form-tx').reset();
  $('#form-tx').date.value = todayIso();
  $('#tx-form-title').textContent = t('section.addTransaction');
  $('#tx-submit').textContent = t('app.add');
  $('#tx-cancel').classList.add('hidden');
}

async function removeTx(row) {
  const label = `${row.trade_date} ${row.side} ${row.qty} x ${row.ticker} @ ${row.price}`;
  if (!window.confirm(t('confirm.deleteTransaction', { label }))) return;
  try {
    await api(`/portfolios/${state.scope}/transactions/${row.id}`, { method: 'DELETE' });
    toast(t('toast.transactionDeleted'), 'success');
    await refresh({ force: true });
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------- TAB: zamkniete

function renderClosedTab() {
  const body = clear($('#tbl-closed tbody'));
  const rows = state.data?.closedPositions ?? [];
  if (!rows.length) {
    body.append(el('tr', {}, [el('td', { colspan: 11, class: 'empty left', text: t('table.noClosed') })]));
  }
  for (const row of rows) {
    const portfolio = state.portfolios.find((p) => p.id === row.portfolioId);
    body.append(el('tr', {}, [
      el('td', { class: 'left', text: row.closedOn ?? '-' }),
      pfTag({ portfolioName: row.portfolioName, portfolioColor: portfolio?.color }),
      el('td', { class: 'left', text: row.ticker }),
      el('td', { class: 'left' }, [el('span', { class: 'trunc', title: row.name, text: row.name })]),
      td(fmtNum(row.avgBuy, 2)),
      td(fmtNum(row.avgSell, 2)),
      td(fmtNum(row.qty, 0)),
      td(fmtSigned(row.pnl, (v) => fmtNum(v, 2)), { cls: signClass(row.pnl) }),
      td(fmtSigned(row.pnlPln), { cls: signClass(row.pnlPln) }),
      td(fmtPct(row.pnlPct), { cls: signClass(row.pnlPct) }),
      td(row.currency),
    ]));
  }
  togglePortfolioColumns('tbl-closed', 1);
}

// ---------------------------------------------------------------- TAB: gotowka

function renderCashTab() {
  scopeFormState('form-cf', 'cf-form-hint', 'cf-submit');
  const body = clear($('#tbl-cf tbody'));
  const rows = (state.data?.cashFlows ?? []).slice().reverse();
  if (!rows.length) {
    body.append(el('tr', {}, [el('td', { colspan: 8, class: 'empty left', text: t('table.noFlows') })]));
  }

  const balances = {};
  for (const row of state.data?.cashFlows ?? []) {
    balances[row.currency] = (balances[row.currency] ?? 0) + row.amount;
  }
  $('#cf-summary').textContent = [
    t('table.entryCount', { count: rows.length }),
    Object.entries(balances).map(([c, v]) => `${fmtNum(v, 0)} ${c}`).join(' | '),
  ].filter(Boolean).join(' | ');

  for (const row of rows) {
    body.append(el('tr', {}, [
      el('td', { class: 'left', text: row.flow_date }),
      pfTag(row),
      el('td', { class: 'left', text: t(`flow.${row.type}`) }),
      td(fmtSigned(row.amount, (v) => fmtNum(v, 2)), { cls: signClass(row.amount) }),
      td(row.currency),
      el('td', { class: 'left' }, [el('span', { class: 'trunc', title: row.comment ?? '', text: row.comment || '-' })]),
      el('td', { class: 'left muted', text: row.source }),
      el('td', {}, [
        el('button', { class: 'ghost', text: t('app.edit'), disabled: isAll(), onclick: () => startEditCf(row) }),
        el('button', { class: 'ghost', text: t('app.delete'), disabled: isAll(), onclick: () => removeCf(row) }),
      ]),
    ]));
  }
  togglePortfolioColumns('tbl-cf', 1);
}

function startEditCf(row) {
  state.editingCf = row.id;
  const form = $('#form-cf');
  form.date.value = row.flow_date;
  form.type.value = row.type;
  form.amount.value = Math.abs(row.amount);
  form.currency.value = row.currency;
  form.comment.value = row.comment ?? '';
  $('#cf-form-title').textContent = t('section.editCashFlow');
  $('#cf-submit').textContent = t('app.save');
  $('#cf-cancel').classList.remove('hidden');
}

function resetCfForm() {
  state.editingCf = null;
  $('#form-cf').reset();
  $('#form-cf').date.value = todayIso();
  $('#cf-form-title').textContent = t('section.addCashFlow');
  $('#cf-submit').textContent = t('app.add');
  $('#cf-cancel').classList.add('hidden');
}

async function removeCf(row) {
  const label = { date: row.flow_date, type: t(`flow.${row.type}`), amount: fmtNum(row.amount, 2), currency: row.currency };
  if (!window.confirm(t('confirm.deleteFlow', label))) return;
  try {
    await api(`/portfolios/${state.scope}/cash-flows/${row.id}`, { method: 'DELETE' });
    toast(t('toast.flowDeleted'), 'success');
    await refresh({ force: true });
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------- TAB: wynik per ticker

function renderPerTickerTab() {
  const realizedTx = (state.data?.transactions ?? [])
    .filter((row) => isNum(row.realizedPnlPln))
    .map((row) => ({ label: row.trade_date.slice(5), value: row.realizedPnlPln }));
  clear($('#chart-realized')).append(barChart(realizedTx));

  const body = clear($('#tbl-perticker tbody'));
  const rows = state.data?.realizedPerTicker ?? [];
  if (!rows.length) {
    body.append(el('tr', {}, [el('td', { colspan: 4, class: 'empty left', text: t('table.noRealized') })]));
  }
  for (const row of rows) {
    body.append(el('tr', {}, [
      el('td', { class: 'left', text: row.ticker }),
      el('td', { class: 'left' }, [el('span', { class: 'trunc', title: row.name, text: row.name })]),
      td(String(row.trades)),
      td(fmtSigned(row.realizedPln), { cls: signClass(row.realizedPln) }),
    ]));
  }
  const total = rows.reduce((sum, row) => sum + row.realizedPln, 0);
  clear($('#tbl-perticker tfoot')).append(el('tr', {}, [
    el('td', { class: 'left', text: t('col.total') }), el('td', {}), el('td', {}),
    td(fmtSigned(total), { cls: signClass(total) }),
  ]));
}

// ---------------------------------------------------------------- TAB: zarzadzanie

async function renderManageTab() {
  const body = clear($('#tbl-pf tbody'));
  let portfolios = [];
  try {
    portfolios = (await api('/portfolios?includeArchived=1')).portfolios;
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const values = new Map((state.data?.portfolios ?? []).map((p) => [p.id, p.totalPln]));

  for (const portfolio of portfolios) {
    const nameInput = el('input', { value: portfolio.name });
    body.append(el('tr', {}, [
      el('td', { class: 'left' }, [
        el('span', { class: 'pf-tag' }, [el('span', { class: 'dot', style: `background:${portfolio.color}` })]),
        nameInput,
      ]),
      el('td', { class: 'left', text: t(`kind.${portfolio.kind}`) }),
      el('td', { class: 'left', text: portfolio.broker || '-' }),
      td(portfolio.baseCurrency),
      td(values.has(portfolio.id) ? fmtPln(values.get(portfolio.id)) : '-'),
      td(portfolio.hasWebhook ? t('webhook.active') : '-'),
      el('td', {}, [
        el('button', {
          class: 'ghost',
          text: t('app.save'),
          onclick: () => updatePortfolio(portfolio.id, { name: nameInput.value }),
        }),
        el('button', {
          class: 'ghost',
          text: portfolio.archived ? t('action.restore') : t('action.archive'),
          onclick: () => updatePortfolio(portfolio.id, { archived: !portfolio.archived }),
        }),
        el('button', { class: 'ghost', text: t('action.webhookToken'), onclick: () => rotateWebhook(portfolio) }),
        el('button', { class: 'ghost', text: t('action.export'), onclick: () => exportPortfolio(portfolio) }),
        el('button', { class: 'ghost danger', text: t('app.delete'), onclick: () => removePortfolio(portfolio) }),
      ]),
    ]));
  }

  renderShareLinks();
}

async function updatePortfolio(id, patch) {
  try {
    await api(`/portfolios/${id}`, { method: 'PATCH', body: patch });
    toast(t('toast.portfolioUpdated'), 'success');
    state.portfolios = (await api('/portfolios')).portfolios;
    await refresh({ force: true });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removePortfolio(portfolio) {
  const confirmName = window.prompt(t('confirm.deletePortfolio'), '');
  if (confirmName === null) return;
  try {
    const res = await api(`/portfolios/${portfolio.id}`, { method: 'DELETE', body: { confirmName } });
    toast(t('toast.portfolioDeleted', { count: res.removed.transactions }), 'success');
    if (state.scope === portfolio.id) state.scope = 'all';
    state.portfolios = (await api('/portfolios')).portfolios;
    await refresh({ force: true });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function rotateWebhook(portfolio) {
  if (!window.confirm(t('confirm.rotateWebhook', { name: portfolio.name }))) return;
  try {
    const res = await api(`/portfolios/${portfolio.id}/webhook-token`, { method: 'POST' });
    window.prompt(t('prompt.webhookToken'), res.token);
    renderManageTab();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function exportPortfolio(portfolio) {
  try {
    const payload = await api(`/portfolios/${portfolio.id}/export`);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: `portfolio-${portfolio.slug}-${todayIso()}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function renderShareLinks() {
  const body = clear($('#tbl-share tbody'));
  try {
    const { links } = await api('/share-links');
    if (!links.length) {
      body.append(el('tr', {}, [el('td', { colspan: 6, class: 'empty left', text: t('table.noLinks') })]));
    }
    for (const link of links) {
      body.append(el('tr', {}, [
        el('td', { class: 'left', text: link.label || '-' }),
        el('td', { class: 'left', text: t(`scope.${link.scope}`) }),
        el('td', { class: 'left', text: link.portfolioName ?? t('app.allPortfolios') }),
        el('td', { class: 'left', text: link.expiresAt ? link.expiresAt.slice(0, 10) : t('share.noExpiry') }),
        td(String(link.accessCount)),
        el('td', {}, [
          el('button', {
            class: 'ghost danger', text: link.active ? t('action.revoke') : t('app.delete'),
            onclick: async () => {
              try {
                await api(`/share-links/${link.id}`, { method: 'DELETE' });
                toast(t('toast.linkRevoked'), 'success');
                renderShareLinks();
              } catch (err) { toast(err.message, 'error'); }
            },
          }),
        ]),
      ]));
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------- TAB: konto

async function renderAccountTab() {
  const info = clear($('#account-info'));
  const rows = [
    [t('col.email'), state.user.email],
    [t('card.name'), state.user.displayName],
    [t('card.role'), state.user.role],
    [t('card.createdAt'), state.user.createdAt?.slice(0, 10)],
    [t('card.lastLogin'), fmtDateTime(state.user.lastLoginAt)],
  ];
  for (const [key, value] of rows) {
    info.append(el('div', { class: 'card' }, [
      el('div', { class: 'k', text: key }),
      el('div', { class: 'v', style: 'font-size:14px', text: String(value ?? '-') }),
    ]));
  }

  const body = clear($('#tbl-sessions tbody'));
  try {
    const { sessions } = await api('/account/sessions');
    for (const session of sessions) {
      body.append(el('tr', {}, [
        el('td', { class: 'left', text: fmtDateTime(session.createdAt) }),
        el('td', { class: 'left', text: fmtDateTime(session.lastSeenAt) }),
        el('td', { class: 'left', text: session.ip ?? '-' }),
        el('td', { class: 'left' }, [el('span', { class: 'trunc', title: session.userAgent ?? '', text: session.userAgent ?? '-' })]),
        td(session.current ? t('app.yes') : ''),
      ]));
    }
  } catch { /* sesje sa informacyjne */ }

  if (['owner', 'admin'].includes(state.user.role)) renderInvites();
}

async function renderInvites() {
  const body = clear($('#tbl-invites tbody'));
  try {
    const { invites } = await api('/admin/invites');
    if (!invites.length) body.append(el('tr', {}, [el('td', { colspan: 6, class: 'empty left', text: t('table.noInvites') })]));
    for (const invite of invites) {
      body.append(el('tr', {}, [
        el('td', { class: 'left', text: invite.id }),
        el('td', { class: 'left', text: invite.email ?? t('invite.anyEmail') }),
        el('td', { class: 'left', text: invite.role }),
        el('td', { class: 'left', text: invite.expiresAt.slice(0, 16).replace('T', ' ') }),
        el('td', { class: 'left', text: t(`invite.status.${invite.status}`) }),
        el('td', {}, [
          invite.status === 'active'
            ? el('button', {
              class: 'ghost danger', text: t('action.revoke'),
              onclick: async () => {
                try { await api(`/admin/invites/${invite.id}`, { method: 'DELETE' }); renderInvites(); }
                catch (err) { toast(err.message, 'error'); }
              },
            })
            : null,
        ]),
      ]));
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------- zdarzenia

function bindStaticHandlers() {
  $('#btn-refresh').addEventListener('click', () => refresh({ force: true }));
  $('#btn-manage').addEventListener('click', () => switchTab('manage'));
  $('#btn-account').addEventListener('click', () => switchTab('account'));

  for (const button of $$('#tabs button')) {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
  }
  for (const button of $$('#range-value button')) {
    button.addEventListener('click', () => {
      state.valueRange = button.dataset.range;
      for (const other of $$('#range-value button')) other.setAttribute('aria-pressed', String(other === button));
      savePrefs();
      renderPortfolioTab();
    });
  }
  for (const button of $$('#range-symbol button')) {
    button.addEventListener('click', () => {
      state.symbolRange = button.dataset.range;
      for (const other of $$('#range-symbol button')) other.setAttribute('aria-pressed', String(other === button));
      savePrefs();
      renderSymbolChart();
    });
  }
  for (const button of $$('#region-filter button')) {
    button.addEventListener('click', () => {
      state.region = button.dataset.region;
      for (const other of $$('#region-filter button')) other.setAttribute('aria-pressed', String(other === button));
      savePrefs();
      renderPositions();
    });
  }
  for (const header of $$('#tbl-positions thead th[data-sort]')) {
    header.addEventListener('click', () => {
      const key = header.dataset.sort;
      state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : -1 };
      renderPositions();
    });
  }

  $('#btn-csv').addEventListener('click', () => {
    window.location.href = `./api/v1/dashboard.csv?portfolio=${encodeURIComponent(state.scope)}&lang=${getLocale()}`;
  });

  // --- formularz transakcji
  $('#form-tx').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const body = Object.fromEntries(new FormData(form).entries());
    try {
      if (state.editingTx) {
        await api(`/portfolios/${state.scope}/transactions/${state.editingTx}`, { method: 'PUT', body });
        toast(t('toast.transactionUpdated'), 'success');
      } else {
        await api(`/portfolios/${state.scope}/transactions`, { method: 'POST', body });
        toast(t('toast.transactionAdded'), 'success');
      }
      resetTxForm();
      await refresh({ force: true });
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#tx-cancel').addEventListener('click', resetTxForm);
  $('#tx-search').addEventListener('input', debounce((event) => {
    state.txFilter.text = event.target.value.trim();
    renderTransactionsTab();
  }, 250));
  $('#tx-side').addEventListener('change', (event) => {
    state.txFilter.side = event.target.value;
    renderTransactionsTab();
  });
  $('#tx-clear').addEventListener('click', () => {
    state.txFilter = { text: '', side: 'ALL' };
    $('#tx-search').value = '';
    $('#tx-side').value = 'ALL';
    renderTransactionsTab();
  });

  // --- formularz przeplywow
  $('#form-cf').addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target).entries());
    try {
      if (state.editingCf) {
        await api(`/portfolios/${state.scope}/cash-flows/${state.editingCf}`, { method: 'PUT', body });
        toast(t('toast.flowUpdated'), 'success');
      } else {
        await api(`/portfolios/${state.scope}/cash-flows`, { method: 'POST', body });
        toast(t('toast.flowAdded'), 'success');
      }
      resetCfForm();
      await refresh({ force: true });
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#cf-cancel').addEventListener('click', resetCfForm);

  // --- formularz portfela
  $('#form-pf').addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target).entries());
    try {
      const res = await api('/portfolios', { method: 'POST', body });
      toast(t('toast.portfolioCreated', { name: res.portfolio.name }), 'success');
      event.target.reset();
      state.portfolios = (await api('/portfolios')).portfolios;
      state.scope = res.portfolio.id;
      savePrefs();
      await refresh({ force: true });
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btn-share-new').addEventListener('click', async () => {
    const scopeChoice = window.prompt(t('prompt.shareScope'), isAll() ? 'all' : '');
    if (scopeChoice === null) return;
    try {
      const res = await api('/share-links', {
        method: 'POST',
        body: {
          portfolioId: scopeChoice.trim() === 'all' ? 'all' : state.scope,
          scope: 'summary',
          label: window.prompt(t('prompt.shareLabel'), '') ?? '',
          expiresInDays: 30,
        },
      });
      window.prompt(t('prompt.shareUrl'), new URL(res.url, window.location.href).href);
      renderShareLinks();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // --- konto
  $('#form-password').addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target).entries());
    try {
      await api('/account/password', { method: 'POST', body });
      toast(t('toast.passwordChanged'), 'success');
      setTimeout(() => { window.location.href = './login.html'; }, 1200);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#btn-logout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST', redirectOn401: false }).catch(() => {});
    window.location.href = './login.html';
  });
  $('#btn-logout-all').addEventListener('click', async () => {
    if (!window.confirm(t('confirm.logoutAll'))) return;
    await api('/account/sessions', { method: 'DELETE' }).catch(() => {});
    window.location.href = './login.html';
  });
  $('#btn-invite').addEventListener('click', async () => {
    try {
      const res = await api('/admin/invites', { method: 'POST', body: { role: 'user', ttlHours: 72 } });
      window.prompt(t('prompt.inviteCode'), res.code);
      renderInvites();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Ustawienie zaznaczen z zapisanych preferencji
  for (const button of $$('#range-value button')) button.setAttribute('aria-pressed', String(button.dataset.range === state.valueRange));
  for (const button of $$('#range-symbol button')) button.setAttribute('aria-pressed', String(button.dataset.range === state.symbolRange));
  for (const button of $$('#region-filter button')) button.setAttribute('aria-pressed', String(button.dataset.region === state.region));
  resetTxForm();
  resetCfForm();
}

function switchTab(tab) {
  state.tab = tab;
  savePrefs();
  render();
}

boot();
