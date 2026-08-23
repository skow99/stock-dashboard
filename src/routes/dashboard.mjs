// src/routes/dashboard.mjs - snapshot dashboardu, CSV, historia cen, benchmarki, health.
import config from '../config.mjs';
import { sendJson, sendText, badRequest } from '../http.mjs';
import { resolveScope, listPortfolios } from '../portfolios.mjs';
import { buildSnapshot, positionsToCsv } from '../snapshot.mjs';
import { getPriceHistory, BENCHMARKS, normalizeRange } from '../market/history.mjs';
import { canonicalTicker } from '../market/tickers.mjs';
import { getDb } from '../db.mjs';
import { todayWarsaw } from '../dates.mjs';

async function snapshotForRequest(ctx) {
  const requested = ctx.query.get('portfolio');
  const scope = resolveScope(ctx.userId, requested);
  if (scope.mode === 'empty') {
    return {
      ok: true,
      asOf: new Date().toISOString(),
      scope: { mode: 'empty', portfolioIds: [], portfolioCount: 0, activePortfolio: null },
      empty: true,
      portfolios: [],
      positions: [],
      transactions: [],
      cashFlows: [],
      history: [],
    };
  }
  return buildSnapshot({
    userId: ctx.userId,
    portfolios: scope.mode === 'all' ? scope.portfolios : [scope.active],
    mode: scope.mode,
    force: ctx.query.get('force') === '1',
  });
}

export function registerDashboardRoutes(router) {
  /**
   * GET /api/v1/dashboard?portfolio=<id|slug|all>
   * Jeden endpoint obsluguje widok pojedynczego portfela i widok skonsolidowany.
   */
  router.get('/dashboard', async (ctx) => {
    const payload = await snapshotForRequest(ctx);
    sendJson(ctx.res, 200, payload);
  });

  router.get('/dashboard.csv', async (ctx) => {
    const payload = await snapshotForRequest(ctx);
    const csv = positionsToCsv(payload.positions ?? [], {
      includePortfolio: payload.scope.mode === 'all',
      locale: ctx.locale,
    });
    const suffix = payload.scope.mode === 'all'
      ? (ctx.locale === 'en' ? 'all' : 'wszystkie')
      : (payload.scope.activePortfolio?.slug ?? 'portfolio');
    sendText(ctx.res, 200, csv, 'text/csv; charset=utf-8', {
      'content-disposition': `attachment; filename="portfolio-${suffix}-${todayWarsaw()}.csv"`,
    });
  });

  /** Lekki przeglad wszystkich portfeli - do naglowka i przelacznika, bez pelnego snapshotu. */
  router.get('/overview', async (ctx) => {
    const portfolios = listPortfolios(ctx.userId);
    if (!portfolios.length) {
      sendJson(ctx.res, 200, { ok: true, totalPln: 0, portfolios: [] });
      return;
    }
    const snapshot = await buildSnapshot({ userId: ctx.userId, portfolios, mode: 'all' });
    sendJson(ctx.res, 200, {
      ok: true,
      asOf: snapshot.asOf,
      totalPln: snapshot.totals.totalPln,
      investedPln: snapshot.totals.investedPln,
      cashPln: snapshot.totals.cashPln,
      performance: snapshot.performance,
      portfolios: snapshot.portfolios,
    });
  });

  router.get('/price-history', async (ctx) => {
    const symbolRaw = ctx.query.get('symbol');
    if (!symbolRaw) throw badRequest('missing_symbol');
    const symbol = symbolRaw.startsWith('^') ? symbolRaw.toUpperCase() : canonicalTicker(symbolRaw);
    const range = normalizeRange(ctx.query.get('range'));
    const result = await getPriceHistory(symbol, range);
    sendJson(ctx.res, 200, {
      ok: result.points.length > 0,
      symbol,
      range,
      providerSymbol: result.providerSymbol,
      provider: result.provider,
      points: result.points,
      cached: result.cached,
      cacheAgeMs: result.cacheAgeMs,
      stale: result.stale,
    });
  });

  router.get('/benchmarks', (ctx) => {
    sendJson(ctx.res, 200, { ok: true, benchmarks: BENCHMARKS });
  });

  /** Health nie wymaga sesji - sluzy monitoringowi i systemd. Nie ujawnia danych uzytkownikow. */
  router.get('/health', (ctx) => {
    let dbOk = true;
    try { getDb().prepare('SELECT 1').get(); } catch { dbOk = false; }
    sendJson(ctx.res, dbOk ? 200 : 503, {
      ok: dbOk,
      version: config.version,
      uptimeSeconds: Math.round(process.uptime()),
      db: dbOk ? 'ok' : 'error',
      offline: config.offlineMarketData,
      time: new Date().toISOString(),
    });
  }, { auth: 'public', csrf: false });
}
