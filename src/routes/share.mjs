// src/routes/share.mjs - publiczne linki tylko do odczytu.
//
// Model: wlasciciel generuje token; token daje dostep do JEDNEGO portfela albo do widoku
// skonsolidowanego, w trybie 'summary' (bez ledgeru) albo 'full' (z transakcjami).
// Token nigdy nie daje prawa zapisu i nie zwraca danych konta.
import crypto from 'node:crypto';
import { getDb, newId, nowIso, sha256, audit } from '../db.mjs';
import { readJsonBody, sendJson, badRequest, notFound, createRateLimiter, tooMany } from '../http.mjs';
import { requirePortfolio, listPortfolios, publicPortfolio } from '../portfolios.mjs';
import { buildSnapshot } from '../snapshot.mjs';

const shareLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 30 });

function publicShare(row, portfolioName) {
  return {
    id: row.id.slice(0, 12),
    label: row.label,
    scope: row.scope,
    portfolioId: row.portfolio_id,
    portfolioName: portfolioName ?? (row.portfolio_id ? null : 'Wszystkie portfele'),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastAccessAt: row.last_access_at,
    accessCount: row.access_count,
    active: !row.revoked_at && (!row.expires_at || new Date(row.expires_at).getTime() > Date.now()),
  };
}

export function registerShareRoutes(router, { basePath }) {
  router.get('/share-links', (ctx) => {
    const rows = getDb().prepare('SELECT * FROM share_links WHERE user_id = ? ORDER BY created_at DESC').all(ctx.userId);
    const names = new Map(listPortfolios(ctx.userId, { includeArchived: true }).map((p) => [p.id, p.name]));
    sendJson(ctx.res, 200, { ok: true, links: rows.map((row) => publicShare(row, names.get(row.portfolio_id))) });
  });

  router.post('/share-links', async (ctx) => {
    const body = await readJsonBody(ctx.req);
    const scope = ['summary', 'full'].includes(body.scope) ? body.scope : 'summary';
    let portfolioId = null;
    if (body.portfolioId && body.portfolioId !== 'all') {
      portfolioId = requirePortfolio(ctx.userId, body.portfolioId).id;
    }
    const ttlDays = Number.isFinite(Number(body.expiresInDays)) ? Math.min(365, Math.max(1, Number(body.expiresInDays))) : 30;
    const token = crypto.randomBytes(24).toString('base64url');

    getDb().prepare(`
      INSERT INTO share_links (id, user_id, portfolio_id, label, scope, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      sha256(token), ctx.userId, portfolioId,
      String(body.label ?? '').slice(0, 60), scope, nowIso(),
      new Date(Date.now() + ttlDays * 86400_000).toISOString(),
    );
    audit({ userId: ctx.userId, portfolioId, action: 'share.created', ip: ctx.ip, detail: { scope, ttlDays } });
    sendJson(ctx.res, 201, {
      ok: true,
      token,
      url: `${basePath}/share.html#${token}`,
      apiUrl: `${basePath}/api/v1/share/${token}`,
      expiresInDays: ttlDays,
      noteKey: 'shareLinkIsPublic',
    });
  });

  router.delete('/share-links/:id', (ctx) => {
    const rows = getDb().prepare('SELECT id FROM share_links WHERE user_id = ?').all(ctx.userId);
    const match = rows.find((row) => row.id.startsWith(ctx.params.id));
    if (!match) throw notFound('share_not_found');
    getDb().prepare('UPDATE share_links SET revoked_at = ? WHERE id = ?').run(nowIso(), match.id);
    audit({ userId: ctx.userId, action: 'share.revoked', ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true });
  });

  /** Publiczny odczyt. Token w sciezce, brak ciasteczek, brak CSRF, wlasny rate limit. */
  router.get('/share/:token', async (ctx) => {
    const limit = shareLimiter.check(`share:${ctx.ip}`);
    if (!limit.allowed) throw tooMany(limit.retryAfterMs);

    const token = String(ctx.params.token);
    if (token.length < 20 || token.length > 100) throw badRequest('invalid_token');
    const row = getDb().prepare('SELECT * FROM share_links WHERE id = ?').get(sha256(token));
    if (!row || row.revoked_at) throw notFound('share_expired');
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      throw notFound('share_expired');
    }

    const portfolios = row.portfolio_id
      ? [publicPortfolio(getDb().prepare('SELECT * FROM portfolios WHERE id = ?').get(row.portfolio_id))].filter(Boolean)
      : listPortfolios(row.user_id);
    if (!portfolios.length) throw notFound('portfolio_not_found');

    const snapshot = await buildSnapshot({
      userId: row.user_id,
      portfolios,
      mode: row.portfolio_id ? 'single' : 'all',
    });

    getDb().prepare('UPDATE share_links SET last_access_at = ?, access_count = access_count + 1 WHERE id = ?')
      .run(nowIso(), row.id);

    // Widok 'summary' celowo NIE zawiera ledgeru ani notatek.
    const shared = {
      ok: true,
      readOnly: true,
      scope: row.scope,
      label: row.label,
      asOf: snapshot.asOf,
      totals: snapshot.totals,
      performance: snapshot.performance,
      history: snapshot.history,
      twrIndex: snapshot.twrIndex,
      sectors: snapshot.sectors,
      portfolios: snapshot.portfolios.map((p) => ({
        id: p.id, name: p.name, color: p.color, totalPln: p.totalPln, weightPct: p.weightPct,
      })),
      positions: snapshot.positions.map((p) => ({
        symbol: p.symbol, name: p.name, qty: p.qty, price: p.price, currency: p.currency,
        valuePln: p.valuePln, pnlPln: p.pnlPln, pnlPct: p.pnlPct, dayPct: p.dayPct,
        weight: p.weight, sector: p.sector,
      })),
    };
    if (row.scope === 'full') {
      shared.transactions = snapshot.transactions.map((t) => ({
        date: t.trade_date, ticker: t.ticker, name: t.name, side: t.side,
        qty: t.qty, price: t.price, currency: t.currency,
        realizedPnlPln: t.realizedPnlPln ?? null,
      }));
      shared.closedPositions = snapshot.closedPositions;
    }
    sendJson(ctx.res, 200, shared);
  }, { auth: 'public', csrf: false });

  void newId;
}
