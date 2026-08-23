// src/routes/import.mjs - import z pliku: podglad, zapis, historia wsadow, cofanie.
//
// Podglad i zapis przyjmuja DOKLADNIE to samo cialo zadania i licza plan ta sama
// funkcja. Serwer nie trzyma nic miedzy jednym a drugim - nie ma stanu sesji importu,
// ktory moglby wygasnac, rozjechac sie albo zajac pamiec.

import { readJsonBody, sendJson, sendText, badRequest } from '../http.mjs';
import { requirePortfolio } from '../portfolios.mjs';
import { invalidateSnapshots } from '../snapshot.mjs';
import { buildPlan, toPreview, commitPlan, listBatches, undoBatch, MAX_ROWS } from '../import/engine.mjs';
import { SHAPES } from '../import/schema.mjs';
import { csvTemplate } from '../import/template.mjs';
import { rebuildPortfolioHistory } from '../history-rebuild.mjs';
import { log } from '../log.mjs';

/** Plik na 5000 wierszy w base64 miesci sie w 4 MB z zapasem. */
const IMPORT_BODY_LIMIT = 4 * 1024 * 1024;

/** Wspolne wejscie dla podgladu i zapisu. */
function planFromBody(body, portfolioId) {
  let bytes = null;
  if (typeof body.contentBase64 === 'string' && body.contentBase64) {
    // Plik z dysku przychodzi jako surowe bajty - inaczej przegladarka zdazylaby
    // zepsuc polskie znaki, zanim serwer rozpozna kodowanie Windows-1250.
    bytes = Buffer.from(body.contentBase64, 'base64');
    if (!bytes.length) throw badRequest('import_empty_file');
  } else if (typeof body.content !== 'string' || !body.content.trim()) {
    throw badRequest('import_empty_file');
  }

  return buildPlan({
    text: body.content,
    bytes,
    portfolioId,
    shape: body.shape ?? null,
    mapping: body.mapping ?? null,
    delimiter: typeof body.delimiter === 'string' && body.delimiter ? body.delimiter : null,
    includeDuplicates: body.includeDuplicates === true,
  });
}

export function registerImportRoutes(router) {
  /** Podglad. Nie dotyka bazy poza odczytem duplikatow. */
  router.post('/portfolios/:portfolioId/import/analyze', async (ctx) => {
    const row = requirePortfolio(ctx.userId, ctx.params.portfolioId);
    const body = await readJsonBody(ctx.req, IMPORT_BODY_LIMIT);
    const plan = planFromBody(body, row.id);
    sendJson(ctx.res, 200, { ok: true, preview: toPreview(plan), limits: { maxRows: MAX_ROWS } });
  });

  /** Zapis. Cale albo nic. */
  router.post('/portfolios/:portfolioId/import/commit', async (ctx) => {
    const row = requirePortfolio(ctx.userId, ctx.params.portfolioId);
    const body = await readJsonBody(ctx.req, IMPORT_BODY_LIMIT);
    const plan = planFromBody(body, row.id);
    const result = commitPlan(row.id, plan, {
      userId: ctx.userId, ip: ctx.ip, filename: body.filename ?? '',
    });
    invalidateSnapshots(ctx.userId);

    // Transakcje z przeszlosci nie maja odpowiednika w historii portfela - bez tego
    // wykres zaczynalby sie dopiero w dniu pierwszej migawki EOD. Nieudane odtworzenie
    // NIE moze uniewaznic zapisanego importu: dane sa juz w bazie i sa poprawne.
    let history = null;
    if (plan.shape !== 'holdings') {
      try {
        history = await rebuildPortfolioHistory(row.id);
        invalidateSnapshots(ctx.userId);
      } catch (err) {
        log.warn('import.history_rebuild_failed', { portfolioId: row.id, error: err.message });
      }
    }

    sendJson(ctx.res, 201, { ok: true, result, history });
  });

  router.get('/portfolios/:portfolioId/import/batches', (ctx) => {
    const row = requirePortfolio(ctx.userId, ctx.params.portfolioId);
    sendJson(ctx.res, 200, { ok: true, batches: listBatches(row.id) });
  });

  router.delete('/portfolios/:portfolioId/import/batches/:batchId', (ctx) => {
    const row = requirePortfolio(ctx.userId, ctx.params.portfolioId);
    const result = undoBatch(row.id, ctx.params.batchId, { userId: ctx.userId, ip: ctx.ip });
    invalidateSnapshots(ctx.userId);
    sendJson(ctx.res, 200, { ok: true, result });
  });

  /** Wzorzec pliku do pobrania - naglowki w jezyku interfejsu plus wiersz przykladowy. */
  router.get('/import/template', (ctx) => {
    const kind = ctx.query.get('kind') ?? 'transactions';
    if (!SHAPES[kind]) throw badRequest('import_shape_unknown', { missing: '', closest: '' });
    const csv = csvTemplate(kind, ctx.locale);
    sendText(ctx.res, 200, csv, 'text/csv; charset=utf-8', {
      'content-disposition': `attachment; filename="wzorzec-${kind}.csv"`,
      'cache-control': 'no-store',
    });
  });
}
