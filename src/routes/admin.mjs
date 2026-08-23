// src/routes/admin.mjs - zaproszenia, uzytkownicy, log audytu. Tylko role owner/admin.
import { readJsonBody, sendJson, badRequest, forbidden } from '../http.mjs';
import { createInvite, listInvites, revokeInvite, publicUser, findUserById, destroyAllSessions } from '../auth.mjs';
import { getDb, nowIso, audit } from '../db.mjs';

export function registerAdminRoutes(router, { basePath }) {
  router.get('/admin/invites', (ctx) => {
    sendJson(ctx.res, 200, { ok: true, invites: listInvites() });
  }, { auth: 'admin' });

  router.post('/admin/invites', async (ctx) => {
    const body = await readJsonBody(ctx.req);
    const invite = createInvite({
      createdBy: ctx.userId,
      email: body.email ?? null,
      role: body.role ?? 'user',
      ttlHours: Number.isFinite(Number(body.ttlHours)) ? Math.min(720, Math.max(1, Number(body.ttlHours))) : 72,
    });
    sendJson(ctx.res, 201, {
      ok: true,
      ...invite,
      registerUrl: `${basePath}/login.html#invite=${invite.code}`,
      noteKey: 'inviteCodeShownOnce',
    });
  }, { auth: 'admin' });

  router.delete('/admin/invites/:id', (ctx) => {
    revokeInvite(ctx.params.id);
    sendJson(ctx.res, 200, { ok: true });
  }, { auth: 'admin' });

  router.get('/admin/users', (ctx) => {
    const rows = getDb().prepare(`
      SELECT u.*, (SELECT COUNT(*) FROM portfolios p WHERE p.user_id = u.id) AS portfolio_count
      FROM users u ORDER BY u.created_at
    `).all();
    sendJson(ctx.res, 200, {
      ok: true,
      users: rows.map((row) => ({ ...publicUser(row), status: row.status, portfolioCount: row.portfolio_count })),
    });
  }, { auth: 'admin' });

  /** Blokada konta natychmiast unewaznia wszystkie jego sesje. Wlasciciela nie da sie zablokowac. */
  router.patch('/admin/users/:id', async (ctx) => {
    const body = await readJsonBody(ctx.req);
    const target = findUserById(ctx.params.id);
    if (!target) throw badRequest('user_not_found');
    if (target.role === 'owner' && body.status === 'disabled') throw forbidden('owner_protected');
    if (target.id === ctx.userId && body.status === 'disabled') throw forbidden('self_lock_forbidden');

    const status = ['active', 'disabled'].includes(body.status) ? body.status : target.status;
    const role = ['user', 'admin'].includes(body.role) && target.role !== 'owner' ? body.role : target.role;
    getDb().prepare('UPDATE users SET status = ?, role = ?, updated_at = ? WHERE id = ?')
      .run(status, role, nowIso(), target.id);
    if (status === 'disabled') destroyAllSessions(target.id);
    audit({ userId: ctx.userId, action: 'admin.user_updated', entity: 'user', entityId: target.id, ip: ctx.ip, detail: { status, role } });
    sendJson(ctx.res, 200, { ok: true, user: publicUser(findUserById(target.id)) });
  }, { auth: 'admin' });

  router.get('/admin/audit', (ctx) => {
    const limit = Math.min(500, Math.max(1, Number(ctx.query.get('limit') ?? 100)));
    const rows = getDb().prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
    sendJson(ctx.res, 200, { ok: true, entries: rows });
  }, { auth: 'admin' });

  router.get('/admin/webhook-log', (ctx) => {
    const limit = Math.min(500, Math.max(1, Number(ctx.query.get('limit') ?? 100)));
    const rows = getDb().prepare('SELECT * FROM webhook_log ORDER BY id DESC LIMIT ?').all(limit);
    sendJson(ctx.res, 200, { ok: true, entries: rows });
  }, { auth: 'admin' });
}
