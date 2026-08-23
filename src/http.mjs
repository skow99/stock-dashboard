// src/http.mjs - warstwa transportowa: parsowanie, odpowiedzi, ciasteczka, statyki, bledy.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import config from './config.mjs';
import { errorMessage, DEFAULT_LOCALE } from './i18n.mjs';

/**
 * Blad domenowy. Stabilny jest `code`; tresc komunikatu jest tlumaczona w `sendError`
 * na podstawie katalogu i8n, a `details` sluzy zarowno klientowi, jak i interpolacji {placeholderow}.
 */
export class HttpError extends Error {
  constructor(status, code, details = null, fallbackMessage = null) {
    super(fallbackMessage ?? code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code, details, fallback) => new HttpError(400, code, details, fallback);
export const unauthorized = (code = 'unauthorized', details) => new HttpError(401, code, details);
export const forbidden = (code = 'forbidden', details) => new HttpError(403, code, details);
export const notFound = (code = 'not_found', details) => new HttpError(404, code, details);
export const conflict = (code, details) => new HttpError(409, code, details);
export const tooMany = (retryAfterMs, code = 'rate_limited') => {
  const err = new HttpError(429, code);
  err.retryAfterMs = retryAfterMs;
  return err;
};

export function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/**
 * Odpowiedz bledu w jezyku wynegocjowanym dla zadania.
 * Szczegoly wyjatkow nieoczekiwanych nigdy nie wychodza na zewnatrz - trafiaja wylacznie do logu.
 */
export function sendError(res, err, requestId, locale = DEFAULT_LOCALE) {
  const known = err instanceof HttpError;
  const status = known ? err.status : 500;
  const code = known ? err.code : 'internal_error';
  const details = known ? (err.details ?? undefined) : undefined;
  const message = errorMessage(code, locale, details ?? {})
    ?? (known ? err.message : errorMessage('internal_error', locale));

  const headers = { 'content-language': locale };
  if (err.retryAfterMs) headers['retry-after'] = String(Math.ceil(err.retryAfterMs / 1000));
  sendJson(res, status, { ok: false, error: { code, message, details }, requestId }, headers);
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'content-type': contentType, ...headers });
  res.end(text);
}

export async function readJsonBody(req, limit = config.maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'payload_too_large', { limit });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch {
    throw badRequest('invalid_json');
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? `${config.basePath}/`}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure ?? config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

export function clientIp(req) {
  if (config.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
    const ts = req.headers['tailscale-user-login'];
    if (ts) return String(ts);
  }
  return req.socket?.remoteAddress ?? '';
}

/** Naglowki bezpieczenstwa dla calego serwisu. CSP bez inline-script (frontend jest w plikach). */
export function securityHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'geolocation=(), microphone=(), camera=()',
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ].join('; '),
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

export async function serveStatic(res, relPath, extraHeaders = {}) {
  const safeRel = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(config.publicDir, safeRel);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(config.publicDir) + path.sep)) {
    throw forbidden();
  }
  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    throw notFound();
  }
  if (!stat.isFile()) throw notFound();

  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  const ext = path.extname(resolved).toLowerCase();
  const isHtml = ext === '.html';
  const headers = {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    etag,
    'cache-control': isHtml ? 'no-cache' : 'public, max-age=300, must-revalidate',
    ...extraHeaders,
  };
  return { resolved, stat, headers, etag };
}

export function streamFile(req, res, served) {
  if (req.headers['if-none-match'] === served.etag) {
    res.writeHead(304, served.headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...served.headers, 'content-length': served.stat.size });
  fs.createReadStream(served.resolved).pipe(res);
}

/** Prosty limiter w pamieci: klucz -> okno czasowe. Wystarczajacy dla jednoprocesowej aplikacji. */
export function createRateLimiter({ windowMs, max }) {
  const buckets = new Map();
  return {
    check(key) {
      const now = Date.now();
      const bucket = buckets.get(key);
      if (!bucket || now > bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, remaining: max - 1 };
      }
      bucket.count += 1;
      if (bucket.count > max) return { allowed: false, retryAfterMs: bucket.resetAt - now };
      return { allowed: true, remaining: max - bucket.count };
    },
    reset(key) { buckets.delete(key); },
    sweep() {
      const now = Date.now();
      for (const [key, bucket] of buckets) if (now > bucket.resetAt) buckets.delete(key);
    },
  };
}
