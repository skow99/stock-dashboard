// src/routes/webhook.mjs - import wykonanych zlecen od brokera (XTB, IBKR).
//
// Autoryzacja: Bearer token PER PORTFEL. Token globalny z ENV dziala tylko jako fallback
// i wtedy portfel musi byc wskazany jawnie w payloadzie.
import { readJsonBody, sendJson, badRequest, unauthorized, createRateLimiter, tooMany } from '../http.mjs';
import config from '../config.mjs';
import { getDb, nowIso, sha256 } from '../db.mjs';
import { findPortfolioByWebhookToken } from '../portfolios.mjs';
import { insertTransaction, findDuplicateTransaction, validateTransaction } from '../ledger.mjs';
import { canonicalTicker, inferCurrency } from '../market/tickers.mjs';
import { todayWarsaw } from '../dates.mjs';
import { invalidateSnapshots } from '../snapshot.mjs';
import { log } from '../log.mjs';

const webhookLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 60 });

/** "Your order BUY 10 GPW.PL at 50.25" */
export function parseXtb(text) {
  const re = /\b(BUY|SELL)\b[^0-9]{0,20}([0-9]+(?:[.,][0-9]+)?)\s+([A-Z0-9._-]{1,20})\s+(?:at|@|po)\s+([0-9]+(?:[.,][0-9]+)?)/i;
  const match = re.exec(String(text ?? ''));
  if (!match) return null;
  const ticker = canonicalTicker(match[3], { venue: 'WSE' });
  return {
    side: match[1].toUpperCase(),
    qty: Number.parseFloat(match[2].replace(',', '.')),
    ticker,
    price: Number.parseFloat(match[4].replace(',', '.')),
    currency: inferCurrency(ticker, 'PLN'),
  };
}

/** "BOUGHT 35 ETFBM40TR @WSE @ 172.38 (ABC123)" */
export function parseIbkr(text) {
  const re = /\b(BOUGHT|SOLD)\b\s+([0-9]+(?:[.,][0-9]+)?)\s+([A-Z0-9._-]{1,20})\s*(?:@([A-Z]{2,6}))?\s*@\s*([0-9]+(?:[.,][0-9]+)?)(?:\s*\(([A-Za-z0-9-]+)\))?/i;
  const match = re.exec(String(text ?? ''));
  if (!match) return null;
  // Regula IBKR: brak venue == rynek amerykanski (broker pomija venue tylko dla US).
  const venue = match[4] ?? 'US';
  const ticker = canonicalTicker(match[3], { venue });
  return {
    side: match[1].toUpperCase() === 'BOUGHT' ? 'BUY' : 'SELL',
    qty: Number.parseFloat(match[2].replace(',', '.')),
    ticker,
    price: Number.parseFloat(match[5].replace(',', '.')),
    currency: inferCurrency(ticker, venue === 'WSE' ? 'PLN' : 'USD'),
    externalId: match[6] ?? null,
  };
}

const PARSERS = { xtb: parseXtb, ibkr: parseIbkr };

function logWebhook(entry) {
  getDb().prepare(`
    INSERT INTO webhook_log (at, portfolio_id, source, status, message_id, payload, result)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(nowIso(), entry.portfolioId ?? null, entry.source ?? null, entry.status,
    entry.messageId ?? null, JSON.stringify(entry.payload ?? {}).slice(0, 4000),
    JSON.stringify(entry.result ?? {}).slice(0, 2000));
}

function authorize(req, body) {
  const header = String(req.headers.authorization ?? '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw unauthorized('webhook_token_missing');

  const portfolio = findPortfolioByWebhookToken(token);
  if (portfolio) return portfolio;

  // Fallback: globalny token z ENV + jawnie wskazany portfel.
  if (config.webhookToken && sha256(token) === sha256(config.webhookToken)) {
    if (!body.portfolioId) throw badRequest('portfolio_required');
    const row = getDb().prepare('SELECT * FROM portfolios WHERE id = ?').get(body.portfolioId);
    if (!row) throw badRequest('portfolio_required');
    return row;
  }
  throw unauthorized('webhook_token_invalid');
}

export function registerWebhookRoutes(router) {
  router.get('/webhook/:source', (ctx) => {
    const source = String(ctx.params.source).toLowerCase();
    sendJson(ctx.res, 200, {
      ok: true,
      service: `${source}-webhook`,
      online: Boolean(PARSERS[source]),
      authRequired: true,
      perPortfolioToken: true,
      methods: ['GET', 'POST'],
      supported: Object.keys(PARSERS),
    });
  }, { auth: 'public', csrf: false });

  router.post('/webhook/:source', async (ctx) => {
    const limit = webhookLimiter.check(`wh:${ctx.ip}`);
    if (!limit.allowed) throw tooMany(limit.retryAfterMs);

    const source = String(ctx.params.source).toLowerCase();
    const parser = PARSERS[source];
    if (!parser) throw badRequest('unsupported_source', { source, list: Object.keys(PARSERS).join(', ') });

    const body = await readJsonBody(ctx.req);
    const portfolio = authorize(ctx.req, body);

    const text = String(body.text ?? body.message ?? '');
    const parsed = parser(text);
    if (!parsed || !parsed.ticker || !Number.isFinite(parsed.qty) || !Number.isFinite(parsed.price)) {
      logWebhook({ portfolioId: portfolio.id, source, status: 'unparsed', messageId: body.messageId, payload: body });
      throw badRequest('unparsed_message');
    }

    const candidate = {
      date: body.date ?? todayWarsaw(),
      ticker: parsed.ticker,
      name: body.name ?? parsed.ticker.split('.')[0],
      side: parsed.side,
      qty: parsed.qty,
      price: parsed.price,
      currency: body.currency ?? parsed.currency,
      note: `${source.toUpperCase()} webhook`,
      source: `webhook:${source}`,
      externalId: body.messageId ?? parsed.externalId ?? null,
    };

    // Deduplikacja dwustopniowa: po external_id (unikalny indeks) i po polach transakcji.
    const validated = validateTransaction(candidate);
    const duplicate = findDuplicateTransaction(portfolio.id, validated);
    if (duplicate) {
      logWebhook({ portfolioId: portfolio.id, source, status: 'duplicate', messageId: candidate.externalId, payload: body, result: { id: duplicate.id } });
      sendJson(ctx.res, 200, { ok: true, duplicate: true, transactionId: duplicate.id });
      return;
    }

    if (body.dryRun) {
      logWebhook({ portfolioId: portfolio.id, source, status: 'dry-run', messageId: candidate.externalId, payload: body, result: validated });
      sendJson(ctx.res, 200, { ok: true, dryRun: true, parsed: validated, portfolio: { id: portfolio.id, name: portfolio.name } });
      return;
    }

    const created = insertTransaction(portfolio.id, candidate, { userId: portfolio.user_id, ip: ctx.ip });
    invalidateSnapshots(portfolio.user_id);
    logWebhook({ portfolioId: portfolio.id, source, status: 'created', messageId: candidate.externalId, payload: body, result: { id: created.id } });
    log.info('webhook.transaction_created', { source, portfolioId: portfolio.id, ticker: created.ticker });
    sendJson(ctx.res, 201, { ok: true, transaction: created, portfolio: { id: portfolio.id, name: portfolio.name } });
  }, { auth: 'public', csrf: false });
}
