// tests/market-providers.test.mjs - odpornosc warstwy zrodel rynkowych.
//
// Powstal po awarii z sierpnia 2026: Stooq zaczal oddawac na kodzie 200 strone
// antybotowa z zagadka JavaScript. Kod liczyl ja jako udana odpowiedz, kasowal
// licznik bezpiecznika i odpytywal martwe zrodlo w kolko, a uzytkownik widzial
// na stronie komunikat, ktorego przyczyny nie bylo w logu.
//
// Testy nie ruszaja sieci - podmieniaja globalny fetch.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-market-'));
process.env.SD_DATA_DIR = TMP;
process.env.SD_DB_PATH = path.join(TMP, 'test.db');
// Patrz komentarz w history-rebuild.test.mjs: CI ustawia SD_OFFLINE=1 globalnie,
// a w tym trybie fetchText konczy sie zanim zdazy uzyc podmienionego fetch.
// Tu testujemy wlasnie zachowanie fetchText wobec odpowiedzi zrodla, wiec
// tryb offline trzeba wylaczyc. Sieci i tak nie ruszamy - fetch jest atrapa.
process.env.SD_OFFLINE = '0';

const { fetchText, breakerState } = await import('../src/market/providers.mjs');
const { wygladaJakCsv } = await import('../src/market/quotes.mjs');

/** Podmienia fetch na stala odpowiedz i zwraca licznik wywolan. */
function udajFetch(status, body) {
  const licznik = { wywolan: 0 };
  globalThis.fetch = async () => {
    licznik.wywolan += 1;
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return licznik;
}
const oryginalnyFetch = globalThis.fetch;

// Siatka bezpieczenstwa: gdyby ktorykolwiek test siegnal po siec bez wczesniejszego
// udajFetch(), ma to glosno paść, a nie po cichu wyslac prawdziwe zadanie z CI.
globalThis.fetch = async (url) => {
  throw new Error(`test siegnal po prawdziwa siec: ${url}. Uzyj udajFetch() przed wywolaniem.`);
};

test.after(() => {
  globalThis.fetch = oryginalnyFetch;
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------- rozpoznanie tresci

test('strona antybotowa Stooq nie jest brana za CSV', () => {
  // Prawdziwa odpowiedz z https://stooq.pl/q/d/l/?s=cdr&i=d z 23.08.2026
  const antybot = '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<meta name="robots" content="noindex,nofollow"></head><body><noscript>'
    + 'This site requires JavaScript to verify your browser. Please enable JavaScript and reload.'
    + '</noscript><script nonce="xNeyC6lOQSk0U7DP21E3sg">(async()=>{const c="AAAA",d=4</script></body></html>';
  assert.equal(wygladaJakCsv(antybot), false);
});

test('blad bazy danych po stronie Stooq nie jest brany za CSV', () => {
  const phpBlad = '<br />\n<b>Warning</b>:  mysqli_query() expects parameter 1 to be mysqli, null given in <b>/x.php</b>';
  assert.equal(wygladaJakCsv(phpBlad), false);
});

test('prawdziwy CSV przechodzi', () => {
  assert.equal(wygladaJakCsv('Symbol,Date,Time,Open,High,Low,Close,Volume\nCDR,2026-08-21,17:00:00,255,259,254,258.7,120000'), true);
  assert.equal(wygladaJakCsv('Date,Open,High,Low,Close,Volume\n2026-08-21,255,259,254,258.7,120000'), true);
});

test('pusta odpowiedz nie jest CSV', () => {
  assert.equal(wygladaJakCsv(''), false);
  assert.equal(wygladaJakCsv('   \n  '), false);
});

// ---------------------------------------------------------------- bezpiecznik

test('odpowiedz 200 z niepoprawna trescia liczy sie jako AWARIA zrodla', async () => {
  // To jest sedno: bez tego licznik bezpiecznika byl zerowany przy kazdej probie,
  // wiec bezpiecznik nigdy sie nie otwieral i martwe zrodlo bylo odpytywane bez konca.
  const dostawca = `test-antybot-${Date.now()}`;
  udajFetch(200, '<!DOCTYPE html><html><script>proof of work</script></html>');

  const wynik = await fetchText(dostawca, 'https://przyklad.test/dane.csv', { looksValid: wygladaJakCsv });
  assert.equal(wynik, null, 'niepoprawna tresc musi dac null, a nie HTML do parsowania');
  assert.ok(breakerState(dostawca).failures > 0, 'awaria musi byc policzona');
});

test('bezpiecznik otwiera sie po serii nieudanych prob i przestaje odpytywac', async () => {
  const dostawca = `test-seria-${Date.now()}`;
  const licznik = udajFetch(200, '<html>antybot</html>');

  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await fetchText(dostawca, 'https://przyklad.test/dane.csv', { looksValid: wygladaJakCsv });
  }
  assert.equal(breakerState(dostawca).open, true, 'po 4 awariach zrodlo ma byc odciete');

  const przed = licznik.wywolan;
  await fetchText(dostawca, 'https://przyklad.test/dane.csv', { looksValid: wygladaJakCsv });
  assert.equal(licznik.wywolan, przed, 'przy otwartym bezpieczniku nie wolno ruszac sieci');
});

test('poprawna odpowiedz zeruje licznik awarii', async () => {
  const dostawca = `test-powrot-${Date.now()}`;
  udajFetch(200, '<html>antybot</html>');
  await fetchText(dostawca, 'https://przyklad.test/dane.csv', { looksValid: wygladaJakCsv });
  assert.ok(breakerState(dostawca).failures > 0);

  udajFetch(200, 'Symbol,Close\nCDR,258.7');
  const wynik = await fetchText(dostawca, 'https://przyklad.test/dane.csv', { looksValid: wygladaJakCsv });
  assert.match(wynik, /CDR,258\.7/);
  assert.equal(breakerState(dostawca).failures, 0, 'po sukcesie licznik ma wrocic do zera');
});

test('bez walidatora tresci zachowanie zostaje bez zmian', async () => {
  // Yahoo zwraca JSON i idzie przez fetchJson - nie chcemy mu niczego narzucac.
  const dostawca = `test-bez-walidacji-${Date.now()}`;
  udajFetch(200, '<html>cokolwiek</html>');
  const wynik = await fetchText(dostawca, 'https://przyklad.test/x');
  assert.equal(wynik, '<html>cokolwiek</html>');
  assert.equal(breakerState(dostawca).failures, 0);
});

// ---------------------------------------------------------------- kolejnosc zrodel

test('Yahoo jest pierwszym zrodlem w lancuchu', async () => {
  // Stooq zostaje jako zapas, ale nie moze byc pytany pierwszy: jego endpoint
  // biezacych notowan zwraca 404, a dzienny jest za zabezpieczeniem antybotowym.
  const source = fs.readFileSync(new URL('../src/market/quotes.mjs', import.meta.url), 'utf8');
  const lancuch = /const LANCUCH = \[([^\]]+)\]/.exec(source);
  assert.ok(lancuch, 'nie znalazlem definicji lancucha zrodel');
  const kolejnosc = lancuch[1].split(',').map((s) => s.trim());
  assert.equal(kolejnosc[0], 'fromYahoo', `Yahoo musi byc pierwsze, jest: ${kolejnosc.join(' -> ')}`);
});

test('kod nie honoruje juz domyslnego source ze slownika holdingow', () => {
  // 'stooq' trafia do holdings_baseline AUTOMATYCZNIE jako wartosc domyslna.
  // Gdyby nadal sterowalo kolejnoscia, kazdy portfel zaczynalby od martwego zrodla.
  const source = fs.readFileSync(new URL('../src/market/quotes.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /preferSource/, 'preferSource ma byc usuniete z warstwy notowan');
});
