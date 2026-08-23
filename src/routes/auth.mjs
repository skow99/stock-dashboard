// src/routes/auth.mjs - rejestracja, logowanie, sesje, konto.
import config from '../config.mjs';
import { readJsonBody, sendJson, serializeCookie, tooMany, badRequest } from '../http.mjs';
import {
  register, authenticate, createSession, destroySession, destroyAllSessions,
  loadSession, listSessions, changePassword, publicUser, countUsers, csrfTokenFor, loginLimiter,
} from '../auth.mjs';
import { ensureDefaultPortfolio, listPortfolios } from '../portfolios.mjs';
import { audit } from '../db.mjs';
import { invalidateSnapshots } from '../snapshot.mjs';

function setSessionCookie(res, token, expiresAt) {
  res.setHeader('set-cookie', serializeCookie(config.cookieName, token, {
    expires: new Date(expiresAt),
    sameSite: 'Lax',
  }));
}

function clearSessionCookie(res) {
  res.setHeader('set-cookie', serializeCookie(config.cookieName, '', { maxAge: 0 }));
}

export function registerAuthRoutes(router) {
  // Stan instalacji - frontend wie, czy pokazac ekran zalozenia pierwszego konta.
  router.get('/auth/bootstrap', (ctx) => {
    sendJson(ctx.res, 200, {
      ok: true,
      needsBootstrap: countUsers() === 0,
      openRegistration: config.openRegistration,
      inviteRequired: !config.openRegistration && countUsers() > 0,
      version: config.version,
    });
  }, { auth: 'public', csrf: false });

  router.post('/auth/register', async (ctx) => {
    const limit = loginLimiter.check(`register:${ctx.ip}`);
    if (!limit.allowed) throw tooMany(limit.retryAfterMs);

    const body = await readJsonBody(ctx.req);
    const user = register({
      email: body.email,
      password: body.password,
      displayName: body.displayName,
      inviteCode: body.inviteCode,
    });
    ensureDefaultPortfolio(user.id, ctx.locale);
    const session = createSession(user.id, { ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] });
    setSessionCookie(ctx.res, session.token, session.expiresAt);
    audit({ userId: user.id, action: 'auth.registered', ip: ctx.ip });
    sendJson(ctx.res, 201, {
      ok: true,
      user: publicUser(user),
      csrfToken: session.csrfToken,
      portfolios: listPortfolios(user.id),
    });
  }, { auth: 'public', csrf: false });

  router.post('/auth/login', async (ctx) => {
    const limit = loginLimiter.check(`login:${ctx.ip}`);
    if (!limit.allowed) throw tooMany(limit.retryAfterMs);

    const body = await readJsonBody(ctx.req);
    const user = authenticate(body.email, body.password, ctx.ip);
    loginLimiter.reset(`login:${ctx.ip}`);
    ensureDefaultPortfolio(user.id, ctx.locale);
    const session = createSession(user.id, { ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] });
    setSessionCookie(ctx.res, session.token, session.expiresAt);
    sendJson(ctx.res, 200, {
      ok: true,
      user: publicUser(user),
      csrfToken: session.csrfToken,
      portfolios: listPortfolios(user.id),
    });
  }, { auth: 'public', csrf: false });

  // Wylogowanie nie moze zalezec od waznosci sesji - zawsze konczy sie sukcesem i czysci ciasteczko.
  router.post('/auth/logout', (ctx) => {
    const loaded = loadSession(ctx.sessionToken);
    if (loaded) audit({ userId: loaded.user.id, action: 'auth.logout', ip: ctx.ip });
    destroySession(ctx.sessionToken);
    clearSessionCookie(ctx.res);
    sendJson(ctx.res, 200, { ok: true });
  }, { auth: 'public', csrf: false });

  router.get('/auth/me', (ctx) => {
    sendJson(ctx.res, 200, {
      ok: true,
      user: publicUser(ctx.user),
      csrfToken: csrfTokenFor(ctx.session.csrf_secret),
      portfolios: listPortfolios(ctx.userId),
      serverTime: new Date().toISOString(),
    });
  });

  router.get('/account/sessions', (ctx) => {
    sendJson(ctx.res, 200, { ok: true, sessions: listSessions(ctx.userId, ctx.sessionToken) });
  });

  router.delete('/account/sessions', (ctx) => {
    destroyAllSessions(ctx.userId);
    clearSessionCookie(ctx.res);
    audit({ userId: ctx.userId, action: 'auth.logout_all', ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true });
  });

  router.post('/account/password', async (ctx) => {
    const body = await readJsonBody(ctx.req);
    if (!body.currentPassword || !body.newPassword) {
      throw badRequest('missing_fields', { fields: 'currentPassword, newPassword' });
    }
    changePassword(ctx.userId, body.currentPassword, body.newPassword);
    invalidateSnapshots(ctx.userId);
    clearSessionCookie(ctx.res);
    sendJson(ctx.res, 200, { ok: true, reauthRequired: true });
  });
}
