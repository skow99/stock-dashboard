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
  // ci-ssh.sh jest jedynym wyjatkiem i to swiadomym: jego zadaniem jest BADANIE
  // kodow wyjscia nieudanych prob, zeby odroznic blad przejsciowy od trwalego.
  // Z 'set -e' zakonczylby sie na pierwszej odrzuconej probie, czyli dokladnie tam,
  // gdzie ma zaczac dzialac. Nadal wymagamy od niego '-u' i 'pipefail'.
  const bezE = new Set(['ci-ssh.sh']);

  for (const file of scripts) {
    const source = read(file);
    if (bezE.has(file)) {
      assert.match(source, /set -uo pipefail/, `${file}: wymagane co najmniej 'set -uo pipefail'`);
      assert.doesNotMatch(source, /set -euo pipefail/,
        `${file}: 'set -e' zlamalby obsluge ponowien - jesli to celowa zmiana, usun plik z listy wyjatkow`);
      continue;
    }
    assert.match(source, /set -euo pipefail/,
      `${file}: bez 'set -euo pipefail' bledny krok przejdzie niezauwazony`);
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

// ---------------------------------------------------------------- awaria z 23.08.2026, runda 2

test('workflow rozmawia z maszyna wylacznie przez ci-ssh.sh', () => {
  // OS Login odrzuca polaczenia losowo, dopoki nie rozpropaguje klucza konta uslugowego
  // ("Permission denied (publickey)" mimo poprawnych uprawnien). Ponawianie musi byc
  // w KAZDYM kroku - wczesniej mial je tylko jeden z szesciu i to on jako jedyny przechodzil.
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
  const bezposrednie = workflow
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .filter((line) => line.includes('gcloud compute ssh') || line.includes('gcloud compute scp'));
  assert.deepEqual(bezposrednie, [],
    `krok omija ci-ssh.sh, wiec nie ponawia prob:\n  ${bezposrednie.join('\n  ')}`);
});

test('ci-ssh ponawia bledy polaczenia, ale nie bledy trwale', () => {
  const source = read('ci-ssh.sh');
  assert.match(source, /Permission denied \\\(publickey\\\)/,
    'brak wzorca na awarie OS Login - to ona wywracala wdrozenie');
  assert.match(source, /przejsciowy\(\)/, 'brak rozroznienia bledow przejsciowych od trwalych');
  assert.match(source, /nie ponawiam/, 'blad trwaly musi konczyc sie od razu, bez czekania');
});

test('ponawiana wysylka otwiera plik od nowa przy kazdej probie', () => {
  // Gdyby stdin byl podpiety raz, poza petla, druga proba wyslalaby pusty strumien
  // i na maszynie wyladowalaby uszkodzona paczka - z poprawnym kodem wyjscia.
  const source = joinContinuations(read('ci-ssh.sh'));
  const petla = source.slice(source.indexOf('for (( proba'), source.indexOf('return "$kod"'));
  assert.match(petla, /--command="\$polecenie" < "\$plik"/,
    'przekierowanie pliku musi byc WEWNATRZ petli ponowien');
});

test('wysylka zawsze weryfikuje sume kontrolna', () => {
  const source = read('ci-ssh.sh');
  assert.match(source, /SUMA_LOKALNA/, 'brak sumy lokalnej');
  assert.match(source, /SUMA_ZDALNA/, 'brak sumy z maszyny');
  assert.match(source, /paczka dotarla uszkodzona/i, 'brak reakcji na niezgodnosc sum');
  // Nieudany grep w podstawieniu potrafi zabic krok, zanim cokolwiek wypiszemy.
  assert.match(source, /grep -oE '\[0-9a-f\]\{64\}' \| head -1 \|\| true/,
    "odczyt sumy musi konczyc sie '|| true', inaczej krok pada bez diagnozy");
});

test('samo wydanie nie jest ponawiane automatycznie', () => {
  // Ponowienie przerwanego release.sh nadpisaloby /opt/stock-dashboard.old nowym kodem,
  // czyli skasowaloby wersje, do ktorej mielibysmy sie cofac.
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
  for (const krok of ['Wydanie na staging', 'Wydanie na produkcje']) {
    const idx = workflow.indexOf(`name: ${krok}`);
    assert.ok(idx > -1, `brak kroku: ${krok}`);
    const blok = workflow.slice(idx, idx + 600);
    assert.match(blok, /CI_SSH_PROBY:\s*1/, `${krok}: wydanie nie moze byc ponawiane automatycznie`);
  }
});

// ---------------------------------------------------------------- awaria z 23.08.2026, runda 3

test('katalog z mktemp dostaje prawa, jesli siega do niego konto aplikacji', () => {
  // 'mktemp -d' tworzy katalog 700. Skrypt biegnie jako root, wiec jemu to nie
  // przeszkadza - ale czesc pracy wykonuje konto sdapp i bez prawa wejscia node
  // zglasza "Cannot find module", mimo ze plik lezy dokladnie tam, gdzie powinien.
  //
  // Wymagamy praw TYLKO tam, gdzie sdapp naprawde siega. Katalog uzywany wylacznie
  // przez roota (np. rozpakowanie przed rsync w bootstrap.sh) jest w porzadku jako 700 -
  // ciasniejsze prawa to domyslnie lepiej.
  for (const file of scripts) {
    const source = codeOnly(read(file));
    const liniekSudo = source.split('\n').filter((l) => /sudo\s+-u\s+"?\$\{?APP_USER\}?"?/.test(l));

    for (const match of source.matchAll(/(\w+)="\$\(mktemp -d\)"/g)) {
      const zmienna = match[1];

      // Zmienne wyprowadzone, np. NEW_CODE="$TMP/stock-dashboard" - to przez nie
      // sdapp trafial do katalogu tymczasowego, wiec samo szukanie "$TMP" nie wystarczy.
      const pochodne = [zmienna];
      for (const p of source.matchAll(new RegExp(`(\\w+)="\\$${zmienna}[/"]`, 'g'))) {
        pochodne.push(p[1]);
      }

      const uzywaSdapp = liniekSudo.some((l) => pochodne.some((v) => l.includes(`$${v}`)));
      if (!uzywaSdapp) continue;

      const chmodNaNiej = new RegExp(`chmod[^\\n]*"\\$${zmienna}"`);
      assert.match(source, chmodNaNiej,
        `${file}: z katalogu $${zmienna} (mktemp, prawa 700) cos biegnie jako $APP_USER, `
        + `a katalog nie dostaje jawnych praw - skonczy sie "Cannot find module"`);
    }
  }
});

test('kod do proby generalnej jest dostepny dla konta aplikacji', () => {
  const source = codeOnly(read('release.sh'));
  const chmod = source.search(/chmod 755 "\$TMP"/);
  const rozpakowanie = source.search(/tar -xzf "\$ARCHIVE" -C "\$TMP"/);
  const proba = source.search(/migrate-rehearse\.mjs/);

  assert.ok(chmod > -1, 'brak chmod na katalogu, z ktorego uruchamiamy probe generalna');
  assert.ok(chmod < rozpakowanie, 'prawa ustawiamy przed rozpakowaniem, nie po');
  assert.ok(chmod < proba, 'prawa musza byc gotowe, zanim sdapp siegnie po skrypt');
});

test('kopia bazy do proby generalnej jest zapisywalna dla sdapp', () => {
  const source = codeOnly(read('release.sh'));
  const chmod = source.search(/chmod -R 777 "\$REH_DIR"/);
  const proba = source.search(/migrate-rehearse\.mjs/);
  assert.ok(chmod > -1 && chmod < proba,
    'REH_DIR musi byc dostepny dla sdapp PRZED proba generalna - migracja zapisuje do kopii');
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
