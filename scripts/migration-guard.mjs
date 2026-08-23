#!/usr/bin/env node
// scripts/migration-guard.mjs - straznik ewolucji schematu bazy.
//
// System jest LIVE i trzyma dane finansowe uzytkownikow. Migracja, ktora usuwa kolumne
// albo zmienia znaczenie istniejacych danych, jest nieodwracalna w praktyce - kopia zapasowa
// ratuje dane, ale nie ratuje ciaglosci dzialania. Ten skrypt pilnuje trzech rzeczy:
//
//   1. Migracja raz wydana NIE MOZE zostac zmieniona. Baza produkcyjna ma juz zapisany
//      swoj user_version i nigdy nie odtworzy poprawionej wersji kroku, ktory juz wykonala.
//   2. Operacje niszczace (DROP, RENAME) wymagaja swiadomego dopuszczenia w kodzie.
//   3. Kazda nowa migracja musi zostac dopisana do pliku blokady.
//
// Uzycie:
//   node scripts/migration-guard.mjs check     # weryfikacja (uzywane w CI i w testach)
//   node scripts/migration-guard.mjs update    # dopisanie nowych migracji do blokady
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = path.join(ROOT, 'migrations.lock.json');

/**
 * Operacje, ktore w bazie z danymi produkcyjnymi sa nieodwracalne.
 * Jesli naprawde musisz je wykonac, dopisz nazwe migracji do `allowDestructive`
 * w pliku blokady - to wymusza swiadoma decyzje i zostawia slad w historii repozytorium.
 */
const DESTRUCTIVE = [
  { re: /\bDROP\s+TABLE\b/i, what: 'DROP TABLE' },
  { re: /\bDROP\s+COLUMN\b/i, what: 'DROP COLUMN' },
  { re: /\bRENAME\s+TO\b/i, what: 'RENAME TO' },
  { re: /\bRENAME\s+COLUMN\b/i, what: 'RENAME COLUMN' },
  { re: /\bDELETE\s+FROM\b/i, what: 'DELETE FROM' },
  { re: /\bTRUNCATE\b/i, what: 'TRUNCATE' },
  { re: /\bDROP\s+INDEX\b/i, what: 'DROP INDEX' },
];

/** Normalizacja przed liczeniem sumy: biale znaki nie zmieniaja semantyki SQL. */
const normalize = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const digest = (sql) => crypto.createHash('sha256').update(normalize(sql)).digest('hex').slice(0, 16);

async function loadMigrations() {
  const mod = await import(path.join(ROOT, 'src', 'db.mjs'));
  if (!Array.isArray(mod.MIGRATIONS)) {
    throw new Error('src/db.mjs nie eksportuje tablicy MIGRATIONS');
  }
  return mod.MIGRATIONS;
}

function readLock() {
  if (!fs.existsSync(LOCK_PATH)) {
    return { version: 1, note: '', allowDestructive: [], migrations: [] };
  }
  return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
}

function writeLock(lock) {
  fs.writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

/** Zwraca liste problemow. Pusta lista = wszystko w porzadku. */
export async function check() {
  const migrations = await loadMigrations();
  const lock = readLock();
  const problems = [];

  // 1. Migracje juz wydane nie moga sie zmienic.
  for (const recorded of lock.migrations) {
    const current = migrations[recorded.index];
    if (current === undefined) {
      problems.push(
        `Migracja ${recorded.index + 1} zniknela z src/db.mjs. Baza produkcyjna ma ja juz wykonana - `
        + 'usuniecie kroku rozjedzie schemat z user_version.',
      );
      continue;
    }
    const now = digest(current);
    if (now !== recorded.sha256) {
      problems.push(
        `Migracja ${recorded.index + 1} zostala ZMIENIONA (${recorded.sha256} -> ${now}). `
        + 'Baza produkcyjna wykonala juz stara wersje i nigdy nie wykona nowej. '
        + 'Zamiast edytowac ten krok, dopisz kolejna migracje na koncu tablicy.',
      );
    }
  }

  // 2. Operacje niszczace wymagaja jawnej zgody.
  migrations.forEach((sql, index) => {
    const name = `migracja-${index + 1}`;
    if (lock.allowDestructive?.includes(name)) return;
    for (const rule of DESTRUCTIVE) {
      if (rule.re.test(sql)) {
        problems.push(
          `Migracja ${index + 1} zawiera ${rule.what}, co na zywej bazie jest nieodwracalne. `
          + `Jesli to swiadoma decyzja, dopisz "${name}" do allowDestructive w migrations.lock.json `
          + 'i opisz powod w tresci commita. Rozwaz wzorzec expand/contract (docs/MIGRATIONS.md).',
        );
      }
    }
  });

  // 3. Nowe migracje musza trafic do blokady.
  if (migrations.length > lock.migrations.length) {
    const brakuje = migrations.length - lock.migrations.length;
    problems.push(
      `${brakuje} nowa(e) migracja(e) nie sa zapisane w migrations.lock.json. `
      + 'Uruchom: node scripts/migration-guard.mjs update',
    );
  }

  return { problems, migrations, lock };
}

async function update() {
  const migrations = await loadMigrations();
  const lock = readLock();

  // Nie ruszamy juz zapisanych wpisow - to one sa gwarancja niezmiennosci.
  const existing = new Map(lock.migrations.map((m) => [m.index, m]));
  const next = migrations.map((sql, index) => existing.get(index) ?? {
    index,
    version: index + 1,
    sha256: digest(sql),
    addedAt: new Date().toISOString().slice(0, 10),
  });

  const added = next.length - lock.migrations.length;
  writeLock({
    version: 1,
    note: 'Sumy kontrolne wydanych migracji. Nie edytuj recznie - patrz docs/MIGRATIONS.md',
    allowDestructive: lock.allowDestructive ?? [],
    migrations: next,
  });
  console.log(added > 0
    ? `Dopisano ${added} migracje do migrations.lock.json (lacznie ${next.length}).`
    : 'Blokada byla juz aktualna.');
}

const command = process.argv[2] ?? 'check';

if (command === 'update') {
  await update();
} else if (command === 'check') {
  const { problems, migrations, lock } = await check();
  if (problems.length) {
    console.error('\nStraznik migracji zglasza problemy:\n');
    for (const p of problems) console.error(`  - ${p}\n`);
    process.exit(1);
  }
  console.log(`Straznik migracji OK: ${migrations.length} migracji, ${lock.migrations.length} w blokadzie.`);
} else {
  console.error('Uzycie: node scripts/migration-guard.mjs [check|update]');
  process.exit(1);
}
