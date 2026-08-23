// tests/ui-contract.test.mjs - kontrakt miedzy JavaScriptem a HTML-em i katalogiem tlumaczen.
//
// Frontend nie ma kompilatora ani typow, wiec literowka w selektorze ('#import-comit')
// albo brakujacy klucz tlumaczenia nie odezwa sie az do momentu, w ktorym uzytkownik
// kliknie. Te testy zamykaja te dziure: sprawdzaja, ze kazdy identyfikator, do ktorego
// siega kod, istnieje w HTML-u, i ze kazdy klucz t() ma tresc w OBU jezykach.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const HTML = read('public/index.html');
const I18N = read('public/i18n.js');
const SCRIPTS = ['public/app.js', 'public/import.js', 'public/ui.js', 'public/charts.js'];

/** Identyfikatory obecne w HTML-u. */
const htmlIds = new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

/** Klucze zdefiniowane w katalogu, osobno dla kazdego jezyka. */
function catalogKeys(locale) {
  const start = I18N.indexOf(`  ${locale}: {`);
  assert.ok(start > 0, `nie znalazlem bloku ${locale} w i18n.js`);
  let depth = 0;
  let i = I18N.indexOf('{', start);
  const from = i;
  for (; i < I18N.length; i += 1) {
    if (I18N[i] === '{') depth += 1;
    else if (I18N[i] === '}') { depth -= 1; if (!depth) break; }
  }
  return new Set([...I18N.slice(from, i).matchAll(/^\s*'([a-zA-Z0-9_.]+)':/gm)].map((m) => m[1]));
}

const PL = catalogKeys('pl');
const EN = catalogKeys('en');

// ---------------------------------------------------------------- selektory

test('kazdy #identyfikator uzywany w kodzie istnieje w index.html', () => {
  const missing = [];
  for (const file of SCRIPTS) {
    const source = read(file);
    for (const match of source.matchAll(/\$\$?\('#([a-zA-Z0-9_-]+)'/g)) {
      if (!htmlIds.has(match[1])) missing.push(`${file}: #${match[1]}`);
    }
  }
  assert.deepEqual(missing, [], `selektory bez odpowiednika w HTML:\n  ${missing.join('\n  ')}`);
});

test('zakladka import ma komplet elementow, ktorych szuka import.js', () => {
  // Wypisane jawnie: gdyby ktos usunal element z HTML-a, chcemy bledu tutaj,
  // a nie cichego 'null' przy pierwszym kliknieciu uzytkownika.
  const wymagane = [
    'tab-import', 'import-needs-portfolio', 'import-step-file', 'import-step-preview',
    'import-history', 'import-drop', 'import-file', 'import-paste', 'import-analyze',
    'import-reset', 'import-back', 'import-commit', 'import-shape', 'import-delimiter',
    'import-dups', 'import-summary', 'import-detected', 'import-target',
    'import-mapping', 'import-problems', 'import-problems-wrap', 'import-samples',
    'tbl-import-batches',
  ];
  const missing = wymagane.filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `brak w index.html: ${missing.join(', ')}`);
});

test('przycisk zakladki import ma swoj panel', () => {
  const tabs = [...HTML.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(tabs.includes('import'), 'brak przycisku zakladki import');
  for (const tab of tabs) {
    assert.ok(htmlIds.has(`tab-${tab}`), `przycisk zakladki '${tab}' nie ma sekcji #tab-${tab}`);
  }
});

// ---------------------------------------------------------------- tlumaczenia

test('kazdy klucz t() z kodu ma tresc w obu jezykach', () => {
  const brakPl = [];
  const brakEn = [];
  for (const file of SCRIPTS) {
    const source = read(file);
    for (const match of source.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) {
      const key = match[1];
      if (!PL.has(key)) brakPl.push(`${file}: ${key}`);
      if (!EN.has(key)) brakEn.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(brakPl, [], `klucze bez tlumaczenia PL:\n  ${brakPl.join('\n  ')}`);
  assert.deepEqual(brakEn, [], `klucze bez tlumaczenia EN:\n  ${brakEn.join('\n  ')}`);
});

test('kazdy data-i18n z HTML-a ma tresc w obu jezykach', () => {
  const brak = [];
  for (const match of HTML.matchAll(/data-i18n(?:-title|-placeholder|-aria)?="([^"]+)"/g)) {
    const key = match[1];
    if (!PL.has(key)) brak.push(`PL: ${key}`);
    if (!EN.has(key)) brak.push(`EN: ${key}`);
  }
  assert.deepEqual(brak, [], `atrybuty bez tlumaczenia:\n  ${brak.join('\n  ')}`);
});

test('klucze budowane dynamicznie tez maja tlumaczenia', () => {
  // import.js sklada klucze w locie: t(`import.f.${field}`), t(`import.status.${status}`),
  // t(`import.kind.${kind}`). Statyczna analiza ich nie zlapie, wiec sprawdzamy jawnie.
  const dynamiczne = [
    ...['date', 'ticker', 'side', 'qty', 'price', 'fee', 'currency', 'name', 'note', 'amount', 'type', 'avgPrice']
      .map((f) => `import.f.${f}`),
    ...['ok', 'duplicate', 'update'].map((s) => `import.status.${s}`),
    ...['transactions', 'cashflows', 'holdings'].map((k) => `import.kind.${k}`),
  ];
  for (const key of dynamiczne) {
    assert.ok(PL.has(key), `brak PL: ${key}`);
    assert.ok(EN.has(key), `brak EN: ${key}`);
  }
});

test('kody bledow z serwera maja odpowiednik w katalogu importu', () => {
  // Wiersz odrzucony wraca z kodem walidatora ledgeru. Kazdy taki kod, ktory moze
  // wyjsc z importu, musi miec zdanie po ludzku - inaczej uzytkownik zobaczy 'invalid_side'.
  const kody = [
    'invalid_date', 'invalid_side', 'invalid_ticker', 'invalid_number',
    'number_must_be_positive', 'number_must_not_be_zero', 'number_out_of_range',
    'invalid_currency', 'invalid_type', 'import_row_invalid', 'unknown',
  ];
  for (const code of kody) {
    assert.ok(PL.has(`import.err.${code}`), `brak PL dla kodu ${code}`);
    assert.ok(EN.has(`import.err.${code}`), `brak EN dla kodu ${code}`);
  }
});

// ---------------------------------------------------------------- statyki

test('kazdy plik frontendu jest na liscie serwowanych przez serwer', () => {
  // Whitelist w server.mjs jest zamknieta - plik spoza niej zwroci 404 i strona
  // przestanie sie ladowac, mimo ze lezy na dysku.
  const server = read('server.mjs');
  const whitelist = server.slice(server.indexOf('const STATIC_PAGES'), server.indexOf(']);', server.indexOf('const STATIC_PAGES')));
  for (const file of fs.readdirSync(path.join(ROOT, 'public'))) {
    assert.ok(whitelist.includes(`'${file}'`), `plik public/${file} nie jest w STATIC_PAGES w server.mjs`);
  }
});

test('kazdy modul importowany przez app.js istnieje', () => {
  for (const file of SCRIPTS) {
    const source = read(file);
    for (const match of source.matchAll(/from\s+'\.\/([a-zA-Z0-9_.-]+)'/g)) {
      assert.ok(
        fs.existsSync(path.join(ROOT, 'public', match[1])),
        `${file} importuje nieistniejacy public/${match[1]}`,
      );
    }
  }
});
