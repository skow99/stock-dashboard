#!/usr/bin/env node
// scripts/sanitize-db.mjs - kopia bazy produkcyjnej pozbawiona sekretow, do stagingu.
//
// Staging ma sluzyc sprawdzeniu, jak nowa wersja zachowa sie na PRAWDZIWYM ksztalcie danych.
// Nie ma natomiast powodu, zeby trzymal dzialajace poswiadczenia. Ten skrypt zostawia
// strukture i wartosci finansowe, a usuwa wszystko, czym mozna sie zalogowac albo podszyc.
//
// Uzycie:
//   node scripts/sanitize-db.mjs <zrodlo.db> <cel.db> [--password 'Haslo!Staging2026']
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

const [source, target] = process.argv.slice(2);
const passwordIndex = process.argv.indexOf('--password');
const STAGING_PASSWORD = passwordIndex > -1 ? process.argv[passwordIndex + 1] : 'Staging!Haslo2026';

if (!source || !target) {
  console.error("Uzycie: node scripts/sanitize-db.mjs <zrodlo.db> <cel.db> [--password 'haslo']");
  process.exit(1);
}
if (!fs.existsSync(source)) {
  console.error(`Baza zrodlowa nie istnieje: ${source}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
for (const suffix of ['-wal', '-shm']) {
  fs.rmSync(target + suffix, { force: true });
  if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, target + suffix);
}

const { hashPassword } = await import('../src/auth.mjs');
const db = new DatabaseSync(target);
db.exec('PRAGMA foreign_keys = ON');

const removed = {};
const run = (label, sql) => {
  try {
    removed[label] = db.prepare(sql).run().changes;
  } catch (err) {
    removed[label] = `blad: ${err.message}`;
  }
};

db.exec('BEGIN IMMEDIATE');
try {
  // 1. Wszystkie hasla zastapione jednym, znanym - inaczej nikt sie do stagingu nie dostanie.
  const hash = hashPassword(STAGING_PASSWORD);
  removed.hasla = db.prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL').run(hash).changes;

  // 2. Adresy e-mail anonimizowane, ale deterministycznie - zeby dalo sie zalogowac.
  //    Wlasciciel dostaje owner@staging.local, reszta userN@staging.local.
  const users = db.prepare("SELECT id, role FROM users ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at").all();
  users.forEach((user, index) => {
    const email = user.role === 'owner' ? 'owner@staging.local' : `user${index}@staging.local`;
    db.prepare('UPDATE users SET email = ?, display_name = ? WHERE id = ?')
      .run(email, user.role === 'owner' ? 'Owner (staging)' : `Uzytkownik ${index}`, user.id);
  });
  removed.konta = users.length;

  // 3. Sekrety i slady, ktore nie maja prawa opuscic produkcji.
  run('sesje', 'DELETE FROM sessions');
  run('zaproszenia', 'DELETE FROM invites');
  run('linki_publiczne', 'DELETE FROM share_links');
  run('log_audytu', 'DELETE FROM audit_log');
  run('log_webhookow', 'DELETE FROM webhook_log');
  run('tokeny_webhook', 'UPDATE portfolios SET webhook_token = NULL');

  // 4. Notatki wlasne moga zawierac tresci prywatne, a do testow nie sa potrzebne.
  run('notatki', "UPDATE position_notes SET note = '', plan = ''");

  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error(`Sanityzacja nie powiodla sie: ${err.message}`);
  db.close();
  fs.rmSync(target, { force: true });
  process.exit(1);
}

db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.exec('VACUUM');

const zostalo = {
  portfele: db.prepare('SELECT COUNT(*) n FROM portfolios').get().n,
  transakcje: db.prepare('SELECT COUNT(*) n FROM transactions').get().n,
  przeplywy: db.prepare('SELECT COUNT(*) n FROM cash_flows').get().n,
  historia: db.prepare('SELECT COUNT(*) n FROM portfolio_history').get().n,
};

// Kontrola koncowa: zaden sekret nie moze przetrwac.
const leftovers = [];
if (db.prepare('SELECT COUNT(*) n FROM sessions').get().n) leftovers.push('sessions');
if (db.prepare('SELECT COUNT(*) n FROM share_links').get().n) leftovers.push('share_links');
if (db.prepare('SELECT COUNT(*) n FROM invites').get().n) leftovers.push('invites');
if (db.prepare('SELECT COUNT(*) n FROM portfolios WHERE webhook_token IS NOT NULL').get().n) leftovers.push('webhook_token');
db.close();

if (leftovers.length) {
  console.error(`Sanityzacja niekompletna, zostaly: ${leftovers.join(', ')}`);
  fs.rmSync(target, { force: true });
  process.exit(1);
}

console.log(`Kopia stagingowa: ${target}`);
console.log(`  usunieto:   ${JSON.stringify(removed)}`);
console.log(`  zachowano:  ${JSON.stringify(zostalo)}`);
console.log(`  logowanie:  owner@staging.local / ${STAGING_PASSWORD}`);
