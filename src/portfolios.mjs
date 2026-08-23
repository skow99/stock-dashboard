// src/portfolios.mjs - encja portfela + kontrola dostepu.
// Regula bezpieczenstwa: KAZDY odczyt i zapis danych portfela przechodzi przez requirePortfolio().
import crypto from 'node:crypto';
import { getDb, newId, nowIso, sha256, audit } from './db.mjs';
import { badRequest, notFound, conflict, forbidden } from './http.mjs';
import { CURRENCIES } from './market/tickers.mjs';
import { defaults } from './i18n.mjs';

export const PORTFOLIO_KINDS = ['brokerage', 'ike', 'ikze', 'pension', 'crypto', 'other'];

function slugify(name) {
  return String(name)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 40) || 'portfel';
}

function uniqueSlug(userId, base) {
  const db = getDb();
  let slug = base;
  let i = 2;
  while (db.prepare('SELECT 1 FROM portfolios WHERE user_id = ? AND slug = ?').get(userId, slug)) {
    slug = `${base}-${i}`;
    i += 1;
  }
  return slug;
}

export function listPortfolios(userId, { includeArchived = false } = {}) {
  const sql = includeArchived
    ? 'SELECT * FROM portfolios WHERE user_id = ? ORDER BY archived, position, created_at'
    : 'SELECT * FROM portfolios WHERE user_id = ? AND archived = 0 ORDER BY position, created_at';
  return getDb().prepare(sql).all(userId).map(publicPortfolio);
}

export function getPortfolioRow(portfolioId) {
  return getDb().prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolioId);
}

/**
 * Zwraca portfel tylko jesli nalezy do wskazanego uzytkownika.
 * Brak wlasnosci = 404 (nie 403), zeby nie zdradzac istnienia cudzych identyfikatorow.
 */
export function requirePortfolio(userId, portfolioId) {
  const row = getPortfolioRow(portfolioId);
  if (!row || row.user_id !== userId) throw notFound('portfolio_not_found');
  return row;
}

export function createPortfolio(userId, input = {}) {
  const name = String(input.name ?? '').trim();
  if (!name) throw badRequest('invalid_name', { max: 60 });
  if (name.length > 60) throw badRequest('invalid_name', { max: 60 });

  const baseCurrency = String(input.baseCurrency ?? 'PLN').toUpperCase();
  if (!CURRENCIES.includes(baseCurrency)) throw badRequest('invalid_currency', { list: CURRENCIES.join(', ') });
  const kind = String(input.kind ?? 'brokerage');
  if (!PORTFOLIO_KINDS.includes(kind)) throw badRequest('invalid_kind', { list: PORTFOLIO_KINDS.join(', ') });
  const color = /^#[0-9a-fA-F]{6}$/.test(String(input.color ?? '')) ? input.color : '#4fc3f7';

  const count = getDb().prepare('SELECT COUNT(*) AS n FROM portfolios WHERE user_id = ?').get(userId).n;
  if (count >= 50) throw conflict('too_many_portfolios', { max: 50 });

  const at = nowIso();
  const id = newId('pf_');
  getDb().prepare(`
    INSERT INTO portfolios (id, user_id, name, slug, base_currency, broker, kind, color, tax_rate, position, archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    id, userId, name, uniqueSlug(userId, slugify(name)), baseCurrency,
    String(input.broker ?? '').slice(0, 40), kind, color,
    Number.isFinite(Number(input.taxRate)) ? Number(input.taxRate) : 0.19,
    count, at, at,
  );
  audit({ userId, portfolioId: id, action: 'portfolio.created', entity: 'portfolio', entityId: id, detail: { name } });
  return publicPortfolio(getPortfolioRow(id));
}

export function updatePortfolio(userId, portfolioId, input = {}) {
  const row = requirePortfolio(userId, portfolioId);
  const next = {
    name: input.name !== undefined ? String(input.name).trim() : row.name,
    base_currency: input.baseCurrency !== undefined ? String(input.baseCurrency).toUpperCase() : row.base_currency,
    broker: input.broker !== undefined ? String(input.broker).slice(0, 40) : row.broker,
    kind: input.kind !== undefined ? String(input.kind) : row.kind,
    color: input.color !== undefined ? String(input.color) : row.color,
    tax_rate: input.taxRate !== undefined ? Number(input.taxRate) : row.tax_rate,
    position: input.position !== undefined ? Number(input.position) : row.position,
    archived: input.archived !== undefined ? (input.archived ? 1 : 0) : row.archived,
  };
  if (!next.name) throw badRequest('invalid_name', { max: 60 });
  if (!CURRENCIES.includes(next.base_currency)) throw badRequest('invalid_currency', { list: CURRENCIES.join(', ') });
  if (!PORTFOLIO_KINDS.includes(next.kind)) throw badRequest('invalid_kind', { list: PORTFOLIO_KINDS.join(', ') });
  if (!/^#[0-9a-fA-F]{6}$/.test(next.color)) next.color = row.color;
  if (!Number.isFinite(next.tax_rate) || next.tax_rate < 0 || next.tax_rate > 1) next.tax_rate = row.tax_rate;

  getDb().prepare(`
    UPDATE portfolios SET name = ?, base_currency = ?, broker = ?, kind = ?, color = ?, tax_rate = ?, position = ?, archived = ?, updated_at = ?
    WHERE id = ?
  `).run(next.name, next.base_currency, next.broker, next.kind, next.color, next.tax_rate, next.position, next.archived, nowIso(), portfolioId);
  audit({ userId, portfolioId, action: 'portfolio.updated', entity: 'portfolio', entityId: portfolioId });
  return publicPortfolio(getPortfolioRow(portfolioId));
}

/** Usuniecie portfela kasuje kaskadowo caly jego ledger - wymaga potwierdzenia nazwa. */
export function deletePortfolio(userId, portfolioId, confirmName) {
  const row = requirePortfolio(userId, portfolioId);
  if (String(confirmName ?? '').trim() !== row.name) {
    throw badRequest('confirmation_required');
  }
  const stats = countPortfolioData(portfolioId);
  getDb().prepare('DELETE FROM portfolios WHERE id = ?').run(portfolioId);
  audit({ userId, portfolioId, action: 'portfolio.deleted', entity: 'portfolio', entityId: portfolioId, detail: stats });
  return stats;
}

export function countPortfolioData(portfolioId) {
  const db = getDb();
  return {
    transactions: db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE portfolio_id = ?').get(portfolioId).n,
    cashFlows: db.prepare('SELECT COUNT(*) AS n FROM cash_flows WHERE portfolio_id = ?').get(portfolioId).n,
    historyPoints: db.prepare('SELECT COUNT(*) AS n FROM portfolio_history WHERE portfolio_id = ?').get(portfolioId).n,
  };
}

export function reorderPortfolios(userId, orderedIds) {
  if (!Array.isArray(orderedIds)) throw badRequest('invalid_order');
  const db = getDb();
  orderedIds.forEach((id, index) => {
    db.prepare('UPDATE portfolios SET position = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(index, nowIso(), id, userId);
  });
  return listPortfolios(userId, { includeArchived: true });
}

/** Token webhooka jest per portfel - kompromitacja jednego nie odslania pozostalych. */
export function rotateWebhookToken(userId, portfolioId) {
  requirePortfolio(userId, portfolioId);
  const token = crypto.randomBytes(24).toString('base64url');
  getDb().prepare('UPDATE portfolios SET webhook_token = ?, updated_at = ? WHERE id = ?')
    .run(sha256(token), nowIso(), portfolioId);
  audit({ userId, portfolioId, action: 'portfolio.webhook_rotated', entity: 'portfolio', entityId: portfolioId });
  return token; // pokazywany dokladnie raz
}

export function findPortfolioByWebhookToken(token) {
  if (!token) return null;
  return getDb().prepare('SELECT * FROM portfolios WHERE webhook_token = ?').get(sha256(token)) ?? null;
}

/** Domyslny portfel dla nowego konta - uzytkownik nigdy nie widzi pustego ekranu. */
export function ensureDefaultPortfolio(userId, locale = 'pl') {
  const existing = getDb().prepare('SELECT COUNT(*) AS n FROM portfolios WHERE user_id = ?').get(userId).n;
  if (existing > 0) return null;
  return createPortfolio(userId, {
    name: defaults(locale).defaultPortfolioName,
    baseCurrency: 'PLN',
    kind: 'brokerage',
  });
}

export function publicPortfolio(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    baseCurrency: row.base_currency,
    broker: row.broker,
    kind: row.kind,
    color: row.color,
    taxRate: row.tax_rate,
    position: row.position,
    archived: Boolean(row.archived),
    hasWebhook: Boolean(row.webhook_token),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Rozwiazuje parametr ?portfolio= : konkretny id, 'all' albo domyslny pierwszy portfel. */
export function resolveScope(userId, requested) {
  const portfolios = listPortfolios(userId);
  if (!portfolios.length) return { mode: 'empty', portfolios, ids: [] };
  if (!requested || requested === 'all') {
    return {
      mode: requested === 'all' ? 'all' : 'single',
      portfolios,
      ids: requested === 'all' ? portfolios.map((p) => p.id) : [portfolios[0].id],
      active: requested === 'all' ? null : portfolios[0],
    };
  }
  const match = portfolios.find((p) => p.id === requested || p.slug === requested);
  if (!match) throw notFound('portfolio_not_found');
  return { mode: 'single', portfolios, ids: [match.id], active: match };
}

export function assertOwner(user) {
  if (!['owner', 'admin'].includes(user.role)) throw forbidden('admin_required');
}
