// src/routes/portfolios.mjs - CRUD portfeli, eksport/import, token webhooka.
import { readJsonBody, sendJson, badRequest } from '../http.mjs';
import {
  listPortfolios, createPortfolio, updatePortfolio, deletePortfolio,
  reorderPortfolios, requirePortfolio, publicPortfolio, rotateWebhookToken, countPortfolioData,
} from '../portfolios.mjs';
import {
  listTransactions, listCashFlows, listBaseline, listNotes, listHistory,
  insertTransaction, insertCashFlow, upsertBaseline, saveNote,
} from '../ledger.mjs';
import { invalidateSnapshots } from '../snapshot.mjs';
import { tx as dbTx, audit } from '../db.mjs';
import { rebuildPortfolioHistory } from '../history-rebuild.mjs';

export function registerPortfolioRoutes(router) {
  router.get('/portfolios', (ctx) => {
    const includeArchived = ctx.query.get('includeArchived') === '1';
    sendJson(ctx.res, 200, { ok: true, portfolios: listPortfolios(ctx.userId, { includeArchived }) });
  });

  router.post('/portfolios', async (ctx) => {
    const body = await readJsonBody(ctx.req);
    const portfolio = createPortfolio(ctx.userId, body);
    invalidateSnapshots(ctx.userId);
    sendJson(ctx.res, 201, { ok: true, portfolio });
  });

  router.get('/portfolios/:portfolioId', (ctx) => {
    const row = requirePortfolio(ctx.userId, ctx.params.portfolioId);
    sendJson(ctx.res, 200, {
      ok: true,
      portfolio: publicPortfolio(row),
      stats: countPortfolioData(row.id),
    });
  });

  router.patch('/portfolios/:portfolioId', async (ctx) => {
    const body = await readJsonBody(ctx.req);
    const portfolio = updatePortfolio(ctx.userId, ctx.params.portfolioId, body);
    invalidateSnapshots(ctx.userId);
    sendJson(ctx.res, 200, { ok: true, portfolio });
  });

  router.delete('/portfolios/:portfolioId', async (ctx) => {
    const body = await readJsonBody(ctx.req);
    const removed = deletePortfolio(ctx.userId, ctx.params.portfolioId, body.confirmName);
    invalidateSnapshots(ctx.userId);
    sendJson(ctx.res, 200, { ok: true, removed });
  });

  router.post('/portfolios/reorder', async (ctx) => {
    const body = await readJsonBody(ctx.req);
    const portfolios = reorderPortfolios(ctx.userId, body.order);
    invalidateSnapshots(ctx.userId);
    sendJson(ctx.res, 200, { ok: true, portfolios });
  });

  // Token webhooka jest pokazywany dokladnie raz - w bazie trzymamy tylko jego hash.
  router.post('/portfolios/:portfolioId/webhook-token', (ctx) => {
    const token = rotateWebhookToken(ctx.userId, ctx.params.portfolioId);
    sendJson(ctx.res, 201, {
      ok: true,
      token,
      noteKey: 'webhookTokenShownOnce',
    });
  });

  /**
   * Przeliczenie historii portfela wstecz z transakcji.
   *
   * Idzie synchronicznie - dla typowego portfela to ulamek sekundy, bo notowania
   * i kursy leza w cache wspolnym dla calej instancji. Pierwszy przebieg po dodaniu
   * nowego tickera pobiera jego historie i trwa kilka sekund.
   */
  router.post('/portfolios/:portfolioId/history/rebuild', async (ctx) => {
    const row = requirePortfolio(ctx.userId, ctx.params.portfolioId);
    const result = await rebuildPortfolioHistory(row.id);
    audit({ userId: ctx.userId, portfolioId: row.id, action: 'history.rebuilt', ip: ctx.ip, detail: result });
    invalidateSnapshots(ctx.userId);
    sendJson(ctx.res, 200, { ok: true, result });
  });

  /** Pelny eksport portfela - format nadaje sie do backupu i do importu w innej instancji. */
  router.get('/portfolios/:portfolioId/export', (ctx) => {
    const row = requirePortfolio(ctx.userId, ctx.params.portfolioId);
    sendJson(ctx.res, 200, {
      ok: true,
      format: 'master-portfolio-dashboard/v2',
      exportedAt: new Date().toISOString(),
      portfolio: publicPortfolio(row),
      transactions: listTransactions([row.id]),
      cashFlows: listCashFlows([row.id]),
      baseline: listBaseline([row.id]),
      notes: listNotes([row.id]),
      history: listHistory([row.id]),
    }, { 'content-disposition': `attachment; filename="portfolio-${row.slug}-${new Date().toISOString().slice(0, 10)}.json"` });
  });

  /** Import do ISTNIEJACEGO portfela. Cala operacja jest jedna transakcja - albo wchodzi calosc, albo nic. */
  router.post('/portfolios/:portfolioId/import', async (ctx) => {
    const row = requirePortfolio(ctx.userId, ctx.params.portfolioId);
    const body = await readJsonBody(ctx.req, 8 * 1024 * 1024);
    if (!Array.isArray(body.transactions) && !Array.isArray(body.cashFlows)) {
      throw badRequest('empty_import');
    }
    const result = dbTx(() => {
      let transactions = 0;
      let cashFlows = 0;
      let baseline = 0;
      let notes = 0;
      for (const item of body.transactions ?? []) {
        insertTransaction(row.id, {
          ...item,
          date: item.date ?? item.trade_date,
          externalId: null,
          source: 'import',
        }, { userId: ctx.userId, ip: ctx.ip });
        transactions += 1;
      }
      for (const item of body.cashFlows ?? []) {
        insertCashFlow(row.id, {
          ...item,
          date: item.date ?? item.flow_date,
          externalId: null,
          source: 'import',
        }, { userId: ctx.userId, ip: ctx.ip });
        cashFlows += 1;
      }
      for (const item of body.baseline ?? []) { upsertBaseline(row.id, item); baseline += 1; }
      for (const [symbol, note] of Object.entries(body.notes ?? {})) {
        if (typeof note !== 'object') continue;
        saveNote(row.id, { symbol, ...note });
        notes += 1;
      }
      return { transactions, cashFlows, baseline, notes };
    });
    audit({ userId: ctx.userId, portfolioId: row.id, action: 'portfolio.imported', ip: ctx.ip, detail: result });
    invalidateSnapshots(ctx.userId);
    sendJson(ctx.res, 201, { ok: true, imported: result });
  });
}
