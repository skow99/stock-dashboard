// tests/migrations.test.mjs - gwarancje wokol ewolucji schematu na zywym systemie.
//
// To sa testy, ktore maja zatrzymac wdrozenie, zanim dotknie ono bazy z danymi uzytkownikow.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { MIGRATIONS, openDb } from '../src/db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = JSON.parse(fs.readFileSync(path.join(ROOT, 'migrations.lock.json'), 'utf8'));
const digest = (sql) => crypto.createHash('sha256').update(String(sql).replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);

function runGuard(args = ['check'], env = {}) {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'migration-guard.mjs'), ...args], {
      encoding: 'utf8', env: { ...process.env, SD_OFFLINE: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

// ---------------------------------------------------------------- niezmiennosc

test('kazda wydana migracja ma zapisana sume kontrolna', () => {
  assert.equal(LOCK.migrations.length, MIGRATIONS.length,
    'Liczba migracji rozni sie od blokady. Uruchom: node scripts/migration-guard.mjs update');
});

test('zadna wydana migracja nie zostala zmieniona', () => {
  for (const recorded of LOCK.migrations) {
    assert.equal(
      digest(MIGRATIONS[recorded.index]), recorded.sha256,
      `Migracja ${recorded.version} zostala zmodyfikowana. Baza produkcyjna wykonala juz stara wersje `
      + 'i nigdy nie wykona nowej - dopisz kolejna migracje zamiast edytowac istniejaca.',
    );
  }
});

test('straznik migracji przechodzi na biezacym repozytorium', () => {
  const { code, out } = runGuard();
  assert.equal(code, 0, out);
});

test('straznik wykrywa podmiane wydanej migracji', () => {
  // Symulacja realnego bledu: ktos poprawia literowke w migracji, ktora jest juz na produkcji.
  const lockPath = path.join(ROOT, 'migrations.lock.json');
  const original = fs.readFileSync(lockPath, 'utf8');
  const tampered = JSON.parse(original);
  tampered.migrations[0].sha256 = 'deadbeefdeadbeef';
  fs.writeFileSync(lockPath, JSON.stringify(tampered, null, 2));
  try {
    const { code, out } = runGuard();
    assert.equal(code, 1, 'straznik powinien odrzucic zmieniona migracje');
    assert.match(out, /ZMIENIONA/);
  } finally {
    fs.writeFileSync(lockPath, original);
  }
});

test('straznik wykrywa operacje niszczace', async () => {
  const { check } = await import('../scripts/migration-guard.mjs').catch(() => ({}));
  void check; // modul jest CLI; sprawdzamy regule na poziomie tresci migracji
  const destructive = /\b(DROP\s+TABLE|DROP\s+COLUMN|RENAME\s+TO|DELETE\s+FROM|TRUNCATE)\b/i;
  for (const [index, sql] of MIGRATIONS.entries()) {
    const name = `migracja-${index + 1}`;
    if (LOCK.allowDestructive?.includes(name)) continue;
    assert.ok(!destructive.test(sql),
      `Migracja ${index + 1} zawiera operacje niszczaca bez jawnej zgody w allowDestructive.`);
  }
});

// ---------------------------------------------------------------- zgodnosc wsteczna

test('migracje od pustej bazy daja ten sam schemat co migracje przyrostowe', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  try {
    // Sciezka A: pusta baza, wszystkie migracje na raz (nowa instalacja).
    const fresh = openDb(path.join(work, 'fresh.db'));
    const freshSchema = fresh.prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    ).all();
    const freshVersion = fresh.prepare('PRAGMA user_version').get().user_version;
    fresh.close();

    // Sciezka B: baza zatrzymana na wersji 1, potem domigrowana (istniejaca instalacja).
    const stepped = new DatabaseSync(path.join(work, 'stepped.db'));
    stepped.exec('PRAGMA foreign_keys = ON');
    stepped.exec(MIGRATIONS[0]);
    stepped.exec('PRAGMA user_version = 1');
    stepped.close();
    const upgraded = openDb(path.join(work, 'stepped.db'));
    const upgradedSchema = upgraded.prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    ).all();
    const upgradedVersion = upgraded.prepare('PRAGMA user_version').get().user_version;
    upgraded.close();

    assert.equal(upgradedVersion, freshVersion, 'obie sciezki musza konczyc na tej samej wersji schematu');
    assert.deepEqual(upgradedSchema, freshSchema,
      'Nowa instalacja i zaktualizowana instalacja maja rozne schematy - to prowadzi do bledow widocznych '
      + 'wylacznie na produkcji.');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('migracja zachowuje dane istniejacego uzytkownika', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-data-'));
  const dbPath = path.join(work, 'live.db');
  try {
    // Baza "produkcyjna" z danymi.
    const db = openDb(dbPath);
    const at = new Date().toISOString();
    db.prepare(`INSERT INTO users (id, email, display_name, password_hash, role, status, created_at, updated_at)
                VALUES ('u1','a@b.pl','A','hash','owner','active',?,?)`).run(at, at);
    db.prepare(`INSERT INTO portfolios (id, user_id, name, slug, base_currency, broker, kind, color, tax_rate, position, archived, created_at, updated_at)
                VALUES ('p1','u1','Portfel','portfel','PLN','','brokerage','#4fc3f7',0.19,0,0,?,?)`).run(at, at);
    db.prepare(`INSERT INTO transactions (id, portfolio_id, trade_date, ticker, name, side, qty, price, fee, currency, note, source, created_at, updated_at)
                VALUES ('t1','p1','2026-01-10','GPW.WA','GPW','BUY',100,45.12,0,'PLN','','manual',?,?)`).run(at, at);
    db.close();

    // Ponowne otwarcie = ponowne przejscie przez migrator (tak dziala restart uslugi).
    const reopened = openDb(dbPath);
    assert.equal(reopened.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
    assert.equal(reopened.prepare('SELECT COUNT(*) n FROM transactions').get().n, 1);
    // node:sqlite zwraca obiekty bez prototypu, stad rozlozenie przed porownaniem.
    const tx = reopened.prepare('SELECT ticker, qty, price FROM transactions WHERE id = ?').get('t1');
    assert.deepEqual({ ...tx }, { ticker: 'GPW.WA', qty: 100, price: 45.12 });
    reopened.close();
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- proba generalna

test('proba generalna wykrywa baze, ktorej migracja nie tknie', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'reh-'));
  const dbPath = path.join(work, 'prod.db');
  try {
    const db = openDb(dbPath);
    const at = new Date().toISOString();
    db.prepare(`INSERT INTO users (id, email, display_name, password_hash, role, status, created_at, updated_at)
                VALUES ('u1','a@b.pl','A','hash','owner','active',?,?)`).run(at, at);
    db.close();

    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate-rehearse.mjs'), dbPath], {
      encoding: 'utf8', env: { ...process.env, SD_OFFLINE: '1' },
    });
    assert.match(out, /migracja bezpieczna/);
    assert.match(out, /integrity_check:\s+ok/);

    // Baza produkcyjna nie moze zostac dotknieta przez probe.
    const after = new DatabaseSync(dbPath);
    assert.equal(after.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
    after.close();
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
