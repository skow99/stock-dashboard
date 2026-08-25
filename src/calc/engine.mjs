// src/calc/engine.mjs - czyste funkcje domenowe: pozycje, gotowka, wynik zrealizowany, pozycje zamkniete.
// Zero I/O i zero SQL - dzieki temu cala arytmetyka portfela jest testowalna jednostkowo.
import { normalizeTickerKey, inferCurrency, regionOf } from '../market/tickers.mjs';
import { fxToPln } from '../market/fx.mjs';

const EPS = 1e-9;

/** Sortowanie deterministyczne: data, potem czas dodania, potem id. */
export function sortTransactions(transactions) {
  return [...transactions].sort((a, b) => (
    a.trade_date.localeCompare(b.trade_date)
    || String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))
    || String(a.id).localeCompare(String(b.id))
  ));
}

/**
 * Przetwarza ledger transakcji metoda sredniego kosztu.
 * Zwraca stan pozycji, wzbogacone transakcje (realizedPnl) i przeplyw gotowki z obrotu.
 */
export function replayLedger({ transactions = [], baseline = [], fxRates = {} }) {
  const state = new Map();  // key -> { key, ticker, name, qty, cost, currency }
  const baselineByKey = new Map();

  // Instrument ma jedna walute notowania (wynika z tickera, np. ASTS.US -> USD),
  // niezalezna od tego, w jakiej walucie broker rozliczyl POJEDYNCZA transakcje
  // (np. XTB czasem ksieguje zlecenie w PLN mimo ze spolka notowana jest w USD).
  // Bez tego przewalutowania koszt/wartosc pozycji myliby waluty jak liczby tej samej jednostki.
  const crossFx = (amount, fromCurrency, toCurrency) => {
    if (fromCurrency === toCurrency) return amount;
    return amount * fxToPln(fxRates, fromCurrency) / fxToPln(fxRates, toCurrency);
  };

  for (const item of baseline) {
    const key = normalizeTickerKey(item.symbol);
    baselineByKey.set(key, item);
    const currency = inferCurrency(item.symbol);
    const qty = Number(item.qty) || 0;
    const avg = Number(item.avg) || 0;
    state.set(key, {
      key,
      ticker: item.symbol,
      name: item.name || item.symbol,
      qty,
      cost: crossFx(qty * avg, item.currency || currency, currency),
      currency,
      fromBaseline: true,
    });
  }

  const enriched = [];
  let tradeCashPln = 0;
  // Ten sam przeplyw gotowki, ale w walutach ORYGINALNYCH i bez przeliczenia.
  // Potrzebny przy odtwarzaniu historii: ta sama transakcja wyceniana jest tam
  // kursem z KAZDEGO kolejnego dnia, wiec kwota w PLN nie moze byc zamrozona.
  const tradeCashByCurrency = {};
  const warnings = [];

  for (const tx of sortTransactions(transactions)) {
    const key = normalizeTickerKey(tx.ticker);
    const currency = tx.currency || inferCurrency(tx.ticker);
    const fx = fxToPln(fxRates, currency);
    const qty = Number(tx.qty) || 0;
    const price = Number(tx.price) || 0;
    const fee = Number(tx.fee) || 0;
    // Transakcje 'bootstrap' odtwarzaja stan poczatkowy przeniesiony od brokera.
    // Buduja pozycje i koszt, ale NIE ruszaja gotowki - inaczej cash spadlby dwukrotnie.
    const affectsCash = tx.source !== 'bootstrap';

    let position = state.get(key);
    if (!position) {
      position = { key, ticker: tx.ticker, name: tx.name || tx.ticker, qty: 0, cost: 0, currency: inferCurrency(tx.ticker) };
      state.set(key, position);
    }
    if (!position.name && tx.name) position.name = tx.name;
    const toPositionCcy = (amount) => crossFx(amount, currency, position.currency);

    const record = { ...tx, realizedPnl: null, realizedPct: null, grossValue: qty * price, fxRate: fx };

    if (tx.side === 'BUY') {
      position.qty += qty;
      position.cost += toPositionCcy(qty * price + fee);
      if (affectsCash) {
        tradeCashPln -= (qty * price + fee) * fx;
        tradeCashByCurrency[currency] = (tradeCashByCurrency[currency] ?? 0) - (qty * price + fee);
      }
    } else if (tx.side === 'SELL') {
      const available = Math.max(0, position.qty);
      const matched = Math.min(qty, available);
      if (matched + EPS < qty) {
        warnings.push({
          code: 'orphan_sell',
          message: `SELL ${tx.ticker} ${qty} przekracza stan ${available} na ${tx.trade_date}`,
          transactionId: tx.id,
        });
      }
      if (matched > 0) {
        const avgCost = position.cost / position.qty;
        const costPart = matched * avgCost;
        const proceeds = toPositionCcy(matched * price - fee);
        record.realizedPnl = proceeds - costPart;
        record.realizedPct = costPart > EPS ? (record.realizedPnl / costPart) * 100 : null;
        record.realizedPnlPln = record.realizedPnl * fxToPln(fxRates, position.currency);
        position.qty -= matched;
        position.cost -= costPart;
        if (position.qty <= EPS) { position.qty = 0; position.cost = 0; }
      }
      // Kluczowa ochrona: do gotowki wchodzi wylacznie ilosc faktycznie posiadana.
      if (affectsCash) {
        tradeCashPln += (matched * price - fee) * fx;
        tradeCashByCurrency[currency] = (tradeCashByCurrency[currency] ?? 0) + (matched * price - fee);
      }
    }

    record.valuePln = record.grossValue * fx;
    enriched.push(record);
  }

  return {
    positionState: state,
    transactions: enriched,
    tradeCashPln,
    tradeCashByCurrency,
    warnings,
    baselineByKey,
  };
}

/** Buduje wiersze tabeli pozycji na podstawie stanu ledgeru i notowan. */
export function buildPositions({ positionState, quotes, fxRates, sectors = {}, notes = {}, portfolioMeta = null }) {
  const rows = [];
  for (const position of positionState.values()) {
    if (position.qty <= EPS) continue;
    const symbol = String(position.ticker).toUpperCase();
    const quote = quotes.get(symbol) ?? { price: null, prevClose: null, fresh: false, source: 'none' };
    const currency = position.currency || inferCurrency(symbol);
    const fx = fxToPln(fxRates, currency);
    const avg = position.qty > EPS ? position.cost / position.qty : 0;
    const price = Number.isFinite(quote.price) ? quote.price : avg;
    const value = position.qty * price;
    const note = notes[symbol] ?? notes[position.key] ?? {};

    const dayPct = Number.isFinite(quote.prevClose) && quote.prevClose > EPS
      ? ((price - quote.prevClose) / quote.prevClose) * 100
      : null;

    rows.push({
      symbol,
      key: position.key,
      name: position.name || symbol,
      qty: position.qty,
      avg,
      price,
      priceSource: quote.source,
      priceFresh: Boolean(quote.fresh),
      currency,
      fxRate: fx,
      value,
      valuePln: value * fx,
      costPln: position.cost * fx,
      pnl: value - position.cost,
      pnlPln: (value - position.cost) * fx,
      pnlPct: position.cost > EPS ? ((value - position.cost) / position.cost) * 100 : null,
      dayPct,
      dayPln: dayPct === null ? null : (value * fx) * (dayPct / 100) / (1 + dayPct / 100),
      sector: sectors[position.key] ?? sectors[symbol] ?? 'Other',
      region: regionOf(symbol, currency),
      note: note.note ?? '',
      plan: note.plan ?? '',
      stopLoss: note.stop_loss ?? null,
      portfolioId: portfolioMeta?.id ?? null,
      portfolioName: portfolioMeta?.name ?? null,
      portfolioColor: portfolioMeta?.color ?? null,
    });
  }

  const total = rows.reduce((sum, row) => sum + row.valuePln, 0);
  for (const row of rows) row.weight = total > EPS ? (row.valuePln / total) * 100 : 0;
  rows.sort((a, b) => b.valuePln - a.valuePln);
  return rows;
}

/** Saldo gotowki: przeplywy zewnetrzne + obrot. Zwraca PLN oraz rozbicie na waluty. */
export function computeCash({ cashFlows = [], tradeCashPln = 0, fxRates = {} }) {
  const byCurrency = {};
  let flowsPln = 0;
  let externalNetPln = 0;
  let dividendsPln = 0;

  for (const flow of cashFlows) {
    const currency = String(flow.currency ?? 'PLN').toUpperCase();
    const fx = fxToPln(fxRates, currency);
    const amount = Number(flow.amount) || 0;
    byCurrency[currency] = (byCurrency[currency] ?? 0) + amount;
    flowsPln += amount * fx;
    if (flow.type === 'Deposit' || flow.type === 'Withdrawal') externalNetPln += amount * fx;
    if (flow.type === 'Dividend' || flow.type === 'Interest') dividendsPln += amount * fx;
  }

  return {
    cashPln: flowsPln + tradeCashPln,
    byCurrency,
    externalNetPln,
    dividendsPln,
    flowsPln,
    tradeCashPln,
  };
}

/** Zrealizowany wynik zagregowany per ticker oraz per rok (podstawa szacunku podatku). */
export function summarizeRealized(transactions) {
  const perTicker = new Map();
  const perYear = new Map();
  let totalPln = 0;

  for (const tx of transactions) {
    if (!Number.isFinite(tx.realizedPnlPln)) continue;
    const key = normalizeTickerKey(tx.ticker);
    const entry = perTicker.get(key) ?? { key, ticker: tx.ticker, name: tx.name || tx.ticker, realizedPln: 0, trades: 0 };
    entry.realizedPln += tx.realizedPnlPln;
    entry.trades += 1;
    perTicker.set(key, entry);

    const year = tx.trade_date.slice(0, 4);
    perYear.set(year, (perYear.get(year) ?? 0) + tx.realizedPnlPln);
    totalPln += tx.realizedPnlPln;
  }

  return {
    perTicker: [...perTicker.values()].sort((a, b) => b.realizedPln - a.realizedPln),
    perYear: Object.fromEntries(perYear),
    totalPln,
  };
}

/** Pozycje w pelni zamkniete: suma BUY == suma SELL i obie > 0. */
export function buildClosedPositions(transactions) {
  const groups = new Map();
  for (const tx of transactions) {
    const key = normalizeTickerKey(tx.ticker);
    const group = groups.get(key) ?? {
      key, ticker: tx.ticker, name: tx.name || tx.ticker, currency: tx.currency,
      buyQty: 0, buyValue: 0, sellQty: 0, sellValue: 0, realizedPln: 0, lastSell: null,
    };
    const qty = Number(tx.qty) || 0;
    const price = Number(tx.price) || 0;
    if (tx.side === 'BUY') { group.buyQty += qty; group.buyValue += qty * price; }
    else { group.sellQty += qty; group.sellValue += qty * price; group.lastSell = tx.trade_date; }
    if (Number.isFinite(tx.realizedPnlPln)) group.realizedPln += tx.realizedPnlPln;
    if (tx.name && !group.name) group.name = tx.name;
    groups.set(key, group);
  }

  return [...groups.values()]
    .filter((g) => g.buyQty > EPS && g.sellQty > EPS && Math.abs(g.buyQty - g.sellQty) < 1e-6)
    .map((g) => {
      const avgBuy = g.buyValue / g.buyQty;
      const avgSell = g.sellValue / g.sellQty;
      const pnl = g.sellValue - g.buyValue;
      return {
        closedOn: g.lastSell,
        ticker: g.ticker,
        name: g.name,
        avgBuy,
        avgSell,
        qty: g.buyQty,
        pnl,
        pnlPln: g.realizedPln,
        pnlPct: g.buyValue > EPS ? (pnl / g.buyValue) * 100 : null,
        currency: g.currency,
      };
    })
    .sort((a, b) => String(b.closedOn ?? '').localeCompare(String(a.closedOn ?? '')));
}

/** Ekspozycja sektorowa liczona z wierszy pozycji. */
export function buildSectorExposure(positions) {
  const total = positions.reduce((sum, p) => sum + p.valuePln, 0);
  const map = new Map();
  for (const p of positions) map.set(p.sector, (map.get(p.sector) ?? 0) + p.valuePln);
  return [...map.entries()]
    .map(([sector, valuePln]) => ({ sector, valuePln, pct: total > EPS ? (valuePln / total) * 100 : 0 }))
    .sort((a, b) => b.valuePln - a.valuePln);
}

export function concentrationTop(positions, n = 5) {
  const total = positions.reduce((sum, p) => sum + p.valuePln, 0);
  if (total <= EPS) return 0;
  const top = positions.slice(0, n).reduce((sum, p) => sum + p.valuePln, 0);
  return (top / total) * 100;
}
