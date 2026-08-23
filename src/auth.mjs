// src/auth.mjs - konta, hasla, sesje, CSRF, zaproszenia, linki publiczne.
import crypto from 'node:crypto';
import config from './config.mjs';
import { getDb, newId, nowIso, sha256, audit, tx } from './db.mjs';
import { HttpError, badRequest, unauthorized, forbidden, conflict, createRateLimiter } from './http.mjs';
import { log } from './log.mjs';

// ---------------------------------------------------------------- hasla

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Minimalna, ale niepusta polityka hasel. Blokuje najczestsze slabe hasla. */
const WEAK = new Set(['password', 'haslo123', 'qwerty123', '1234567890', 'passw0rd!', 'admin12345']);
export function assertPasswordPolicy(password) {
  const value = String(password ?? '');
  if (value.length < config.minPasswordLength) {
    throw badRequest('weak_password', { min: config.minPasswordLength });
  }
  if (value.length > 200) throw badRequest('password_too_long', { max: 200 });
  if (WEAK.has(value.toLowerCase())) throw badRequest('password_too_common');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  if (classes < 3) throw badRequest('weak_password', { min: config.minPasswordLength });
}

export function normalizeEmail(email) {
  const value = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) throw badRequest('invalid_email');
  if (value.length > 254) throw badRequest('email_too_long');
  return value;
}

// ---------------------------------------------------------------- limity logowania

export const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });

// ---------------------------------------------------------------- uzytkownicy

export function countUsers() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export function findUserByEmail(email) {
  return getDb().prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());
}

export function findUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function createUser({ email, password, displayName = '', role = 'user' }) {
  const normalized = normalizeEmail(email);
  assertPasswordPolicy(password);
  if (findUserByEmail(normalized)) throw conflict('email_taken');
  const at = nowIso();
  const user = {
    id: newId('usr_'),
    email: normalized,
    display_name: String(displayName || normalized.split('@')[0]).slice(0, 80),
    password_hash: hashPassword(password),
    role,
    status: 'active',
    created_at: at,
    updated_at: at,
  };
  getDb().prepare(`
    INSERT INTO users (id, email, display_name, password_hash, role, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(user.id, user.email, user.display_name, user.password_hash, user.role, user.status, at, at);
  audit({ userId: user.id, action: 'user.created', entity: 'user', entityId: user.id, detail: { role } });
  return user;
}

export function changePassword(userId, currentPassword, nextPassword) {
  const user = findUserById(userId);
  if (!user) throw unauthorized();
  if (!verifyPassword(currentPassword, user.password_hash)) {
    throw badRequest('invalid_password');
  }
  assertPasswordPolicy(nextPassword);
  getDb().prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(hashPassword(nextPassword), nowIso(), userId);
  // Wylogowanie wszystkich innych sesji po zmianie hasla.
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  audit({ userId, action: 'user.password_changed', entity: 'user', entityId: userId });
}

/**
 * Uwierzytelnienie z ochrona przed brute force:
 * - licznik nieudanych prob na koncie + czasowa blokada,
 * - staly koszt obliczeniowy nawet dla nieistniejacego konta (brak user enumeration).
 */
const DUMMY_HASH = hashPassword('nieistniejace-konto-placeholder-A1!');

export function authenticate(email, password, ip) {
  let normalized;
  try {
    normalized = normalizeEmail(email);
  } catch {
    verifyPassword(String(password ?? ''), DUMMY_HASH);
    throw unauthorized('invalid_credentials');
  }
  const user = findUserByEmail(normalized);
  if (!user) {
    verifyPassword(String(password ?? ''), DUMMY_HASH);
    throw unauthorized('invalid_credentials');
  }
  if (user.status !== 'active') throw forbidden('account_disabled');
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    const err = new HttpError(429, 'account_locked');
    err.retryAfterMs = new Date(user.locked_until).getTime() - Date.now();
    throw err;
  }
  if (!verifyPassword(String(password ?? ''), user.password_hash)) {
    const failed = (user.failed_logins ?? 0) + 1;
    const lockedUntil = failed >= config.loginMaxAttempts
      ? new Date(Date.now() + config.loginLockoutMs).toISOString()
      : null;
    getDb().prepare('UPDATE users SET failed_logins = ?, locked_until = ?, updated_at = ? WHERE id = ?')
      .run(failed, lockedUntil, nowIso(), user.id);
    audit({ userId: user.id, action: 'auth.login_failed', ip, detail: { failed } });
    throw unauthorized('invalid_credentials');
  }
  getDb().prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?')
    .run(nowIso(), nowIso(), user.id);
  return findUserById(user.id);
}

// ---------------------------------------------------------------- sesje + CSRF

function newToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function createSession(userId, { ip, userAgent } = {}) {
  const token = newToken();
  const at = nowIso();
  const expiresAt = new Date(Date.now() + config.sessionTtlMs).toISOString();
  const csrfSecret = newToken(24);
  getDb().prepare(`
    INSERT INTO sessions (id, user_id, csrf_secret, created_at, last_seen_at, expires_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sha256(token), userId, csrfSecret, at, at, expiresAt, ip ?? null, String(userAgent ?? '').slice(0, 200));
  audit({ userId, action: 'auth.login', ip });
  return { token, expiresAt, csrfToken: csrfTokenFor(csrfSecret) };
}

export function csrfTokenFor(csrfSecret) {
  return crypto.createHmac('sha256', csrfSecret).update('csrf').digest('base64url');
}

export function loadSession(token) {
  if (!token) return null;
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(sha256(token));
  if (!row) return null;
  const now = Date.now();
  if (new Date(row.expires_at).getTime() < now) {
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    return null;
  }
  if (now - new Date(row.last_seen_at).getTime() > config.sessionIdleMs) {
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    return null;
  }
  const user = findUserById(row.user_id);
  if (!user || user.status !== 'active') return null;
  getDb().prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), row.id);
  return { session: row, user };
}

export function destroySession(token) {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token));
}

export function destroyAllSessions(userId) {
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function listSessions(userId, currentToken) {
  const currentId = currentToken ? sha256(currentToken) : null;
  return getDb().prepare('SELECT id, created_at, last_seen_at, expires_at, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC')
    .all(userId)
    .map((row) => ({
      id: row.id.slice(0, 12),
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      ip: row.ip,
      userAgent: row.user_agent,
      current: row.id === currentId,
    }));
}

/**
 * Podwojna ochrona zapisow:
 * 1. naglowek X-CSRF-Token zgodny z sekretem sesji,
 * 2. kontrola Sec-Fetch-Site / Origin (obrona w glab dla starszych klientow).
 */
export function assertCsrf(req, session) {
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'same-site', 'none'].includes(String(site))) {
    throw forbidden('cross_site_blocked');
  }
  const provided = req.headers['x-csrf-token'];
  if (!provided) throw forbidden('csrf_missing');
  const expected = csrfTokenFor(session.csrf_secret);
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw forbidden('csrf_invalid');
}

export function sweepSessions() {
  const removed = getDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso()).changes;
  if (removed) log.debug('sessions.swept', { removed });
}

// ---------------------------------------------------------------- zaproszenia

export function createInvite({ createdBy, email = null, role = 'user', ttlHours = 72 }) {
  if (!['user', 'admin'].includes(role)) throw badRequest('invalid_role');
  const code = newToken(18);
  getDb().prepare(`
    INSERT INTO invites (id, email, role, created_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    sha256(code),
    email ? normalizeEmail(email) : null,
    role,
    createdBy,
    nowIso(),
    new Date(Date.now() + ttlHours * 3600 * 1000).toISOString(),
  );
  audit({ userId: createdBy, action: 'invite.created', entity: 'invite', detail: { role, email } });
  return { code, expiresInHours: ttlHours, role, email };
}

export function listInvites() {
  return getDb().prepare(`
    SELECT id, email, role, created_at, expires_at, used_at, used_by FROM invites ORDER BY created_at DESC LIMIT 100
  `).all().map((row) => ({
    id: row.id.slice(0, 12),
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    status: row.used_at ? 'used' : (new Date(row.expires_at).getTime() < Date.now() ? 'expired' : 'active'),
  }));
}

export function revokeInvite(idPrefix) {
  const rows = getDb().prepare('SELECT id FROM invites WHERE used_at IS NULL').all();
  const match = rows.find((r) => r.id.startsWith(idPrefix));
  if (!match) throw badRequest('invite_not_found');
  getDb().prepare('DELETE FROM invites WHERE id = ?').run(match.id);
}

/** Rejestracja: pierwsze konto zostaje ownerem, kolejne wymagaja zaproszenia (chyba ze SD_OPEN_REGISTRATION=1). */
export function register({ email, password, displayName, inviteCode }) {
  const isFirstUser = countUsers() === 0;
  if (isFirstUser) {
    return createUser({ email, password, displayName, role: 'owner' });
  }
  if (config.openRegistration && !inviteCode) {
    return createUser({ email, password, displayName, role: 'user' });
  }
  if (!inviteCode) throw forbidden('registration_closed');

  return tx(() => {
    const invite = getDb().prepare('SELECT * FROM invites WHERE id = ?').get(sha256(String(inviteCode).trim()));
    if (!invite) throw badRequest('invalid_invite', { reason: 'unknown' });
    if (invite.used_at) throw badRequest('invalid_invite', { reason: 'already_used' });
    if (new Date(invite.expires_at).getTime() < Date.now()) throw badRequest('invalid_invite', { reason: 'expired' });
    const normalized = normalizeEmail(email);
    if (invite.email && invite.email !== normalized) {
      throw badRequest('invalid_invite', { reason: 'email_mismatch' });
    }
    const user = createUser({ email: normalized, password, displayName, role: invite.role });
    getDb().prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?').run(nowIso(), user.id, invite.id);
    return user;
  });
}

/** Konto startowe z ENV - wykonywane tylko gdy baza jest pusta. */
export function bootstrapFromEnv() {
  if (countUsers() > 0) return null;
  if (!config.bootstrapEmail || !config.bootstrapPassword) return null;
  const user = createUser({
    email: config.bootstrapEmail,
    password: config.bootstrapPassword,
    displayName: 'Owner',
    role: 'owner',
  });
  log.info('auth.bootstrap_user_created', { email: user.email });
  return user;
}

export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at,
  };
}
