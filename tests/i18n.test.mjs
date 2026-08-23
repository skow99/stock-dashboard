// tests/i18n.test.mjs - spojnosc katalogow tlumaczen (serwer i frontend) oraz negocjacja jezyka.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MESSAGES, CSV_HEADERS, DEFAULTS, LOCALES, negotiateLocale, errorMessage, interpolate } from '../src/i18n.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function keyDiff(a, b) {
  const ka = new Set(Object.keys(a));
  const kb = new Set(Object.keys(b));
  return {
    onlyInA: [...ka].filter((k) => !kb.has(k)),
    onlyInB: [...kb].filter((k) => !ka.has(k)),
  };
}

// ---------------------------------------------------------------- katalog serwera

test('katalogi serwera maja identyczne klucze we wszystkich jezykach', () => {
  const diff = keyDiff(MESSAGES.pl, MESSAGES.en);
  assert.deepEqual(diff.onlyInA, [], `brak tlumaczenia EN dla: ${diff.onlyInA.join(', ')}`);
  assert.deepEqual(diff.onlyInB, [], `brak tlumaczenia PL dla: ${diff.onlyInB.join(', ')}`);
  assert.ok(Object.keys(MESSAGES.pl).length > 40);
});

test('placeholdery sa takie same w obu jezykach', () => {
  const placeholders = (text) => (String(text).match(/\{(\w+)\}/g) ?? []).sort().join(',');
  for (const key of Object.keys(MESSAGES.pl)) {
    assert.equal(
      placeholders(MESSAGES.pl[key]),
      placeholders(MESSAGES.en[key]),
      `rozne placeholdery w kluczu ${key}`,
    );
  }
});

test('naglowki CSV i nazwy domyslne sa kompletne', () => {
  assert.deepEqual(keyDiff(CSV_HEADERS.pl, CSV_HEADERS.en), { onlyInA: [], onlyInB: [] });
  assert.deepEqual(keyDiff(DEFAULTS.pl, DEFAULTS.en), { onlyInA: [], onlyInB: [] });
  assert.notEqual(DEFAULTS.pl.defaultPortfolioName, DEFAULTS.en.defaultPortfolioName);
});

// ---------------------------------------------------------------- negocjacja

test('negocjacja jezyka po Accept-Language', () => {
  assert.equal(negotiateLocale('en-GB,en;q=0.9,pl;q=0.8'), 'en');
  assert.equal(negotiateLocale('pl-PL,pl;q=0.9,en;q=0.8'), 'pl');
  assert.equal(negotiateLocale('de-DE,de;q=0.9'), 'pl');        // nieobslugiwany -> domyslny
  assert.equal(negotiateLocale(''), 'pl');
  assert.equal(negotiateLocale(undefined), 'pl');
  assert.equal(negotiateLocale('en'), 'en');
});

test('jawny parametr lang ma pierwszenstwo nad naglowkiem', () => {
  assert.equal(negotiateLocale('en-GB,en;q=0.9', 'pl'), 'pl');
  assert.equal(negotiateLocale('pl-PL', 'en'), 'en');
  assert.equal(negotiateLocale('pl-PL', 'de'), 'pl');           // nieznany override jest ignorowany
});

test('wagi q sa respektowane niezaleznie od kolejnosci', () => {
  assert.equal(negotiateLocale('pl;q=0.2,en;q=0.9'), 'en');
  assert.equal(negotiateLocale('en;q=0.1,pl;q=0.7'), 'pl');
});

// ---------------------------------------------------------------- komunikaty

test('komunikat bledu z interpolacja', () => {
  assert.equal(errorMessage('invalid_date', 'pl', { field: 'date' }), 'Pole date musi miec format YYYY-MM-DD');
  assert.equal(errorMessage('invalid_date', 'en', { field: 'date' }), 'Field date must use the YYYY-MM-DD format');
  assert.match(errorMessage('weak_password', 'en', { min: 10 }), /at least 10 characters/);
});

test('nieznany kod nie ma komunikatu - warstwa HTTP uzyje tresci wyjatku', () => {
  assert.equal(errorMessage('nie_ma_takiego_kodu', 'pl'), null);
});

test('brakujacy parametr zostawia placeholder zamiast wstawiac undefined', () => {
  assert.equal(interpolate('Pole {field} jest zle', {}), 'Pole {field} jest zle');
  assert.equal(interpolate('Pole {field} jest zle', { field: 'qty' }), 'Pole qty jest zle');
});

// ---------------------------------------------------------------- katalog frontendu

test('katalog frontendu ma identyczne klucze we wszystkich jezykach', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'i18n.js'), 'utf8');
  // Modul frontendu uzywa localStorage/navigator, wiec parsujemy sam katalog zamiast go importowac.
  const dictSource = source.slice(source.indexOf('const DICT = {'), source.indexOf('\n};', source.indexOf('const DICT = {')) + 3);
  const errSource = source.slice(source.indexOf('const ERRORS = {'), source.indexOf('\n};', source.indexOf('const ERRORS = {')) + 3);
  // eslint-disable-next-line no-new-func
  const { DICT, ERRORS } = new Function(`${dictSource}\n${errSource}\nreturn { DICT, ERRORS };`)();

  for (const [name, catalog] of [['DICT', DICT], ['ERRORS', ERRORS]]) {
    const diff = keyDiff(catalog.pl, catalog.en);
    assert.deepEqual(diff.onlyInA, [], `${name}: brak tlumaczenia EN dla ${diff.onlyInA.join(', ')}`);
    assert.deepEqual(diff.onlyInB, [], `${name}: brak tlumaczenia PL dla ${diff.onlyInB.join(', ')}`);
  }
  assert.ok(Object.keys(DICT.pl).length > 150, 'katalog UI powinien pokrywac caly interfejs');
  assert.deepEqual(Object.keys(DICT).sort(), [...LOCALES].sort());
});

test('kazdy klucz data-i18n z HTML istnieje w katalogu frontendu', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'i18n.js'), 'utf8');
  const dictSource = source.slice(source.indexOf('const DICT = {'), source.indexOf('\n};', source.indexOf('const DICT = {')) + 3);
  // eslint-disable-next-line no-new-func
  const { DICT } = new Function(`${dictSource}\nreturn { DICT };`)();

  const missing = [];
  for (const file of fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
    for (const match of html.matchAll(/data-i18n(?:-title|-placeholder|-aria)?="([^"]+)"/g)) {
      for (const locale of LOCALES) {
        if (DICT[locale][match[1]] === undefined) missing.push(`${file}: ${match[1]} (${locale})`);
      }
    }
  }
  assert.deepEqual(missing, [], `brakujace tlumaczenia: ${missing.join('; ')}`);
});

test('kazdy klucz t(...) uzyty w JS istnieje w katalogu', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'i18n.js'), 'utf8');
  const dictSource = source.slice(source.indexOf('const DICT = {'), source.indexOf('\n};', source.indexOf('const DICT = {')) + 3);
  // eslint-disable-next-line no-new-func
  const { DICT } = new Function(`${dictSource}\nreturn { DICT };`)();

  const missing = [];
  for (const file of ['app.js', 'auth.js', 'share.js', 'charts.js', 'ui.js']) {
    const js = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
    for (const match of js.matchAll(/\bt\('([a-zA-Z][\w.]*)'/g)) {
      for (const locale of LOCALES) {
        if (DICT[locale][match[1]] === undefined) missing.push(`${file}: ${match[1]} (${locale})`);
      }
    }
  }
  assert.deepEqual(missing, [], `brakujace tlumaczenia: ${missing.join('; ')}`);
});
