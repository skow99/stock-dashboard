// tests/deploy-scripts.test.mjs - niezmienniki skryptow wdrozeniowych.
//
// Tych skryptow nie da sie uruchomic w CI: potrzebuja roota, systemd i konta sdapp.
// Dlatego ich bledy wychodzily dopiero na maszynie, w polowie wdrozenia. Ponizsze
// testy sprawdzaja statycznie te wlasciwosci, ktorych zlamanie juz raz wywrocilo
// wydanie - kazdy z nich odpowiada prawdziwej awarii, nie hipotezie.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY = path.join(ROOT, 'deploy', 'gcp');

const scripts = fs.readdirSync(DEPLOY).filter((f) => f.endsWith('.sh'));
const read = (file) => fs.readFileSync(path.join(DEPLOY, file), 'utf8');

/** Skleja linie lamane ukoslnikiem - inaczej polecenie widac tylko we fragmentach. */
function joinContinuations(source) {
  return source.replace(/\\\r?\n\s*/g, ' ');
}

/**
 * Usuwa komentarze. Bez tego testy kolejnosci reaguja na wzmianke o poleceniu
 * w komentarzu tak samo jak na samo polecenie - a komentarz opisujacy pulapke
 * stoi zwykle WYZEJ niz kod, ktory jej unika.
 */
function codeOnly(source) {
  return joinContinuations(source)
    .split('\n')
    .map((line) => (line.trim().startsWith('#') ? '' : line))
    .join('\n');
}

/** Wszystkie polecenia uruchamiajace node na koncie aplikacji. */
function sudoNodeCommands(source) {
  return joinContinuations(source)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('#'))
    .filter((line) => /sudo\s+-u\s+"?\$\{?APP_USER\}?"?/.test(line) && /\bnode\b/.test(line));
}

test('skrypty wdrozeniowe w ogole istnieja', () => {
  assert.ok(scripts.includes('release.sh'), 'brak release.sh');
  assert.ok(scripts.length >= 3, `spodziewalem sie kilku skryptow, jest ${scripts.length}`);
});

test('kazdy skrypt przerywa sie na pierwszym bledzie', () => {
  for (const file of scripts) {
    assert.match(
      read(file), /set -euo pipefail/,
      `${file}: bez 'set -euo pipefail' bledny krok przejdzie niezauwazony`,
    );
  }
});

// ---------------------------------------------------------------- awaria z 23.08.2026

test('node uruchamiany jako sdapp zawsze dostaje jawny SD_DATA_DIR', () => {
  // config.mjs przy imporcie zaklada katalog 'data' obok kodu. Kod nalezy do roota
  // z prawami 755, wiec sdapp dostaje tam EACCES i wydanie pada, zanim cokolwiek zrobi.
  // Sciezka produkcyjna podawala SD_DATA_DIR od poczatku, stagingowa nie - i to ona padla.
  const brakujace = [];
  for (const file of scripts) {
    for (const cmd of sudoNodeCommands(read(file))) {
      if (!cmd.includes('SD_DATA_DIR')) brakujace.push(`${file}: ${cmd.slice(0, 100)}`);
    }
  }
  assert.deepEqual(brakujace, [],
    `polecenia bez SD_DATA_DIR skoncza sie EACCES na maszynie:\n  ${brakujace.join('\n  ')}`);
});

test('katalog danych stagingu nalezy do sdapp, zanim cokolwiek do niego pisze', () => {
  // mkdir -p tworzy katalog jako root. Jesli chown nastapi PO sanityzacji,
  // sanitize-db.mjs dostanie "EACCES: permission denied, copyfile".
  const source = codeOnly(read('release.sh'));
  const chown = source.search(/chown -R "\$APP_USER:\$APP_USER" "\$STAGING_DATA"/);
  const sanitize = source.search(/sanitize-db\.mjs/);

  assert.ok(chown > -1, 'nie znalazlem chown katalogu stagingowego');
  assert.ok(sanitize > -1, 'nie znalazlem wywolania sanitize-db.mjs');
  assert.ok(chown < sanitize,
    'chown katalogu danych musi wystapic PRZED sanitize-db.mjs, inaczej sdapp nie zapisze bazy');
});

test('kazdy zapis do katalogu danych jest poprzedzony ustaleniem wlasciciela', () => {
  const source = codeOnly(read('release.sh'));
  const mkdir = source.search(/mkdir -p "\$STAGING_DIR" "\$STAGING_DATA/);
  const chown = source.search(/chown -R "\$APP_USER:\$APP_USER" "\$STAGING_DATA"/);
  assert.ok(mkdir > -1 && chown > mkdir,
    'chown musi nastapic po mkdir (ktory tworzy katalog jako root) i przed uzyciem');
});

// ---------------------------------------------------------------- bramki produkcyjne

test('produkcja nie moze isc bez kopii zapasowej i proby generalnej migracji', () => {
  const source = read('release.sh');
  for (const [wzorzec, opis] of [
    [/Bramka 1\/4/, 'kopia zapasowa'],
    [/Bramka 2\/4/, 'proba generalna migracji'],
    [/Bramka 3\/4/, 'podmiana kodu'],
    [/Bramka 4\/4/, 'health check'],
    [/migrate-rehearse\.mjs/, 'wywolanie proby generalnej'],
    [/PROD_DIR\.old/, 'zachowanie poprzedniej wersji do cofniecia'],
  ]) {
    assert.match(source, wzorzec, `release.sh stracil: ${opis}`);
  }
});

test('nieudany health check cofa wydanie, a nie zostawia zepsuta wersje', () => {
  const source = read('release.sh');
  const idx = source.indexOf('Health check NIE PRZESZEDL');
  assert.ok(idx > -1, 'brak obslugi nieudanego health checku');
  const dalej = source.slice(idx);
  assert.match(dalej, /rsync -a --delete[^\n]*PROD_DIR\.old/, 'brak przywrocenia poprzedniej wersji');
  assert.match(dalej, /systemctl restart stock-dashboard/, 'brak restartu po cofnieciu');
});

test('staging nasluchuje wylacznie na petli zwrotnej', () => {
  // Staging trzyma sanityzowane, ale prawdziwe ksztaltem dane. Nie moze wyjsc na internet.
  const source = read('release.sh');
  assert.match(source, /SD_HOST=127\.0\.0\.1/, 'staging musi byc zwiazany z 127.0.0.1');
  assert.match(source, /STAGING_PORT=8788/, 'staging na innym porcie niz produkcja');
  assert.doesNotMatch(source, /SD_HOST=0\.0\.0\.0/, 'staging nie moze nasluchiwac na wszystkich interfejsach');
});

test('sanityzacja jest warunkiem, a nie sugestia', () => {
  // Gdyby jej nieudanie bylo ignorowane, staging dostalby dzialajace haslo z produkcji.
  const source = codeOnly(read('release.sh'));
  const linia = source.split('\n').find((l) => l.includes('sanitize-db.mjs'));
  assert.ok(linia, 'brak wywolania sanitize-db.mjs');
  assert.match(linia, /\|\| fail/, 'nieudana sanityzacja musi przerywac wydanie');
});
