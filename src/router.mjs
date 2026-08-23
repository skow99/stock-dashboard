// src/router.mjs - tablica tras, dopasowanie sciezek i wspolny kontekst zadania.
import { unauthorized, notFound, forbidden, HttpError } from './http.mjs';
import { loadSession, assertCsrf } from './auth.mjs';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Kompilacja wzorca '/portfolios/:id/transactions/:txId' do regexpu z nazwanymi grupami. */
function compile(pattern) {
  const names = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(segment.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { re: new RegExp(`^${source}$`), names };
}

export function createRouter() {
  const routes = [];

  const add = (method, pattern, handler, options = {}) => {
    const { re, names } = compile(pattern);
    routes.push({ method, pattern, re, names, handler, auth: options.auth ?? 'session', csrf: options.csrf ?? true });
  };

  return {
    get: (p, h, o) => add('GET', p, h, o),
    post: (p, h, o) => add('POST', p, h, o),
    put: (p, h, o) => add('PUT', p, h, o),
    patch: (p, h, o) => add('PATCH', p, h, o),
    delete: (p, h, o) => add('DELETE', p, h, o),
    routes,

    match(method, pathname) {
      let pathExists = false;
      for (const route of routes) {
        const match = route.re.exec(pathname);
        if (!match) continue;
        pathExists = true;
        if (route.method !== method) continue;
        const params = {};
        route.names.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]); });
        return { route, params };
      }
      if (pathExists) throw new HttpError(405, 'method_not_allowed');
      throw notFound('endpoint_not_found');
    },
  };
}

/**
 * Buduje kontekst zadania i egzekwuje polityke uwierzytelnienia trasy.
 * auth: 'session' (domyslnie) | 'public' | 'admin'
 */
export function buildContext({ req, res, url, params, route, sessionToken, ip, locale }) {
  const ctx = {
    req, res, url, params, ip, locale,
    query: url.searchParams,
    user: null,
    session: null,
    sessionToken,
  };

  if (route.auth === 'public') return ctx;

  const loaded = loadSession(sessionToken);
  if (!loaded) throw unauthorized();
  ctx.user = loaded.user;
  ctx.session = loaded.session;
  ctx.userId = loaded.user.id;

  if (route.auth === 'admin' && !['owner', 'admin'].includes(loaded.user.role)) {
    throw forbidden('admin_required');
  }
  if (route.csrf && MUTATING.has(req.method)) assertCsrf(req, loaded.session);
  return ctx;
}
