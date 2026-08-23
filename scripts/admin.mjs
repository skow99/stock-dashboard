#!/usr/bin/env node
// scripts/admin.mjs - narzedzia administracyjne z linii polecen (dzialaja bez uruchomionego serwera).
//
//   node scripts/admin.mjs users
//   node scripts/admin.mjs create-user <email> [--role owner|admin|user]
//   node scripts/admin.mjs reset-password <email>
//   node scripts/admin.mjs invite [--role user] [--email a@b.pl] [--hours 72]
//   node scripts/admin.mjs portfolios <email>
//   node scripts/admin.mjs backup [katalog]
//   node scripts/admin.mjs vacuum
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';

import config from '../src/config.mjs';
import { getDb, nowIso } from '../src/db.mjs';
import { createUser, createInvite, findUserByEmail, hashPassword, assertPasswordPolicy, destroyAllSessions } from '../src/auth.mjs';
import { listPortfolios } from '../src/portfolios.mjs';

const [, , command, ...rest] = process.argv;
const flag = (name, fallback = null) => {
  const index = rest.indexOf(`--${name}`);
  return index > -1 && rest[index + 1] ? rest[index + 1] : fallback;
};

async function askSecret(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

const commands = {
  async users() {
    const rows = getDb().prepare('SELECT email, display_name, role, status, created_at, last_login_at FROM users ORDER BY created_at').all();
    if (!rows.length) { console.log('Brak uzytkownikow. Zaloz konto przez UI albo `create-user`.'); return; }
    console.table(rows);
  },

  async 'create-user'() {
    const email = rest[0];
    if (!email) throw new Error('Uzycie: create-user <email> [--role user]');
    const password = await askSecret(`Haslo dla ${email}: `);
    assertPasswordPolicy(password);
    const user = createUser({ email, password, role: flag('role', 'user') });
    console.log(`Utworzono ${user.email} (rola: ${user.role}, id: ${user.id})`);
  },

  async 'reset-password'() {
    const email = rest[0];
    const user = findUserByEmail(email);
    if (!user) throw new Error(`Nie znaleziono konta ${email}`);
    const password = await askSecret(`Nowe haslo dla ${email}: `);
    assertPasswordPolicy(password);
    getDb().prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?')
      .run(hashPassword(password), nowIso(), user.id);
    destroyAllSessions(user.id);
    console.log(`Haslo zmienione. Wszystkie sesje ${email} zostaly uniewaznione.`);
  },

  async invite() {
    const owner = getDb().prepare("SELECT id FROM users WHERE role IN ('owner','admin') ORDER BY created_at LIMIT 1").get();
    if (!owner) throw new Error('Brak konta administratora - najpierw zaloz konto wlasciciela.');
    const invite = createInvite({
      createdBy: owner.id,
      email: flag('email', null),
      role: flag('role', 'user'),
      ttlHours: Number(flag('hours', 72)),
    });
    console.log(`\nKod zaproszenia: ${invite.code}`);
    console.log(`Wazny: ${invite.expiresInHours}h, rola: ${invite.role}${invite.email ? `, tylko dla ${invite.email}` : ''}`);
    console.log(`Link: ${config.basePath}/login.html#invite=${invite.code}\n`);
  },

  async portfolios() {
    const user = findUserByEmail(rest[0]);
    if (!user) throw new Error(`Nie znaleziono konta ${rest[0]}`);
    const rows = listPortfolios(user.id, { includeArchived: true }).map((p) => ({
      id: p.id, nazwa: p.name, typ: p.kind, broker: p.broker,
      waluta: p.baseCurrency, archiwum: p.archived, webhook: p.hasWebhook,
    }));
    console.table(rows);
  },

  /** Kopia zapasowa przez online backup SQLite - bezpieczna przy dzialajacym serwerze. */
  async backup() {
    const target = rest[0] ?? path.join(config.dataDir, 'backups');
    fs.mkdirSync(target, { recursive: true });
    const file = path.join(target, `dashboard-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    const db = getDb();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(config.dbPath, file);
    const size = (fs.statSync(file).size / 1024 / 1024).toFixed(2);
    console.log(`Kopia zapasowa: ${file} (${size} MB)`);

    // Rotacja: zostawiamy 14 najnowszych kopii.
    const files = fs.readdirSync(target).filter((f) => f.endsWith('.db')).sort().reverse();
    for (const old of files.slice(14)) {
      fs.unlinkSync(path.join(target, old));
      console.log(`Usunieto stara kopie: ${old}`);
    }
  },

  async vacuum() {
    const db = getDb();
    const before = fs.statSync(config.dbPath).size;
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    db.exec('ANALYZE');
    const after = fs.statSync(config.dbPath).size;
    console.log(`VACUUM: ${(before / 1024).toFixed(0)} kB -> ${(after / 1024).toFixed(0)} kB`);
  },
};

(async () => {
  const handler = commands[command];
  if (!handler) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 11).join('\n').replace(/^\/\/ ?/gm, ''));
    process.exit(command ? 1 : 0);
  }
  try {
    await handler();
  } catch (err) {
    // HttpError niesie stabilny kod; czytelna tresc jest w katalogu i18n.
    const { errorMessage } = await import('../src/i18n.mjs');
    const readable = err.code ? errorMessage(err.code, 'pl', err.details ?? {}) : null;
    console.error(`Blad: ${readable ?? err.message}`);
    process.exit(1);
  }
})();
