#!/usr/bin/env node
// server.mjs - Master Portfolio Dashboard v2. Jeden proces Node, zero zaleznosci npm.
import http from 'node:http';
import crypto from 'node:crypto';
import process from 'node:process';

import config from './src/config.mjs';
import { log } from './src/log.mjs';
import { getDb } from './src/db.mjs';
import {
  sendError, sendJson, serveStatic, streamFile, securityHeaders,
  parseCookies, clientIp, notFound, HttpError,
} from './src/http.mjs';
import { createRouter, buildContext } from './src/router.mjs';
import { negotiateLocale } from './src/i18n.mjs';
import { bootstrapFromEnv, sweepSessions } from './src/auth.mjs';
import { registerAuthRoutes } from './src/routes/auth.mjs';
import { registerPortfolioRoutes } from './src/routes/portfolios.mjs';
import { registerLedgerRoutes } from './src/routes/ledger.mjs';
import { registerDashboardRoutes } from './src/routes/dashboard.mjs';
import { registerShareRoutes } from './src/routes/share.mjs';
import { registerWebhookRoutes } from './src/routes/webhook.mjs';
import { registerAdminRoutes } from './src/routes/admin.mjs';
import { registerImportRoutes } from './src/routes/import.mjs';
import { flushQuoteCache } from './src/market/quotes.mjs';
import { flushHistoryCache } from './src/market/history.mjs';

const BASE = config.basePath;          // np. /stock-dashboard
const API_PREFIX = `${BASE}/api/v1`;

// ---------------------------------------------------------------- start bazy
getDb();
bootstrapFromEnv();

// ---------------------------------------------------------------- trasy
const router = createRouter();
registerAuthRoutes(router);
registerPortfolioRoutes(router);
registerLedgerRoutes(router);
registerDashboardRoutes(router);
registerShareRoutes(router, { basePath: BASE });
registerWebhookRoutes(router);
registerAdminRoutes(router, { basePath: BASE });
registerImportRoutes(router);

// ---------------------------------------------------------------- statyki
// Whitelist zamiast otwartego katalogu: serwer nie wyda niczego, czego nie wymieniono jawnie.
const STATIC_PAGES = new Set([
  '', 'index.html', 'login.html', 'share.html',
  'app.js', 'auth.js', 'share.js', 'ui.js', 'charts.js', 'i18n.js', 'import.js',
  'styles.css', 'favicon.svg',
]);

async function handleStatic(req, res, pathname) {
  let rel = pathname.slice(BASE.length).replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  if (!STATIC_PAGES.has(rel)) throw notFound('resource_not_found');
  const served = await serveStatic(res, rel, securityHeaders());
  streamFile(req, res, served);
}

// ---------------------------------------------------------------- serwer
const server = http.createServer(async (req, res) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  const startedAt = process.hrtime.bigint();
  res.setHeader('x-request-id', requestId);
  for (const [key, value] of Object.entries(securityHeaders())) res.setHeader(key, value);

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  const pathname = url.pathname.replace(/\/{2,}/g, '/');
  const ip = clientIp(req);
  // Jezyk odpowiedzi: jawny ?lang= wygrywa z naglowkiem Accept-Language.
  const locale = negotiateLocale(req.headers['accept-language'], url.searchParams.get('lang'));
  res.setHeader('content-language', locale);

  const finish = (status) => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    log.info('http.request', {
      requestId, method: req.method, path: pathname, status, ms: Math.round(ms), ip,
    });
  };
  res.on('finish', () => finish(res.statusCode));

  try {
    // Przekierowania na kanoniczna sciezke bazowa
    if (pathname === '/' || pathname === BASE) {
      res.writeHead(302, { location: `${BASE}/` });
      res.end();
      return;
    }

    // Zgodnosc wsteczna z v1: /api/portfolio -> /api/v1/dashboard
    if (pathname === `${BASE}/api/portfolio`) {
      res.writeHead(301, { location: `${API_PREFIX}/dashboard${url.search}` });
      res.end();
      return;
    }
    if (pathname.startsWith(`${BASE}/api/`) && !pathname.startsWith(`${API_PREFIX}/`)) {
      throw new HttpError(410, 'api_version_removed', { path: `${API_PREFIX}/…` });
    }

    // API
    if (pathname.startsWith(`${API_PREFIX}/`)) {
      const apiPath = pathname.slice(API_PREFIX.length);
      const { route, params } = router.match(req.method, apiPath);
      const cookies = parseCookies(req.headers.cookie);
      const ctx = buildContext({
        req, res, url, params, route, ip, locale,
        sessionToken: cookies[config.cookieName],
      });
      await route.handler(ctx);
      return;
    }

    // Frontend
    if (pathname === BASE || pathname.startsWith(`${BASE}/`)) {
      await handleStatic(req, res, pathname);
      return;
    }

    throw notFound('resource_not_found');
  } catch (err) {
    if (!(err instanceof HttpError)) {
      log.error('http.unhandled', { requestId, path: pathname, error: err.message, stack: err.stack });
    }
    if (res.headersSent) { res.end(); return; }
    sendError(res, err, requestId, locale);
  }
});

server.headersTimeout = 20_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 10_000;

server.listen(config.port, config.host, () => {
  log.info('server.started', {
    version: config.version,
    url: `http://${config.host}:${config.port}${BASE}/`,
    api: `${API_PREFIX}`,
    env: config.env,
    offline: config.offlineMarketData,
  });
});

// ---------------------------------------------------------------- zadania w tle
const sweeper = setInterval(() => {
  sweepSessions();
  flushQuoteCache();
  flushHistoryCache();
}, 10 * 60 * 1000);
sweeper.unref();

// ---------------------------------------------------------------- zamkniecie
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('server.shutdown', { signal });
  clearInterval(sweeper);
  flushQuoteCache();
  flushHistoryCache();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => log.error('process.unhandled_rejection', { reason: String(reason) }));
process.on('uncaughtException', (err) => {
  log.error('process.uncaught_exception', { error: err.message, stack: err.stack });
  shutdown('uncaughtException');
});

export { server, router };
void sendJson;
