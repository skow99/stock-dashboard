// public/import.js - zakladka importu: wczytanie pliku, podglad, zapis, cofanie.
//
// Plik z dysku czytamy jako SUROWE BAJTY i wysylamy w base64. Gdybysmy pozwolili
// przegladarce zdekodowac go jako tekst, plik zapisany przez Excel w Windows-1250
// przyszedlby na serwer juz z zepsutymi polskimi znakami - i nie byloby jak tego cofnac.
//
// Podglad i zapis wysylaja DOKLADNIE to samo cialo zadania. Serwer liczy plan
// ta sama funkcja w obu przypadkach, wiec to, co uzytkownik widzi, jest tym, co dostanie.

import { api, $, $$, el, clear, td, toast, fmtDateTime, fmtNum, ApiError } from './ui.js';
import { t } from './i18n.js';

const state = {
  portfolioId: null,
  source: null,        // { contentBase64 } albo { content }
  filename: '',
  preview: null,
  mapping: null,       // nadpisania z panelu; null = zdaj sie na automat
  shape: null,
  delimiter: '',
  includeDuplicates: false,
  batches: [],
  busy: false,
};

/** Znaczenia, ktore uzytkownik moze przypisac kolumnie recznie. */
const FIELDS = [
  'date', 'ticker', 'side', 'qty', 'price', 'fee',
  'currency', 'name', 'note', 'amount', 'type', 'avgPrice',
];

/** Ktore pola pokazac w tabeli podgladu dla danego rodzaju danych. */
const PREVIEW_COLUMNS = {
  transactions: [
    ['trade_date', 'import.f.date'], ['ticker', 'import.f.ticker'], ['side', 'import.f.side'],
    ['qty', 'import.f.qty'], ['price', 'import.f.price'], ['fee', 'import.f.fee'],
    ['currency', 'import.f.currency'], ['name', 'import.f.name'],
  ],
  cashflows: [
    ['flow_date', 'import.f.date'], ['type', 'import.f.type'], ['amount', 'import.f.amount'],
    ['currency', 'import.f.currency'], ['comment', 'import.f.note'],
  ],
  holdings: [
    ['symbol', 'import.f.ticker'], ['qty', 'import.f.qty'],
    ['avg', 'import.f.avgPrice'], ['currency', 'import.f.currency'], ['name', 'import.f.name'],
  ],
};

const NUMERIC = new Set(['qty', 'price', 'fee', 'amount', 'avg']);

// ---------------------------------------------------------------- wejscie

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  // Konwersja porcjami - String.fromCharCode(...duza tablica) przepelnia stos wywolan.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function takeFile(file) {
  if (!file) return;
  const MAX = 3 * 1024 * 1024;
  if (file.size > MAX) { toast(t('import.fileTooBig'), 'error'); return; }
  const buffer = await file.arrayBuffer();
  state.source = { contentBase64: bytesToBase64(buffer) };
  state.filename = file.name;
  resetDerived();
  $('#import-drop').classList.add('loaded');
  $('#import-drop').querySelector('strong').textContent = file.name;
  $('#import-drop').querySelector('span').textContent = t('import.fileSize', { kb: Math.max(1, Math.round(file.size / 1024)) });
  analyze();
}

function takePaste() {
  const text = $('#import-paste').value;
  if (!text.trim()) return false;
  state.source = { content: text };
  state.filename = t('import.pastedLabel');
  resetDerived();
  return true;
}

/** Po zmianie zrodla wszystkie ustalenia z poprzedniego pliku trzeba wyrzucic. */
function resetDerived() {
  state.mapping = null;
  state.shape = null;
  state.delimiter = '';
  state.includeDuplicates = false;
  state.preview = null;
}

function requestBody() {
  return {
    ...state.source,
    filename: state.filename,
    shape: state.shape ?? undefined,
    mapping: state.mapping ?? undefined,
    delimiter: state.delimiter || undefined,
    includeDuplicates: state.includeDuplicates,
  };
}

// ---------------------------------------------------------------- podglad

async function analyze() {
  if (!state.source || state.busy) return;
  state.busy = true;
  try {
    const res = await api(`/portfolios/${state.portfolioId}/import/analyze`, {
      method: 'POST', body: requestBody(),
    });
    state.preview = res.preview;
    state.shape = res.preview.shape;
    renderPreview();
    $('#import-step-preview').classList.remove('hidden');
    $('#import-reset').classList.remove('hidden');
    $('#import-step-preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    state.preview = null;
    $('#import-step-preview').classList.add('hidden');
    toast(err instanceof ApiError ? err.message : String(err), 'error', 8000);
  } finally {
    state.busy = false;
  }
}

function renderPreview() {
  const p = state.preview;
  renderSummary(p);

  $('#import-detected').textContent = [
    p.profileLabel ? t('import.profileDetected', { name: p.profileLabel }) : null,
    t('import.encodingDetected', { encoding: p.encoding }),
    t('import.decimalDetected', { sep: p.numberStyle === 'comma' ? ',' : '.' }),
  ].filter(Boolean).join(' · ');

  $('#import-shape').value = p.shape;
  $('#import-delimiter').value = state.delimiter;
  $('#import-dups').checked = state.includeDuplicates;

  renderMapping(p);
  renderProblems(p);
  renderSamples(p);

  const nothing = p.willInsert === 0;
  $('#import-commit').disabled = nothing;
  $('#import-commit').textContent = nothing
    ? t('import.nothingToSave')
    : t('import.commitCount', { count: p.willInsert });
}

function renderSummary(p) {
  const host = clear($('#import-summary'));
  const stat = (key, value, kind) => el('div', { class: `import-stat ${kind}` }, [
    el('strong', { text: String(value) }),
    el('span', { text: t(key) }),
  ]);
  host.append(stat('import.statTotal', p.total, ''));
  host.append(stat('import.statOk', p.counts.ok, p.counts.ok ? 'good' : ''));
  if (p.counts.update) host.append(stat('import.statUpdate', p.counts.update, 'warn'));
  if (p.counts.duplicate) host.append(stat('import.statDuplicate', p.counts.duplicate, 'warn'));
  if (p.counts.error) host.append(stat('import.statError', p.counts.error, 'bad'));
}

function renderMapping(p) {
  const body = clear($('#import-mapping').querySelector('tbody'));
  // Kolumna pliku -> pole kanoniczne (odwrocenie mapy z serwera).
  const assigned = new Map();
  for (const [field, index] of Object.entries(p.mapping)) assigned.set(index, field);

  const firstRow = p.samples[0] ?? p.problems[0];
  p.header.forEach((label, index) => {
    const select = el('select', {
      onchange: (event) => {
        const value = event.target.value;
        // Jedno pole moze wskazywac tylko jedna kolumne - zwalniamy poprzednia.
        const next = {};
        for (const [field, i] of Object.entries(p.mapping)) if (String(i) !== String(index)) next[field] = i;
        if (value) next[value] = index;
        state.mapping = next;
        analyze();
      },
    }, [
      el('option', { value: '', text: t('import.fieldIgnore') }),
      ...FIELDS.map((field) => el('option', {
        value: field,
        selected: assigned.get(index) === field ? true : null,
        text: t(`import.f.${field}`),
      })),
    ]);

    const sample = Array.isArray(firstRow?.raw) ? (firstRow.raw[index] ?? '') : '';
    body.append(el('tr', {}, [
      td(label || `#${index + 1}`, { cls: 'left' }),
      td(sample, { cls: 'left dim' }),
      el('td', { class: 'left' }, [select]),
    ]));
  });
}

function renderProblems(p) {
  const wrap = $('#import-problems-wrap');
  wrap.classList.toggle('hidden', !p.problems.length);
  if (!p.problems.length) return;

  const body = clear($('#import-problems').querySelector('tbody'));
  for (const item of p.problems) {
    body.append(el('tr', {}, [
      td(String(item.line)),
      td(errorLabel(item.error), { cls: 'left bad' }),
      td((item.raw ?? []).join(' · '), { cls: 'left dim' }),
    ]));
  }
  if (p.truncated.problems) {
    body.append(el('tr', {}, [el('td', { colspan: 3, class: 'left dim', text: t('import.moreProblems') })]));
  }
}

/** Kod bledu z serwera -> zdanie po polsku/angielsku. */
function errorLabel(error) {
  if (!error) return t('import.err.unknown');
  const key = `import.err.${error.code}`;
  const translated = t(key, error.details ?? {});
  return translated === key ? (error.code ?? t('import.err.unknown')) : translated;
}

function renderSamples(p) {
  const columns = PREVIEW_COLUMNS[p.shape] ?? [];
  const head = clear($('#import-samples').querySelector('thead tr'));
  head.append(el('th', { class: 'static', text: t('import.colLine') }));
  head.append(el('th', { class: 'left static', text: t('import.colStatus') }));
  for (const [, labelKey] of columns) head.append(el('th', { class: 'left static', text: t(labelKey) }));

  const body = clear($('#import-samples').querySelector('tbody'));
  for (const item of p.samples) {
    const cells = [
      td(String(item.line)),
      td(t(`import.status.${item.status}`), { cls: `left ${item.status === 'ok' ? 'good' : 'warn'}` }),
    ];
    for (const [field] of columns) {
      const value = item.value?.[field];
      cells.push(td(
        value === undefined || value === null || value === '' ? '-'
          : (NUMERIC.has(field) ? fmtNum(value, 2) : String(value)),
        { cls: NUMERIC.has(field) ? '' : 'left' },
      ));
    }
    body.append(el('tr', { class: item.status === 'duplicate' ? 'dim' : '' }, cells));
  }
  if (p.truncated.samples) {
    body.append(el('tr', {}, [el('td', {
      colspan: columns.length + 2, class: 'left dim',
      text: t('import.moreRows', { count: p.willInsert }),
    })]));
  }
}

// ---------------------------------------------------------------- zapis

async function commit() {
  if (!state.preview || state.busy) return;
  const count = state.preview.willInsert;
  if (!count) return;
  if (!window.confirm(t('import.confirmCommit', { count, portfolio: portfolioName() }))) return;

  state.busy = true;
  $('#import-commit').disabled = true;
  try {
    const res = await api(`/portfolios/${state.portfolioId}/import/commit`, {
      method: 'POST', body: requestBody(),
    });
    toast(t('import.done', { count: res.result.inserted }), 'success');
    // Serwer sam przelicza historie po imporcie - pokazujemy, co z tego wyszlo.
    if (res.history?.days) {
      $('#rebuild-result').textContent = t('rebuild.done', {
        days: res.history.days, from: res.history.from, to: res.history.to,
      });
    }
    resetAll();
    await loadBatches();
    onImported?.();
  } catch (err) {
    toast(err instanceof ApiError ? err.message : String(err), 'error', 8000);
    $('#import-commit').disabled = false;
  } finally {
    state.busy = false;
  }
}

async function undo(batch) {
  if (!window.confirm(t('import.confirmUndo', { count: batch.remaining }))) return;
  try {
    const res = await api(`/portfolios/${state.portfolioId}/import/batches/${batch.id}`, { method: 'DELETE' });
    const message = res.result.kept
      ? t('import.undoneKept', { removed: res.result.removed, kept: res.result.kept })
      : t('import.undone', { removed: res.result.removed });
    toast(message, 'success', 6000);
    await loadBatches();
    onImported?.();
  } catch (err) {
    toast(err instanceof ApiError ? err.message : String(err), 'error', 8000);
  }
}

// ---------------------------------------------------------------- historia

/**
 * Przeliczenie historii wartosci portfela wstecz z transakcji.
 * Wolane recznie przyciskiem; po imporcie serwer robi to sam.
 */
async function rebuildHistory() {
  const cel = $('#rebuild-result');
  const przycisk = $('#btn-rebuild');
  przycisk.disabled = true;
  cel.textContent = t('rebuild.working');
  try {
    const res = await api(`/portfolios/${state.portfolioId}/history/rebuild`, { method: 'POST' });
    const r = res.result;
    cel.textContent = r.days
      ? t('rebuild.done', { days: r.days, from: r.from, to: r.to })
      : t('rebuild.nothing');
    if (r.skipped) cel.textContent += ` ${t('rebuild.skipped', { count: r.skipped })}`;
    toast(t('rebuild.toast', { days: r.days }), 'success');
    onImported?.();
  } catch (err) {
    cel.textContent = '';
    toast(err instanceof ApiError ? err.message : String(err), 'error', 8000);
  } finally {
    przycisk.disabled = false;
  }
}

async function loadBatches() {
  try {
    const res = await api(`/portfolios/${state.portfolioId}/import/batches`);
    state.batches = res.batches;
  } catch {
    state.batches = [];
  }
  renderBatches();
}

function renderBatches() {
  const body = clear($('#tbl-import-batches').querySelector('tbody'));
  if (!state.batches.length) {
    body.append(el('tr', {}, [el('td', { colspan: 5, class: 'left dim', text: t('import.noBatches') })]));
    return;
  }
  for (const batch of state.batches) {
    const action = batch.undoneAt
      ? el('span', { class: 'dim', text: t('import.alreadyUndone') })
      : (batch.reversible
        ? el('button', { class: 'ghost small', text: t('import.undo'), onclick: () => undo(batch) })
        : el('span', { class: 'dim', text: t('import.notReversible') }));

    body.append(el('tr', { class: batch.undoneAt ? 'dim' : '' }, [
      td(fmtDateTime(batch.createdAt), { cls: 'left' }),
      td(batch.filename || '-', { cls: 'left' }),
      td(t(`import.kind.${batch.kind}`), { cls: 'left' }),
      td(batch.undoneAt ? '0' : String(batch.remaining)),
      el('td', {}, [action]),
    ]));
  }
}

// ---------------------------------------------------------------- sterowanie

let onImported = null;
let portfolioName = () => '';
let wired = false;

function resetAll() {
  state.source = null;
  state.filename = '';
  resetDerived();
  $('#import-step-preview').classList.add('hidden');
  $('#import-reset').classList.add('hidden');
  $('#import-paste').value = '';
  const drop = $('#import-drop');
  drop.classList.remove('loaded');
  drop.querySelector('strong').textContent = t('import.dropTitle');
  drop.querySelector('span').textContent = t('import.dropHint');
  $('#import-file').value = '';
}

function wire() {
  if (wired) return;
  wired = true;

  const drop = $('#import-drop');
  const input = $('#import-file');

  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => takeFile(input.files[0]));

  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.add('over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.remove('over'); });
  }
  drop.addEventListener('drop', (event) => takeFile(event.dataTransfer?.files?.[0]));

  $('#import-analyze').addEventListener('click', () => {
    if ($('#import-paste').value.trim()) { takePaste(); analyze(); return; }
    if (state.source) { analyze(); return; }
    input.click();
  });

  $('#btn-rebuild').addEventListener('click', rebuildHistory);
  $('#import-reset').addEventListener('click', resetAll);
  $('#import-back').addEventListener('click', resetAll);
  $('#import-commit').addEventListener('click', commit);

  $('#import-shape').addEventListener('change', (event) => { state.shape = event.target.value; analyze(); });
  $('#import-delimiter').addEventListener('change', (event) => { state.delimiter = event.target.value; analyze(); });
  $('#import-dups').addEventListener('change', (event) => { state.includeDuplicates = event.target.checked; analyze(); });
}

/**
 * Wywolywane przez app.js przy kazdym renderze zakladki.
 * @param {{ portfolioId: string|null, portfolioName: string, onImported: Function }} options
 */
export function renderImportTab(options) {
  wire();
  onImported = options.onImported;
  portfolioName = () => options.portfolioName;

  const noPortfolio = !options.portfolioId;
  $('#import-needs-portfolio').classList.toggle('hidden', !noPortfolio);
  $('#import-step-file').classList.toggle('hidden', noPortfolio);
  $('#import-history').classList.toggle('hidden', noPortfolio);
  $('#import-rebuild').classList.toggle('hidden', noPortfolio);
  if (noPortfolio) {
    $('#import-step-preview').classList.add('hidden');
    return;
  }

  if (state.portfolioId !== options.portfolioId) {
    state.portfolioId = options.portfolioId;
    resetAll();
    loadBatches();
  }
  $('#import-target').textContent = t('import.targetPortfolio', { name: options.portfolioName });
}
