// src/routes/ledger.mjs - transakcje, przeplywy gotowki, notatki pozycji (zawsze w kontekscie portfela).
import { readJsonBody, sendJson } from '../http.mjs';
import { requirePortfolio } from '../portfolios.mjs';
import {
  listTransactions, insertTransaction, updateTransaction, deleteTransaction,
  listCashFlows, insertCashFlow, updateCashFlow, deleteCashFlow,
  saveNote, listNotes, upsertBaseline, listBaseline,
} from '../ledger.mjs';
import { invalidateSnapshots } from '../snapshot.mjs';
import { rebuildPortfolioHistory } from '../history-rebuild.mjs';
import { log } from '../log.mjs';

export function registerLedgerRoutes(router) {
  const scope = (ctx) => {
    const row = requirePortfolio(ctx.userId, ctx.params.portfolioId);
    return { row, meta: { userId: ctx.userId, ip: ctx.ip } };
  };

  /**
   * Historia wartosci wynika z ksiegi, wiec kazda zmiana w ksiedze musi ja odswiezyc.
   *
   * Bez tego poprawienie omylkowej daty (np. 2003 zamiast 2026) zostawialo na wykresie
   * dwadziescia lat pustych dni - transakcja byla juz poprawna, a wykres nie.
   *
   * Nieudane przeliczenie NIE moze cofnac zapisu: zmiana jest w bazie i jest poprawna,
   * a historie da sie odbudowac przyciskiem albo z konsoli.
   */
  const odswiezHistorie = async (ctx, portfolioId) => {
    try {
      await rebuildPortfolioHistory(portfolioId);
      invalidateSnapshots(ctx.userId);
    } catch (err) {
      log.warn('ledger.history_rebuild_failed', { portfolioId, error: err.message });
    }
  };

  // ---------------------------------------------------------------- transakcje
  router.get('/portfolios/:portfolioId/transactions', (ctx) => {
    const { row } = scope(ctx);
    sendJson(ctx.res, 200, { ok: true, transactions: listTransactions([row.id]) });
  });

  router.post('/portfolios/:portfolioId/transactions', async (ctx) => {
    const { row, meta } = scope(ctx);
    const body = await readJsonBody(ctx.req);
    const created = insertTransaction(row.id, body, meta);
    invalidateSnapshots(ctx.userId);
    await odswiezHistorie(ctx, row.id);
    sendJson(ctx.res, 201, { ok: true, transaction: created });
  });

  router.put('/portfolios/:portfolioId/transactions/:id', async (ctx) => {
    const { row, meta } = scope(ctx);
    const body = await readJsonBody(ctx.req);
    const updated = updateTransaction(row.id, ctx.params.id, body, meta);
    invalidateSnapshots(ctx.userId);
    await odswiezHistorie(ctx, row.id);
    sendJson(ctx.res, 200, { ok: true, transaction: updated });
  });

  router.delete('/portfolios/:portfolioId/transactions/:id', async (ctx) => {
    const { row, meta } = scope(ctx);
    const removed = deleteTransaction(row.id, ctx.params.id, meta);
    invalidateSnapshots(ctx.userId);
    await odswiezHistorie(ctx, row.id);
    sendJson(ctx.res, 200, { ok: true, removed });
  });

  // ---------------------------------------------------------------- przeplywy gotowki
  router.get('/portfolios/:portfolioId/cash-flows', (ctx) => {
    const { row } = scope(ctx);
    sendJson(ctx.res, 200, { ok: true, cashFlows: listCashFlows([row.id]) });
  });

  router.post('/portfolios/:portfolioId/cash-flows', async (ctx) => {
    const { row, meta } = scope(ctx);
    const body = await readJsonBody(ctx.req);
    const created = insertCashFlow(row.id, body, meta);
    invalidateSnapshots(ctx.userId);
    await odswiezHistorie(ctx, row.id);
    sendJson(ctx.res, 201, { ok: true, cashFlow: created });
  });

  // Edycja i usuwanie depozytow - luka funkcjonalna v1, domkinieta w v2.
  router.put('/portfolios/:portfolioId/cash-flows/:id', async (ctx) => {
    const { row, meta } = scope(ctx);
    const body = await readJsonBody(ctx.req);
    const updated = updateCashFlow(row.id, ctx.params.id, body, meta);
    invalidateSnapshots(ctx.userId);
    await odswiezHistorie(ctx, row.id);
    sendJson(ctx.res, 200, { ok: true, cashFlow: updated });
  });

  router.delete('/portfolios/:portfolioId/cash-flows/:id', async (ctx) => {
    const { row, meta } = scope(ctx);
    const removed = deleteCashFlow(row.id, ctx.params.id, meta);
    invalidateSnapshots(ctx.userId);
    await odswiezHistorie(ctx, row.id);
    sendJson(ctx.res, 200, { ok: true, removed });
  });

  // ---------------------------------------------------------------- notatki i baseline
  router.get('/portfolios/:portfolioId/notes', (ctx) => {
    const { row } = scope(ctx);
    sendJson(ctx.res, 200, { ok: true, notes: listNotes([row.id]) });
  });

  router.put('/portfolios/:portfolioId/notes', async (ctx) => {
    const { row, meta } = scope(ctx);
    const body = await readJsonBody(ctx.req);
    const saved = saveNote(row.id, body, meta);
    invalidateSnapshots(ctx.userId);
    sendJson(ctx.res, 200, { ok: true, note: saved });
  });

  router.get('/portfolios/:portfolioId/baseline', (ctx) => {
    const { row } = scope(ctx);
    sendJson(ctx.res, 200, { ok: true, baseline: listBaseline([row.id]) });
  });

  router.put('/portfolios/:portfolioId/baseline', async (ctx) => {
    const { row } = scope(ctx);
    const body = await readJsonBody(ctx.req);
    const items = Array.isArray(body.baseline) ? body.baseline : [body];
    for (const item of items) upsertBaseline(row.id, item);
    invalidateSnapshots(ctx.userId);
    sendJson(ctx.res, 200, { ok: true, count: items.length });
  });
}
