// tests/market-sector.test.mjs - wyszukiwanie sektora tickera (Yahoo assetProfile).
//
// Przed tym modulem nic nie wypelnialo tabeli 'sectors' - kazda pozycja wisiala
// pod 'Other' na zawsze. Testy nie ruszaja sieci - podmieniaja globalny fetch.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-sector-'));
process.env.SD_DATA_DIR = TMP;
process.env.SD_DB_PATH = path.join(TMP, 'test.db');
// Patrz komentarz w market-providers.test.mjs: CI ustawia SD_OFFLINE=1 globalnie,
// a tu wlasnie testujemy zachowanie wobec odpowiedzi sieci (atrapy).
process.env.SD_OFFLINE = '0';

const { getSector, getSectorsFor } = await import('../src/market/sector.mjs');

function udajFetch(status, body) {
  const licznik = { wywolan: 0 };
  globalThis.fetch = async () => {
    licznik.wywolan += 1;
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return licznik;
}
const oryginalnyFetch = globalThis.fetch;

globalThis.fetch = async (url) => {
  throw new Error(`test siegnal po prawdziwa siec: ${url}. Uzyj udajFetch() przed wywolaniem.`);
};

test.after(() => {
  globalThis.fetch = oryginalnyFetch;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const assetProfile = (sector) => JSON.stringify({ quoteSummary: { result: [{ assetProfile: { sector } }], error: null } });

test('sektor odczytany z assetProfile Yahoo', async () => {
  udajFetch(200, assetProfile('Technology'));
  const sector = await getSector('SEKT1.US');
  assert.equal(sector, 'Technology');
});

test('ETF bez assetProfile daje null, a nie wyjatek', async () => {
  udajFetch(200, JSON.stringify({ quoteSummary: { result: [{}], error: null } }));
  const sector = await getSector('SEKT2.US');
  assert.equal(sector, null);
});

test('blad sieci daje null, a nie wyjatek', async () => {
  udajFetch(500, 'blad serwera');
  const sector = await getSector('SEKT3.US');
  assert.equal(sector, null);
});

test('drugie zapytanie o ten sam ticker nie rusza sieci - trafia w cache', async () => {
  const licznik = udajFetch(200, assetProfile('Healthcare'));
  const pierwszy = await getSector('SEKT4.US');
  const przedDrugim = licznik.wywolan;
  const drugi = await getSector('SEKT4.US');
  assert.equal(pierwszy, 'Healthcare');
  assert.equal(drugi, 'Healthcare');
  assert.equal(licznik.wywolan, przedDrugim, 'wynik z cache nie moze odpytywac sieci ponownie');
});

test('klucz cache ignoruje sufiks gieldy, tak jak reszta systemu', async () => {
  udajFetch(200, assetProfile('Energy'));
  await getSector('SEKT5.WA');
  const licznik = udajFetch(200, assetProfile('cos-innego-gdyby-poszlo-do-sieci'));
  const sector = await getSector('SEKT5.US');
  assert.equal(sector, 'Energy');
  assert.equal(licznik.wywolan, 0, 'ten sam klucz porownawczy ma trafic w cache bez wzgledu na sufiks');
});

test('wsad symboli zwraca mape sektorow tylko dla rozpoznanych tickerow', async () => {
  globalThis.fetch = async (url) => {
    const symbol = decodeURIComponent(String(url)).match(/quoteSummary\/([^?]+)/)?.[1] ?? '';
    if (symbol === 'SEKT6') return { ok: true, status: 200, text: async () => assetProfile('Industrials') };
    return { ok: true, status: 200, text: async () => JSON.stringify({ quoteSummary: { result: [{}], error: null } }) };
  };
  const found = await getSectorsFor(['SEKT6.US', 'SEKT7.US']);
  assert.equal(found.get('SEKT6'), 'Industrials');
  assert.equal(found.has('SEKT7'), false);
});
