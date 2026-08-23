// src/ledger.mjs - repozytorium ledgeru: transakcje, przeplywy gotowki, notatki, baseline, historia.
// Wszystkie funkcje przyjmuja portfolioId juz ZWERYFIKOWANY przez requirePortfolio().
import { getDb, newId, nowIso, audit } from './db.mjs';
import { badRequest, notFound, conflict } from './http.mjs';
import { isValidDay } from './dates.mjs';
import { canonicalTicker, inferCurrency, CURRENCIES, normalizeTickerKey } from './market/tickers.mjs';

const SIDES = ['BUY', 'SELL'];
export const FLOW_TYPES = ['Deposit', 'Withdrawal', 'Dividend', 'Interest', 'Fee', 'Tax'];

const FLOW_ALIASES = {
  wplata: 'Deposit', deposit: 'Deposit', wplaty: 'Deposit',
  wyplata: 'Withdrawal', withdrawal: 'Withdrawal', wyplaty: 'Withdrawal',
  dywidenda: 'Dividend', dividend: 'Dividend',
  odsetki: 'Interest', interest: 'Interest',
  prowizja: 'Fee', fee: 'Fee',
  podatek: 'Tax', tax: 'Tax',
};

// ------------------------------------------------------------ walidacja

function num(value, field, { positive = false, nonZero = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest('invalid_number', { field });
  if (positive && n <= 0) throw badRequest('number_must_be_positive', { field });
  if (nonZero && n === 0) throw badRequest('number_must_not_be_zero', { field });
  if (Math.abs(n) > 1e12) throw badRequest('number_out_of_range', { field });
  return n;
}

function day(value, field = 'date') {
  if (!isValidDay(String(value ?? '').trim())) throw badRequest('invalid_date', { field });
  return String(value).trim();
}

function currency(value, fallback) {
  const code = String(value ?? fallback ?? 'PLN').toUpperCase();
  if (!CURRENCIES.includes(code)) throw badRequest('invalid_currency', { list: CURRENCIES.join(', ') });
  return code;
}

export function validateTransaction(input) {
  const side = String(input.side ?? '').toUpperCase();
  if (!SIDES.includes(side)) throw badRequest('invalid_side');
  const ticker = canonicalTicker(input.ticker, { venue: input.venue, currency: input.currency });
  if (!ticker) throw badRequest('invalid_ticker', { field: 'ticker', max: 24 });
  if (ticker.length > 24) throw badRequest('invalid_ticker', { field: 'ticker', max: 24 });
  return {
    trade_date: day(input.date ?? input.trade_date),
    ticker,
    name: String(input.name ?? '').trim().slice(0, 80),
    side,
    qty: num(input.qty, 'qty', { positive: true }),
    price: num(input.price, 'price', { positive: true }),
    fee: input.fee === undefined || input.fee === null || input.fee === '' ? 0 : num(input.fee, 'fee'),
    currency: currency(input.currency, inferCurrency(ticker)),
    note: String(input.note ?? '').slice(0, 500),
    source: ['manual', 'bootstrap', 'import', 'webhook:xtb', 'webhook:ibkr'].includes(input.source) ? input.source : 'manual',
    external_id: input.externalId ? String(input.externalId).slice(0, 80) : null,
    import_batch_id: input.importBatchId ? String(input.importBatchId).slice(0, 80) : null,
  };
}

export function validateCashFlow(input) {
  const rawType = String(input.type ?? '').trim();
  const type = FLOW_TYPES.includes(rawType) ? rawType : FLOW_ALIASES[rawType.toLowerCase()];
  if (!type) throw badRequest('invalid_type', { list: FLOW_TYPES.join(', ') });
  let amount = num(input.amount, 'amount', { nonZero: true });
  // Wyplaty, prowizje i podatek zawsze zapisujemy jako wartosc ujemna - niezaleznie od tego, co przyszlo.
  if (['Withdrawal', 'Fee', 'Tax'].includes(type)) amount = -Math.abs(amount);
  else amount = Math.abs(amount);
  return {
    flow_date: day(input.date ?? input.flow_date),
    type,
    amount,
    currency: currency(input.currency, 'PLN'),
    comment: String(input.comment ?? '').slice(0, 300),
    source: ['manual', 'import', 'webhook:xtb', 'webhook:ibkr'].includes(input.source) ? input.source : 'manual',
    external_id: input.externalId ? String(input.externalId).slice(0, 80) : null,
    import_batch_id: input.importBatchId ? String(input.importBatchId).slice(0, 80) : null,
  };
}

// ------------------------------------------------------------ transakcje

export function listTransactions(portfolioIds) {
  const ids = Array.isArray(portfolioIds) ? portfolioIds : [portfolioIds];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return getDb().prepare(`
    SELECT * FROM transactions WHERE portfolio_id IN (${placeholders})
    ORDER BY trade_date, created_at, id
  `).all(...ids);
}

export function getTransaction(portfolioId, id) {
  const row = getDb().prepare('SELECT * FROM transactions WHERE id = ? AND portfolio_id = ?').get(id, portfolioId);
  if (!row) throw notFound('transaction_not_found');
  return row;
}

export function insertTransaction(portfolioId, input, ctx = {}) {
  const data = validateTransaction(input);
  const at = nowIso();
  const id = newId('tx_');
  try {
    getDb().prepare(`
      INSERT INTO transactions (id, portfolio_id, trade_date, ticker, name, side, qty, price, fee, currency, note, source, external_id, import_batch_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, portfolioId, data.trade_date, data.ticker, data.name, data.side, data.qty, data.price,
      data.fee, data.currency, data.note, data.source, data.external_id, data.import_batch_id, at, at);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw conflict('duplicate_transaction');
    throw err;
  }
  audit({ userId: ctx.userId, portfolioId, action: 'transaction.created', entity: 'transaction', entityId: id, ip: ctx.ip, detail: { ticker: data.ticker, side: data.side } });
  return getDb().prepare('SELECT * FROM transactions WHERE id = ?').get(id);
}

export function updateTransaction(portfolioId, id, input, ctx = {}) {
  const existing = getTransaction(portfolioId, id);
  const data = validateTransaction({ ...toTransactionInput(existing), ...input });
  // Reczna edycja ODPINA wiersz od wsadu importu: od tej chwili to praca uzytkownika,
  // a nie zawartosc pliku, wiec cofniecie importu nie ma prawa jej skasowac.
  // Zrodlo ('import') zostaje - wiadomo, skad wiersz sie wzial.
  getDb().prepare(`
    UPDATE transactions SET trade_date = ?, ticker = ?, name = ?, side = ?, qty = ?, price = ?, fee = ?, currency = ?, note = ?, updated_at = ?, import_batch_id = NULL
    WHERE id = ? AND portfolio_id = ?
  `).run(data.trade_date, data.ticker, data.name, data.side, data.qty, data.price, data.fee,
    data.currency, data.note, nowIso(), id, portfolioId);
  audit({ userId: ctx.userId, portfolioId, action: 'transaction.updated', entity: 'transaction', entityId: id, ip: ctx.ip });
  return getDb().prepare('SELECT * FROM transactions WHERE id = ?').get(id);
}

export function deleteTransaction(portfolioId, id, ctx = {}) {
  const existing = getTransaction(portfolioId, id);
  getDb().prepare('DELETE FROM transactions WHERE id = ? AND portfolio_id = ?').run(id, portfolioId);
  audit({ userId: ctx.userId, portfolioId, action: 'transaction.deleted', entity: 'transaction', entityId: id, ip: ctx.ip, detail: { ticker: existing.ticker } });
  return existing;
}

function toTransactionInput(row) {
  return {
    date: row.trade_date, ticker: row.ticker, name: row.name, side: row.side,
    qty: row.qty, price: row.price, fee: row.fee, currency: row.currency,
    note: row.note, source: row.source, externalId: row.external_id,
  };
}

/** Deduplikacja webhooka po polach transakcji (gdy broker nie podal id zlecenia). */
export function findDuplicateTransaction(portfolioId, data) {
  return getDb().prepare(`
    SELECT * FROM transactions
    WHERE portfolio_id = ? AND trade_date = ? AND ticker = ? AND side = ?
      AND ABS(qty - ?) < 1e-6 AND ABS(price - ?) < 1e-6
    LIMIT 1
  `).get(portfolioId, data.trade_date, data.ticker, data.side, data.qty, data.price) ?? null;
}

/** Deduplikacja przeplywu - odpowiednik powyzszej dla importu z pliku. */
export function findDuplicateCashFlow(portfolioId, data) {
  return getDb().prepare(`
    SELECT * FROM cash_flows
    WHERE portfolio_id = ? AND flow_date = ? AND type = ? AND currency = ?
      AND ABS(amount - ?) < 1e-6
    LIMIT 1
  `).get(portfolioId, data.flow_date, data.type, data.currency, data.amount) ?? null;
}

// ------------------------------------------------------------ przeplywy gotowki

export function listCashFlows(portfolioIds) {
  const ids = Array.isArray(portfolioIds) ? portfolioIds : [portfolioIds];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return getDb().prepare(`
    SELECT * FROM cash_flows WHERE portfolio_id IN (${placeholders}) ORDER BY flow_date, created_at, id
  `).all(...ids);
}

export function insertCashFlow(portfolioId, input, ctx = {}) {
  const data = validateCashFlow(input);
  const at = nowIso();
  const id = newId('cf_');
  try {
    getDb().prepare(`
      INSERT INTO cash_flows (id, portfolio_id, flow_date, type, amount, currency, comment, source, external_id, import_batch_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, portfolioId, data.flow_date, data.type, data.amount, data.currency, data.comment,
      data.source, data.external_id, data.import_batch_id, at, at);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw conflict('duplicate_flow');
    throw err;
  }
  audit({ userId: ctx.userId, portfolioId, action: 'cashflow.created', entity: 'cash_flow', entityId: id, ip: ctx.ip, detail: { type: data.type, amount: data.amount } });
  return getDb().prepare('SELECT * FROM cash_flows WHERE id = ?').get(id);
}

export function updateCashFlow(portfolioId, id, input, ctx = {}) {
  const existing = getDb().prepare('SELECT * FROM cash_flows WHERE id = ? AND portfolio_id = ?').get(id, portfolioId);
  if (!existing) throw notFound('flow_not_found');
  const data = validateCashFlow({
    date: existing.flow_date, type: existing.type, amount: existing.amount,
    currency: existing.currency, comment: existing.comment, ...input,
  });
  // Jak wyzej - edycja odpina przeplyw od wsadu importu.
  getDb().prepare(`
    UPDATE cash_flows SET flow_date = ?, type = ?, amount = ?, currency = ?, comment = ?, updated_at = ?, import_batch_id = NULL
    WHERE id = ? AND portfolio_id = ?
  `).run(data.flow_date, data.type, data.amount, data.currency, data.comment, nowIso(), id, portfolioId);
  audit({ userId: ctx.userId, portfolioId, action: 'cashflow.updated', entity: 'cash_flow', entityId: id, ip: ctx.ip });
  return getDb().prepare('SELECT * FROM cash_flows WHERE id = ?').get(id);
}

export function deleteCashFlow(portfolioId, id, ctx = {}) {
  const existing = getDb().prepare('SELECT * FROM cash_flows WHERE id = ? AND portfolio_id = ?').get(id, portfolioId);
  if (!existing) throw notFound('flow_not_found');
  getDb().prepare('DELETE FROM cash_flows WHERE id = ?').run(id);
  audit({ userId: ctx.userId, portfolioId, action: 'cashflow.deleted', entity: 'cash_flow', entityId: id, ip: ctx.ip });
  return existing;
}

// ------------------------------------------------------------ baseline, notatki, sektory, historia

export function listBaseline(portfolioIds) {
  const ids = Array.isArray(portfolioIds) ? portfolioIds : [portfolioIds];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return getDb().prepare(`SELECT * FROM holdings_baseline WHERE portfolio_id IN (${placeholders})`).all(...ids)
    .map((row) => ({
      portfolioId: row.portfolio_id,
      symbol: row.symbol,
      name: row.name,
      qty: row.qty,
      avg: row.avg,
      currency: row.currency,
      sector: row.sector,
      market: row.market,
      source: row.source,
      fallbackPrice: row.fallback_price,
    }));
}

export function upsertBaseline(portfolioId, input) {
  const symbol = canonicalTicker(input.symbol, { currency: input.currency });
  if (!symbol) throw badRequest('invalid_ticker', { field: 'symbol', max: 24 });
  const at = nowIso();
  getDb().prepare(`
    INSERT INTO holdings_baseline (id, portfolio_id, symbol, name, qty, avg, currency, sector, market, source, fallback_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(portfolio_id, symbol) DO UPDATE SET
      name = excluded.name, qty = excluded.qty, avg = excluded.avg, currency = excluded.currency,
      sector = excluded.sector, market = excluded.market, source = excluded.source, fallback_price = excluded.fallback_price
  `).run(
    newId('hb_'), portfolioId, symbol, String(input.name ?? '').slice(0, 80),
    num(input.qty ?? 0, 'qty'), num(input.avg ?? 0, 'avg'),
    currency(input.currency, inferCurrency(symbol)),
    String(input.sector ?? '').slice(0, 40), String(input.market ?? '').slice(0, 20),
    String(input.source ?? 'stooq').slice(0, 20),
    input.fallbackPrice === undefined || input.fallbackPrice === null ? null : num(input.fallbackPrice, 'fallbackPrice'),
  );
  void at;
}

export function listNotes(portfolioIds) {
  const ids = Array.isArray(portfolioIds) ? portfolioIds : [portfolioIds];
  if (!ids.length) return {};
  const placeholders = ids.map(() => '?').join(',');
  const rows = getDb().prepare(`SELECT * FROM position_notes WHERE portfolio_id IN (${placeholders})`).all(...ids);
  const out = {};
  for (const row of rows) {
    out[row.symbol] = { note: row.note, plan: row.plan, stop_loss: row.stop_loss, updatedAt: row.updated_at };
    out[normalizeTickerKey(row.symbol)] = out[row.symbol];
  }
  return out;
}

export function saveNote(portfolioId, input, ctx = {}) {
  const symbol = canonicalTicker(input.symbol);
  if (!symbol) throw badRequest('invalid_ticker', { field: 'symbol', max: 24 });
  const note = String(input.note ?? '').slice(0, 1000);
  const plan = String(input.plan ?? '').slice(0, 200);
  const stopLoss = input.stopLoss === undefined || input.stopLoss === null || input.stopLoss === ''
    ? null : num(input.stopLoss, 'stopLoss');

  if (!note && !plan && stopLoss === null) {
    getDb().prepare('DELETE FROM position_notes WHERE portfolio_id = ? AND symbol = ?').run(portfolioId, symbol);
    return { symbol, deleted: true };
  }
  getDb().prepare(`
    INSERT INTO position_notes (portfolio_id, symbol, note, plan, stop_loss, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(portfolio_id, symbol) DO UPDATE SET
      note = excluded.note, plan = excluded.plan, stop_loss = excluded.stop_loss, updated_at = excluded.updated_at
  `).run(portfolioId, symbol, note, plan, stopLoss, nowIso());
  void ctx;
  return { symbol, note, plan, stopLoss };
}

export function getSectors() {
  const rows = getDb().prepare('SELECT * FROM sectors').all();
  return Object.fromEntries(rows.map((row) => [row.ticker_key, row.sector]));
}

export function upsertSector(tickerKey, sector) {
  getDb().prepare(`
    INSERT INTO sectors (ticker_key, sector) VALUES (?, ?)
    ON CONFLICT(ticker_key) DO UPDATE SET sector = excluded.sector
  `).run(normalizeTickerKey(tickerKey), String(sector ?? 'Other').slice(0, 40));
}

export function listHistory(portfolioIds) {
  const ids = Array.isArray(portfolioIds) ? portfolioIds : [portfolioIds];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  // Widok skonsolidowany sumuje wartosci portfeli w obrebie tego samego dnia.
  return getDb().prepare(`
    SELECT day,
           SUM(total_pln)    AS totalPln,
           SUM(invested_pln) AS investedPln,
           SUM(cash_pln)     AS cashPln,
           MAX(provisional)  AS provisional,
           COUNT(*)          AS portfolioCount
    FROM portfolio_history
    WHERE portfolio_id IN (${placeholders})
    GROUP BY day
    ORDER BY day
  `).all(...ids).map((row) => ({ ...row, provisional: Boolean(row.provisional) }));
}

export function upsertHistoryPoint(portfolioId, point) {
  getDb().prepare(`
    INSERT INTO portfolio_history (portfolio_id, day, total_pln, invested_pln, cash_pln, provisional, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(portfolio_id, day) DO UPDATE SET
      total_pln = excluded.total_pln, invested_pln = excluded.invested_pln,
      cash_pln = excluded.cash_pln, provisional = excluded.provisional, updated_at = excluded.updated_at
  `).run(portfolioId, point.day, point.totalPln, point.investedPln ?? 0, point.cashPln ?? 0,
    point.provisional ? 1 : 0, nowIso());
}
