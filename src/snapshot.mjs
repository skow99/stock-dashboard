// src/snapshot.mjs - zlozenie pelnego stanu dashboardu dla jednego portfela ALBO widoku skonsolidowanego.
//
// Kontrakt: snapshot jest zawsze budowany per portfel, a widok "Wszystkie portfele" powstaje przez
// agregacje tych samych struktur. Dzieki temu nie ma dwoch rownoleglych implementacji arytmetyki.
import config from './config.mjs';
import { getSectors, listBaseline, listCashFlows, listHistory, listNotes, listTransactions, upsertHistoryPoint, upsertSector } from './ledger.mjs';
import { getFxRates, fxToPln } from './market/fx.mjs';
import { getQuotes, coverage } from './market/quotes.mjs';
import { getSectorsFor } from './market/sector.mjs';
import { providersStatus } from './market/providers.mjs';
import { normalizeTickerKey } from './market/tickers.mjs';
import {
  replayLedger, buildPositions, computeCash, summarizeRealized,
  buildClosedPositions, buildSectorExposure, concentrationTop,
} from './calc/engine.mjs';
import { buildPerformance, buildTwrIndex, externalFlowsByDay, returnOnCapital } from './calc/performance.mjs';
import { canWriteFinalSnapshot, todayWarsaw } from './dates.mjs';
import { log } from './log.mjs';
import { csvHeaders } from './i18n.mjs';

const HISTORY_MIN_COVERAGE = 0.8;
const snapshotCache = new Map(); // scopeKey -> { at, payload }

function scopeKey(userId, ids, mode) {
  return `${userId}|${mode}|${[...ids].sort().join(',')}`;
}

export function invalidateSnapshots(userId) {
  for (const key of snapshotCache.keys()) {
    if (key.startsWith(`${userId}|`)) snapshotCache.delete(key);
  }
}

/** Stan pojedynczego portfela: pozycje, gotowka, wynik. Bez zapisu do bazy. */
function computePortfolio({ portfolio, transactions, cashFlows, baseline, notes, sectors, quotes, fxRates }) {
  const ledger = replayLedger({ transactions, baseline, fxRates });
  const positions = buildPositions({
    positionState: ledger.positionState,
    quotes,
    fxRates,
    sectors,
    notes,
    portfolioMeta: portfolio,
  });
  const cash = computeCash({ cashFlows, tradeCashPln: ledger.tradeCashPln, fxRates });
  const investedPln = positions.reduce((sum, p) => sum + p.valuePln, 0);
  const realized = summarizeRealized(ledger.transactions);

  return {
    portfolio,
    positions,
    cash,
    investedPln,
    totalPln: investedPln + cash.cashPln,
    realized,
    closedPositions: buildClosedPositions(ledger.transactions),
    transactions: ledger.transactions,
    cashFlows,
    warnings: ledger.warnings.map((w) => ({ ...w, portfolioId: portfolio.id })),
  };
}

/**
 * @param {object} args
 * @param {string} args.userId
 * @param {Array}  args.portfolios - portfele w zakresie (1 lub N)
 * @param {'single'|'all'} args.mode
 */
export async function buildSnapshot({ userId, portfolios, mode, force = false }) {
  const ids = portfolios.map((p) => p.id);
  const key = scopeKey(userId, ids, mode);
  const cached = snapshotCache.get(key);
  if (!force && cached && Date.now() - cached.at < config.portfolioCacheMs) {
    return { ...cached.payload, cached: true, cacheAgeMs: Date.now() - cached.at };
  }

  const today = todayWarsaw();
  const fx = await getFxRates();
  const fxRates = fx.rates;
  const sectors = getSectors();

  // Jeden odczyt bazy na caly zakres, potem podzial per portfel.
  const allTransactions = listTransactions(ids);
  const allFlows = listCashFlows(ids);
  const allBaseline = listBaseline(ids);
  const notes = listNotes(ids);

  const byPortfolio = new Map(ids.map((id) => [id, { transactions: [], cashFlows: [], baseline: [] }]));
  for (const tx of allTransactions) byPortfolio.get(tx.portfolio_id)?.transactions.push(tx);
  for (const flow of allFlows) byPortfolio.get(flow.portfolio_id)?.cashFlows.push(flow);
  for (const item of allBaseline) byPortfolio.get(item.portfolioId)?.baseline.push(item);

  // Notowania pobieramy RAZ dla sumy symboli calego zakresu - N portfeli nie oznacza N razy wiecej ruchu.
  const specs = new Map();
  for (const tx of allTransactions) {
    specs.set(tx.ticker.toUpperCase(), { symbol: tx.ticker.toUpperCase() });
  }
  for (const item of allBaseline) {
    specs.set(item.symbol.toUpperCase(), {
      symbol: item.symbol.toUpperCase(),
      fallbackPrice: item.fallbackPrice,
      source: item.source === 'yahoo' ? 'yahoo' : null,
    });
  }
  const quotes = await getQuotes([...specs.values()]);
  const quoteCoverage = coverage(quotes);

  // Sektor dla nowych tickerow: dopoki nie ma go w tabeli 'sectors', pozycja wisi pod
  // 'Other' na zawsze (nic wczesniej go tam nie wpisywalo). Doszukujemy go u Yahoo raz
  // i zapisujemy trwale - kolejne snapshoty juz nie ida po niego do sieci.
  const missingSectorSymbols = [...specs.keys()].filter((symbol) => !sectors[normalizeTickerKey(symbol)] && !sectors[symbol]);
  if (missingSectorSymbols.length) {
    const found = await getSectorsFor(missingSectorSymbols);
    for (const [tickerKey, sector] of found) {
      upsertSector(tickerKey, sector);
      sectors[tickerKey] = sector;
    }
  }

  const perPortfolio = portfolios.map((portfolio) => computePortfolio({
    portfolio,
    ...byPortfolio.get(portfolio.id),
    notes,
    sectors,
    quotes,
    fxRates,
  }));

  // ---------------------------------------------------------------- agregacja
  const positions = mode === 'all' ? mergePositions(perPortfolio) : perPortfolio[0]?.positions ?? [];
  const investedPln = perPortfolio.reduce((sum, p) => sum + p.investedPln, 0);
  const cashPln = perPortfolio.reduce((sum, p) => sum + p.cash.cashPln, 0);
  const totalPln = investedPln + cashPln;
  const cashByCurrency = {};
  for (const item of perPortfolio) {
    for (const [code, amount] of Object.entries(item.cash.byCurrency)) {
      cashByCurrency[code] = (cashByCurrency[code] ?? 0) + amount;
    }
  }

  const transactions = perPortfolio.flatMap((p) => p.transactions.map((tx) => ({
    ...tx, portfolioName: p.portfolio.name, portfolioColor: p.portfolio.color,
  })));
  const cashFlows = perPortfolio.flatMap((p) => p.cashFlows.map((flow) => ({
    ...flow, portfolioName: p.portfolio.name, portfolioColor: p.portfolio.color,
  })));
  const realized = summarizeRealized(transactions);
  const closedPositions = perPortfolio.flatMap((p) => p.closedPositions.map((c) => ({
    ...c, portfolioId: p.portfolio.id, portfolioName: p.portfolio.name,
  }))).sort((a, b) => String(b.closedOn ?? '').localeCompare(String(a.closedOn ?? '')));

  // ---------------------------------------------------------------- historia EOD
  const historyBlocked = quoteCoverage.ratio < HISTORY_MIN_COVERAGE;
  const canWrite = canWriteFinalSnapshot() && !historyBlocked;
  if (canWrite) {
    for (const item of perPortfolio) {
      upsertHistoryPoint(item.portfolio.id, {
        day: today,
        totalPln: item.totalPln,
        investedPln: item.investedPln,
        cashPln: item.cash.cashPln,
        provisional: false,
      });
    }
    log.info('history.snapshot_written', { day: today, portfolios: ids.length });
  }

  const storedHistory = listHistory(ids);
  const history = [...storedHistory];
  const lastStored = history[history.length - 1];
  // Punkt intraday: pokazuje aktualny obraz na wykresie, ale nigdy nie trafia do bazy.
  if (!canWrite && (!lastStored || lastStored.day !== today)) {
    history.push({ day: today, totalPln, investedPln, cashPln, provisional: true, transient: true });
  } else if (!canWrite && lastStored?.day === today && lastStored.provisional) {
    history[history.length - 1] = { ...lastStored, totalPln, investedPln, cashPln, transient: true };
  }

  const flowsByDay = externalFlowsByDay(cashFlows, (currency) => fxToPln(fxRates, currency));
  const performance = buildPerformance({ history, flowsByDay, currentTotal: totalPln, today });
  const twrIndex = buildTwrIndex(history.filter((p) => p.day >= '2024-01-01'), flowsByDay);

  const externalNetPln = perPortfolio.reduce((sum, p) => sum + p.cash.externalNetPln, 0);
  const dividendsPln = perPortfolio.reduce((sum, p) => sum + p.cash.dividendsPln, 0);
  const currentYear = today.slice(0, 4);
  const taxRate = mode === 'single' ? (portfolios[0]?.taxRate ?? 0.19) : 0.19;

  const payload = {
    ok: true,
    asOf: new Date().toISOString(),
    scope: {
      mode,
      portfolioIds: ids,
      portfolioCount: ids.length,
      activePortfolio: mode === 'single' ? portfolios[0] ?? null : null,
    },
    fx: { rates: fxRates, sources: fx.sources, asOf: fx.asOf },
    totals: {
      totalPln,
      investedPln,
      cashPln,
      externalNetPln,
      dividendsPln,
      top5Pct: concentrationTop(positions, 5),
      returnOnCapitalPct: returnOnCapital(totalPln, externalNetPln),
      realizedPlnTotal: realized.totalPln,
      realizedPlnCurrentYear: realized.perYear[currentYear] ?? 0,
      estimatedTaxPln: Math.max(0, realized.perYear[currentYear] ?? 0) * taxRate,
      taxYear: currentYear,
    },
    performance,
    cash: { pln: cashPln, byCurrency: cashByCurrency },
    positions,
    sectors: buildSectorExposure(positions),
    history,
    twrIndex,
    transactions,
    cashFlows,
    closedPositions,
    realizedPerTicker: realized.perTicker,
    // Rozbicie per portfel jest podstawa widoku "Wszystkie portfele".
    portfolios: perPortfolio.map((item) => ({
      ...item.portfolio,
      totalPln: item.totalPln,
      investedPln: item.investedPln,
      cashPln: item.cash.cashPln,
      positionCount: item.positions.length,
      realizedPln: item.realized.totalPln,
      weightPct: totalPln > 0 ? (item.totalPln / totalPln) * 100 : 0,
    })),
    marketDataStatus: {
      quoteCoverage,
      historyWritten: canWrite,
      historyBlocked,
      afterEodCutoff: canWriteFinalSnapshot(),
      providers: providersStatus(),
      offline: config.offlineMarketData,
    },
    warnings: perPortfolio.flatMap((p) => p.warnings),
    cached: false,
    cacheAgeMs: 0,
  };

  snapshotCache.set(key, { at: Date.now(), payload });
  return payload;
}

/**
 * Konsolidacja pozycji: ten sam instrument w kilku portfelach laczy sie w jeden wiersz
 * (srednia wazona kosztu), a szczegoly per portfel zostaja w polu `sources`.
 */
function mergePositions(perPortfolio) {
  const merged = new Map();
  for (const item of perPortfolio) {
    for (const position of item.positions) {
      const key = position.key;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          ...position,
          portfolioId: null,
          portfolioName: null,
          sources: [{ portfolioId: item.portfolio.id, portfolioName: item.portfolio.name, color: item.portfolio.color, qty: position.qty, valuePln: position.valuePln }],
        });
        continue;
      }
      const totalQty = existing.qty + position.qty;
      existing.avg = totalQty > 0 ? (existing.avg * existing.qty + position.avg * position.qty) / totalQty : 0;
      existing.qty = totalQty;
      existing.value += position.value;
      existing.valuePln += position.valuePln;
      existing.costPln += position.costPln;
      existing.pnl += position.pnl;
      existing.pnlPln += position.pnlPln;
      existing.pnlPct = existing.costPln > 0 ? (existing.pnlPln / existing.costPln) * 100 : null;
      existing.dayPln = (existing.dayPln ?? 0) + (position.dayPln ?? 0);
      existing.note = existing.note || position.note;
      existing.plan = existing.plan || position.plan;
      existing.sources.push({ portfolioId: item.portfolio.id, portfolioName: item.portfolio.name, color: item.portfolio.color, qty: position.qty, valuePln: position.valuePln });
    }
  }
  const rows = [...merged.values()];
  const total = rows.reduce((sum, row) => sum + row.valuePln, 0);
  for (const row of rows) row.weight = total > 0 ? (row.valuePln / total) * 100 : 0;
  return rows.sort((a, b) => b.valuePln - a.valuePln);
}

/** CSV aktualnych pozycji dla wybranego zakresu. Naglowki w jezyku zadania. */
export function positionsToCsv(positions, { includePortfolio = false, locale = 'pl' } = {}) {
  const h = csvHeaders(locale);
  const base = [h.ticker, h.currency, h.qty, h.avgPrice, h.lastPrice, h.valuePln, h.pnlPln, h.weightPct];
  const header = (includePortfolio ? [h.portfolio, ...base] : base).join(',');
  const escape = (value) => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = positions.map((p) => {
    const base = [
      p.symbol, p.currency, p.qty.toFixed(4), p.avg.toFixed(4),
      Number(p.price ?? 0).toFixed(4), p.valuePln.toFixed(2), p.pnlPln.toFixed(2), p.weight.toFixed(2),
    ];
    const cells = includePortfolio
      ? [p.portfolioName ?? (p.sources ?? []).map((s) => s.portfolioName).join(' + '), ...base]
      : base;
    return cells.map(escape).join(',');
  });
  return `${[header, ...rows].join('\n')}\n`;
}
