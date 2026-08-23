// src/import/engine.mjs - podglad, zapis i cofniecie importu.
//
// Trzy zasady, ktore wynikaja z tego, ze system jest zywy i trzyma cudze pieniadze:
//
//  1. Podglad NICZEGO nie zapisuje. Uzytkownik widzi komplet skutkow, zanim cokolwiek
//     trafi do bazy.
//  2. Duplikaty rozpoznajemy wylacznie wzgledem danych SPRZED importu. Dwa identyczne
//     zlecenia z tego samego dnia w jednym pliku to dwie prawdziwe transakcje, nie pomylka.
//  3. Zapis idzie w jednej transakcji i dostaje identyfikator wsadu. Zly plik cofa sie
//     jednym klinieciem, a wiersze zmienione recznie po imporcie zostaja nietkniete.

import { newId, nowIso, getDb, tx as dbTx, audit } from '../db.mjs';
import { badRequest, HttpError } from '../http.mjs';
import {
  validateTransaction, validateCashFlow, insertTransaction, insertCashFlow,
  upsertBaseline, findDuplicateTransaction, findDuplicateCashFlow,
} from '../ledger.mjs';
import {
  parseCsv, decodeBytes, inferDecimalSeparator, inferSlashOrder, parseNumber, parseDate,
} from './csv.mjs';
import {
  normKey, mapHeader, detectShape, detectProfile, parseSide, parseFlowType,
  PROFILES, SHAPES, ASSIGNABLE_FIELDS,
} from './schema.mjs';

/** Gorna granica jednego importu. e2-micro ma 1 GB RAM - to nie jest miejsce na 100 tys. wierszy. */
export const MAX_ROWS = 5000;
/** Ile wierszy odsylamy do podgladu. Liczniki zawsze dotycza calosci pliku. */
const PREVIEW_OK = 25;
const PREVIEW_PROBLEMS = 100;

// ---------------------------------------------------------------- plan

/**
 * Zamienia zawartosc pliku na plan importu. Czysta funkcja poza odpytaniem bazy
 * o duplikaty - `analyze` i `commit` uzywaja dokladnie tej samej sciezki, wiec
 * to, co uzytkownik zobaczyl w podgladzie, jest tym, co sie zapisze.
 */
export function buildPlan({
  text, bytes, portfolioId, shape: forcedShape = null,
  mapping: forcedMapping = null, delimiter: forcedDelimiter = null,
  includeDuplicates = false,
}) {
  const decoded = bytes ? decodeBytes(bytes) : { text: String(text ?? ''), encoding: 'utf-8' };
  if (!decoded.text.trim()) throw badRequest('import_empty_file');

  const { delimiter, rows } = parseCsv(decoded.text, { delimiter: forcedDelimiter });
  if (rows.length < 2) throw badRequest('import_no_rows');

  const header = rows[0];
  const body = rows.slice(1);
  if (body.length > MAX_ROWS) throw badRequest('import_too_many_rows', { max: MAX_ROWS, got: body.length });

  const headerKeys = header.map(normKey);
  const profileKey = detectProfile(headerKeys);
  const profile = PROFILES[profileKey];

  const auto = mapHeader(header, profileKey);
  // Mapowanie z panelu ma pierwszenstwo, ale tylko dla pol, ktore znamy.
  const mapping = { ...auto.mapping };
  if (forcedMapping && typeof forcedMapping === 'object') {
    for (const [field, index] of Object.entries(forcedMapping)) {
      if (!ASSIGNABLE_FIELDS.includes(field)) continue;
      if (index === null || index === '') { delete mapping[field]; continue; }
      const i = Number(index);
      if (!Number.isInteger(i) || i < 0 || i >= header.length) continue;
      mapping[field] = i;
    }
  }

  const detected = detectShape(mapping, { provides: profile?.provides ?? [] });
  const shape = forcedShape && SHAPES[forcedShape] ? forcedShape : detected.shape;
  if (!shape) {
    throw badRequest('import_shape_unknown', {
      missing: (detected.missing ?? []).join(', '),
      closest: detected.closest ?? '',
    });
  }

  // Styl liczb i dat ustalamy raz, na podstawie calej kolumny (patrz csv.mjs).
  const column = (field) => (mapping[field] === undefined ? [] : body.map((r) => r[mapping[field]] ?? ''));
  const numberStyle = inferDecimalSeparator([
    ...column('price'), ...column('qty'), ...column('amount'), ...column('avgPrice'), ...column('fee'),
  ]);
  const slashOrder = inferSlashOrder(column('date'));

  const cell = (row, field) => (mapping[field] === undefined ? '' : String(row[mapping[field]] ?? '').trim());

  const items = [];
  const counts = { ok: 0, duplicate: 0, update: 0, error: 0 };

  for (let i = 0; i < body.length; i += 1) {
    const row = body[i];
    const line = i + 2; // +1 za naglowek, +1 bo ludzie licza od jedynki
    const raw = {
      date: cell(row, 'date'),
      ticker: cell(row, 'ticker'),
      side: parseSide(cell(row, 'side')),
      type: cell(row, 'type') || null,
      qty: parseNumber(cell(row, 'qty'), numberStyle),
      price: parseNumber(cell(row, 'price'), numberStyle),
      avgPrice: parseNumber(cell(row, 'avgPrice'), numberStyle),
      amount: parseNumber(cell(row, 'amount'), numberStyle),
      fee: parseNumber(cell(row, 'fee'), numberStyle),
      currency: cell(row, 'currency') || null,
      name: cell(row, 'name'),
      note: cell(row, 'note'),
    };
    if (profile?.transform) profile.transform(raw);

    try {
      const item = buildItem(shape, raw, { slashOrder, line, portfolioId, includeDuplicates });
      counts[item.status] += 1;
      items.push(item);
    } catch (err) {
      const known = err instanceof HttpError;
      counts.error += 1;
      items.push({
        line,
        status: 'error',
        error: { code: known ? err.code : 'import_row_invalid', details: known ? err.details : null },
        raw: row.slice(0, 12),
      });
    }
  }

  return {
    shape,
    profile: profileKey,
    profileLabel: profile?.label ?? null,
    encoding: decoded.encoding,
    delimiter,
    numberStyle,
    slashOrder,
    header,
    mapping,
    unmatched: auto.unmatched,
    autoDetectedShape: detected.shape,
    counts,
    total: body.length,
    items,
  };
}

/** Jeden wiersz -> rekord gotowy do zapisu, razem z werdyktem o duplikacie. */
function buildItem(shape, raw, { slashOrder, line, portfolioId, includeDuplicates }) {
  if (shape === 'holdings') {
    if (!raw.ticker) throw badRequest('invalid_ticker', { field: 'ticker', max: 24 });
    if (raw.qty === null) throw badRequest('invalid_number', { field: 'qty' });
    const value = {
      symbol: raw.ticker, qty: raw.qty, avg: raw.avgPrice ?? 0,
      currency: raw.currency ?? undefined, name: raw.name,
    };
    // Baseline to upsert - istniejacy wiersz zostanie NADPISANY, nie zdublowany.
    const existing = getDb()
      .prepare('SELECT symbol FROM holdings_baseline WHERE portfolio_id = ? AND symbol = ?')
      .get(portfolioId, String(raw.ticker).toUpperCase());
    return { line, status: existing ? 'update' : 'ok', value };
  }

  const date = parseDate(raw.date, slashOrder);
  if (!date) throw badRequest('invalid_date', { field: 'date' });

  if (shape === 'transactions') {
    if (!raw.side) throw badRequest('invalid_side');
    const value = validateTransaction({
      date, ticker: raw.ticker, side: raw.side, qty: raw.qty, price: raw.price,
      fee: raw.fee ?? 0, currency: raw.currency ?? undefined, name: raw.name,
      note: raw.note, source: 'import',
    });
    const dup = includeDuplicates ? null : findDuplicateTransaction(portfolioId, value);
    return { line, status: dup ? 'duplicate' : 'ok', value };
  }

  // cashflows
  const type = parseFlowType(raw.type);
  if (!type) throw badRequest('invalid_type', { list: 'Deposit, Withdrawal, Dividend, Interest, Fee, Tax' });
  const value = validateCashFlow({
    date, type, amount: raw.amount, currency: raw.currency ?? undefined,
    comment: raw.note || raw.name || (raw.ticker ? `${raw.ticker}` : ''), source: 'import',
  });
  const dup = includeDuplicates ? null : findDuplicateCashFlow(portfolioId, value);
  return { line, status: dup ? 'duplicate' : 'ok', value };
}

// ---------------------------------------------------------------- podglad

/** Plan przyciety do rozmiaru odpowiedzi. Liczniki dotycza calego pliku. */
export function toPreview(plan) {
  const problems = plan.items.filter((i) => i.status === 'error').slice(0, PREVIEW_PROBLEMS);
  const samples = plan.items.filter((i) => i.status !== 'error').slice(0, PREVIEW_OK);
  return {
    shape: plan.shape,
    profile: plan.profile,
    profileLabel: plan.profileLabel,
    encoding: plan.encoding,
    delimiter: plan.delimiter,
    numberStyle: plan.numberStyle,
    slashOrder: plan.slashOrder,
    header: plan.header,
    mapping: plan.mapping,
    unmatched: plan.unmatched,
    autoDetectedShape: plan.autoDetectedShape,
    counts: plan.counts,
    total: plan.total,
    willInsert: plan.counts.ok + plan.counts.update,
    samples,
    problems,
    truncated: {
      samples: plan.items.filter((i) => i.status !== 'error').length > PREVIEW_OK,
      problems: plan.counts.error > PREVIEW_PROBLEMS,
    },
  };
}

// ---------------------------------------------------------------- zapis

/**
 * Zapis calego wsadu w jednej transakcji. Wiersze bledne i duplikaty sa pomijane,
 * ale nie przerywaja importu - uzytkownik widzial je juz w podgladzie.
 */
export function commitPlan(portfolioId, plan, ctx = {}) {
  const insertable = plan.items.filter((item) => item.status === 'ok' || item.status === 'update');
  if (!insertable.length) throw badRequest('import_nothing_to_insert');

  const batchId = newId('imp_');
  const at = nowIso();

  const inserted = dbTx(() => {
    getDb().prepare(`
      INSERT INTO import_batches
        (id, portfolio_id, user_id, kind, profile, filename, row_count, skipped_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      batchId, portfolioId, ctx.userId ?? null, plan.shape, plan.profile,
      String(ctx.filename ?? '').slice(0, 120),
      insertable.length, plan.counts.duplicate, at,
    );

    let count = 0;
    for (const item of insertable) {
      if (plan.shape === 'transactions') {
        insertTransaction(portfolioId, { ...toInput(item.value), importBatchId: batchId, source: 'import' }, ctx);
      } else if (plan.shape === 'cashflows') {
        insertCashFlow(portfolioId, { ...toFlowInput(item.value), importBatchId: batchId, source: 'import' }, ctx);
      } else {
        // Stan portfela jest upsertem i nie ma kolumny wsadu - cofniecie go nie obejmuje.
        upsertBaseline(portfolioId, item.value);
      }
      count += 1;
    }
    return count;
  });

  audit({
    userId: ctx.userId, portfolioId, action: 'import.committed', entity: 'import_batch', entityId: batchId,
    ip: ctx.ip,
    detail: { kind: plan.shape, profile: plan.profile, inserted, duplicates: plan.counts.duplicate, errors: plan.counts.error },
  });

  return {
    batchId,
    kind: plan.shape,
    inserted,
    duplicates: plan.counts.duplicate,
    errors: plan.counts.error,
    reversible: plan.shape !== 'holdings',
  };
}

const toInput = (v) => ({
  date: v.trade_date, ticker: v.ticker, name: v.name, side: v.side,
  qty: v.qty, price: v.price, fee: v.fee, currency: v.currency, note: v.note,
});

const toFlowInput = (v) => ({
  date: v.flow_date, type: v.type, amount: v.amount, currency: v.currency, comment: v.comment,
});

// ---------------------------------------------------------------- wsady i cofanie

export function listBatches(portfolioId, limit = 30) {
  return getDb().prepare(`
    SELECT b.*,
           (SELECT COUNT(*) FROM transactions t WHERE t.import_batch_id = b.id) AS tx_remaining,
           (SELECT COUNT(*) FROM cash_flows  c WHERE c.import_batch_id = b.id) AS cf_remaining
    FROM import_batches b
    WHERE b.portfolio_id = ?
    ORDER BY b.created_at DESC
    LIMIT ?
  `).all(portfolioId, limit).map((row) => ({
    id: row.id,
    kind: row.kind,
    profile: row.profile,
    filename: row.filename,
    rowCount: row.row_count,
    skippedCount: row.skipped_count,
    createdAt: row.created_at,
    undoneAt: row.undone_at,
    remaining: (row.tx_remaining ?? 0) + (row.cf_remaining ?? 0),
    reversible: row.kind !== 'holdings' && !row.undone_at && ((row.tx_remaining ?? 0) + (row.cf_remaining ?? 0)) > 0,
  }));
}

/**
 * Cofniecie wsadu. Usuwa wylacznie wiersze, ktore wciaz naleza do tego importu.
 *
 * Wiersz zmieniony recznie po imporcie zostal juz odpiety od wsadu przez
 * updateTransaction/updateCashFlow, wiec nie ma go tu czym zlapac - i o to chodzi.
 * Swiadomie NIE porownujemy updated_at z created_at: znacznik ma rozdzielczosc
 * milisekundy, wiec edycja tuz po imporcie bylaby nie do odroznienia od jej braku.
 */
export function undoBatch(portfolioId, batchId, ctx = {}) {
  const batch = getDb()
    .prepare('SELECT * FROM import_batches WHERE id = ? AND portfolio_id = ?')
    .get(batchId, portfolioId);
  if (!batch) throw new HttpError(404, 'import_batch_not_found');
  if (batch.undone_at) throw badRequest('import_batch_already_undone');
  if (batch.kind === 'holdings') throw badRequest('import_batch_not_reversible');

  const result = dbTx(() => {
    const tx = getDb().prepare('DELETE FROM transactions WHERE import_batch_id = ? AND portfolio_id = ?')
      .run(batchId, portfolioId).changes;
    const cf = getDb().prepare('DELETE FROM cash_flows WHERE import_batch_id = ? AND portfolio_id = ?')
      .run(batchId, portfolioId).changes;

    getDb().prepare('UPDATE import_batches SET undone_at = ? WHERE id = ?').run(nowIso(), batchId);

    const removed = Number(tx) + Number(cf);
    // Roznica wobec liczby zapisanej przy imporcie to wiersze, ktorych juz tu nie ma:
    // poprawione recznie (odpiete) albo skasowane pojedynczo.
    return { removed, kept: Math.max(0, batch.row_count - removed) };
  });

  audit({
    userId: ctx.userId, portfolioId, action: 'import.undone', entity: 'import_batch',
    entityId: batchId, ip: ctx.ip, detail: result,
  });
  return result;
}
