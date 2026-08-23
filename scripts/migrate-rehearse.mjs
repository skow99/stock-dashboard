#!/usr/bin/env node
// scripts/migrate-rehearse.mjs - proba generalna migracji na KOPII bazy produkcyjnej.
//
// Uruchamiane na maszynie produkcyjnej PRZED podmiana kodu. Odpowiada na pytanie,
// ktorego nie odpowie zaden test na sztucznych danych: czy nowe migracje przejda
// na tych konkretnych danych, ktore realnie sa w bazie.
//
// Nie dotyka bazy produkcyjnej - pracuje wylacznie na kopii.
//
// Uzycie:
//   node scripts/migrate-rehearse.mjs /var/lib/stock-dashboard/dashboard.db
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

const SOURCE = process.argv[2];
if (!SOURCE) {
  console.error('Uzycie: node scripts/migrate-rehearse.mjs <sciezka-do-bazy>');
  process.exit(1);
}
if (!fs.existsSync(SOURCE)) {
  console.error(`Baza nie istnieje: ${SOURCE}`);
  process.exit(1);
}

/** Tabele, ktorych zawartosc musi przetrwac kazda migracje. */
const CRITICAL = ['users', 'portfolios', 'transactions', 'cash_flows', 'holdings_baseline', 'portfolio_history'];

function counts(db) {
  const out = {};
  for (const table of CRITICAL) {
    try {
      out[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    } catch {
      out[table] = null; // tabela jeszcze nie istnieje w tej wersji schematu
    }
  }
  return out;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearse-'));
const copy = path.join(work, 'rehearsal.db');
let failed = false;

try {
  // Kopiujemy takze -wal i -shm, zeby odtworzyc dokladny stan bazy.
  fs.copyFileSync(SOURCE, copy);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(SOURCE + suffix)) fs.copyFileSync(SOURCE + suffix, copy + suffix);
  }

  const before = new DatabaseSync(copy);
  const versionBefore = before.prepare('PRAGMA user_version').get().user_version;
  const countsBefore = counts(before);
  before.close();

  console.log(`Proba generalna migracji na kopii: ${SOURCE}`);
  console.log(`  schemat przed:  user_version = ${versionBefore}`);

  // openDb() aplikuje migracje dokladnie tak, jak zrobi to serwer po restarcie.
  process.env.SD_DB_PATH = copy;
  process.env.SD_DATA_DIR = work;
  const { openDb } = await import('../src/db.mjs');
  const db = openDb(copy);

  const versionAfter = db.prepare('PRAGMA user_version').get().user_version;
  const countsAfter = counts(db);

  console.log(`  schemat po:     user_version = ${versionAfter}`);
  console.log(`  zastosowano:    ${versionAfter - versionBefore} migracji`);

  // 1. Zadne dane nie moga zniknac.
  console.log('\n  Zawartosc tabel krytycznych:');
  for (const table of CRITICAL) {
    const a = countsBefore[table];
    const b = countsAfter[table];
    const label = `${String(a ?? '-').padStart(7)} -> ${String(b ?? '-').padEnd(7)}`;
    if (a !== null && b !== null && b < a) {
      console.log(`    ${table.padEnd(20)} ${label}  UBYLO ${a - b} WIERSZY`);
      failed = true;
    } else {
      console.log(`    ${table.padEnd(20)} ${label}`);
    }
  }

  // 2. Baza musi zostac spojna.
  const integrity = db.prepare('PRAGMA integrity_check').get();
  const integrityOk = Object.values(integrity)[0] === 'ok';
  console.log(`\n  integrity_check:    ${integrityOk ? 'ok' : JSON.stringify(integrity)}`);
  if (!integrityOk) failed = true;

  const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
  console.log(`  foreign_key_check:  ${fkViolations.length === 0 ? 'ok' : `${fkViolations.length} naruszen`}`);
  if (fkViolations.length) {
    console.log(`    ${JSON.stringify(fkViolations.slice(0, 5))}`);
    failed = true;
  }

  // 3. Aplikacja musi umiec odczytac dane po migracji - sam schemat to za malo.
  try {
    db.prepare('SELECT id, email, role FROM users LIMIT 1').get();
    db.prepare('SELECT id, user_id, name, base_currency FROM portfolios LIMIT 1').get();
    db.prepare('SELECT id, portfolio_id, trade_date, ticker, side, qty, price FROM transactions LIMIT 1').get();
    console.log('  odczyt kluczowych kolumn: ok');
  } catch (err) {
    console.log(`  odczyt kluczowych kolumn: BLAD - ${err.message}`);
    failed = true;
  }

  db.close();
} catch (err) {
  console.error(`\nProba generalna NIE POWIODLA SIE: ${err.message}`);
  failed = true;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(failed
  ? '\nWYNIK: migracja NIE jest bezpieczna dla tej bazy. Wdrozenie wstrzymane.'
  : '\nWYNIK: migracja bezpieczna dla biezacych danych produkcyjnych.');
process.exit(failed ? 1 : 0);
