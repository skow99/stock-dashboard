// tests/history-rebuild.test.mjs - odtwarzanie historii wartosci portfela wstecz.
//
// Najwazniejszy test to ten na koncu: odtworzona wartosc ostatniego dnia musi zgadzac
// sie co do grosza z silnikiem, ktory liczy widok biezacy. Gdyby byly to dwie rozne
// arytmetyki, wykres mialby uskok dokladnie w dniu dzisiejszym.
//
// Zero ruchu sieciowego - globalny fetch jest podmieniany na syntetyczne notowania.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-rebuild-'));
process.env.SD_DATA_DIR = TMP;
process.env.SD_DB_PATH = path.join(TMP, 'test.db');
// SD_OFFLINE musi byc WYLACZONE, mimo ze CI ustawia je globalnie na 1.
// W trybie offline fetchText/fetchJson zwracaja null, ZANIM dojda do podmienionego
// fetch - mocki nigdy by sie nie wykonaly. Ten plik nie rusza sieci: globalny fetch
// jest zastapiony w calosci i nie ma sciezki, ktora przepuscilaby prawdziwe zadanie.
process.env.SD_OFFLINE = '0';

const { getDb, newId, nowIso } = await import('../src/db.mjs');
const { insertTransaction, insertCashFlow, listHistory, listTransactions, listBaseline } = await import('../src/ledger.mjs');
const { rebuildPortfolioHistory } = await import('../src/history-rebuild.mjs');
const { replayLedger } = await import('../src/calc/engine.mjs');
const { getFxHistory, ratesForDay, fxToPln } = await import('../src/market/fx.mjs');
const { getDailyCloses } = await import('../src/market/history.mjs');
const { todayWarsaw, addDays, isWeekend } = await import('../src/dates.mjs');

// ---------------------------------------------------------------- syntetyczne zrodlo

const DZIS = todayWarsaw();
const START = addDays(DZIS, -40);

/** Notowania tylko w dni robocze - weekendy maja byc uzupelniane przeniesieniem. */
function seriaRobocza(od, doDnia, cenaDlaDnia) {
  const timestamp = [];
  const close = [];
  for (let d = od; d <= doDnia; d = addDays(d, 1)) {
    if (isWeekend(d)) continue;
    timestamp.push(Math.floor(new Date(`${d}T12:00:00Z`).getTime() / 1000));
    close.push(cenaDlaDnia(d));
  }
  return { timestamp, close };
}

const CENY = {
  'CDR.WA': (d) => 100 + (Number(d.slice(-2)) % 10),   // 100..109, zmienne
  'AAPL': (d) => 200 + (Number(d.slice(-2)) % 5),      // Yahoo dla .US tnie sufiks
  'USDPLN=X': () => 4.0,
  'EURPLN=X': () => 4.3,
  'SEKPLN=X': () => 0.38,
  'GBPPLN=X': () => 5.0,
  'CHFPLN=X': () => 4.6,
};

let liczbaZapytan = 0;
const zapytaneSymbole = [];

globalThis.fetch = async (url) => {
  liczbaZapytan += 1;
  const symbol = decodeURIComponent(String(url).split('/chart/')[1]?.split('?')[0] ?? '');
  zapytaneSymbole.push(symbol);
  const generator = CENY[symbol];
  if (!generator) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ chart: { result: null } }) };
  }
  const { timestamp, close } = seriaRobocza(addDays(START, -10), DZIS, generator);
  const body = {
    chart: {
      result: [{
        meta: { regularMarketPrice: close[close.length - 1], currency: 'PLN' },
        timestamp,
        indicators: { quote: [{ close }] },
      }],
    },
  };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

// ---------------------------------------------------------------- srodowisko

let userId;
function nowyPortfel(nazwa = 'Test') {
  const db = getDb();
  const at = nowIso();
  if (!userId) {
    userId = newId('u_');
    db.prepare('INSERT INTO users (id,email,display_name,password_hash,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(userId, 'rebuild@test.local', 'T', 'x', 'owner', 'active', at, at);
  }
  const pid = newId('p_');
  db.prepare('INSERT INTO portfolios (id,user_id,name,slug,base_currency,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(pid, userId, nazwa, `s-${pid.slice(-8)}`, 'PLN', at, at);
  return pid;
}
const ctx = () => ({ userId, ip: '127.0.0.1' });

// ---------------------------------------------------------------- testy

test('pusty portfel nie generuje historii', async () => {
  const pid = nowyPortfel();
  const wynik = await rebuildPortfolioHistory(pid);
  assert.equal(wynik.days, 0);
  assert.equal(listHistory([pid]).length, 0);
});

test('historia obejmuje kazdy dzien od pierwszego zdarzenia do dzis', async () => {
  const pid = nowyPortfel();
  insertCashFlow(pid, { date: START, type: 'Deposit', amount: 50000, currency: 'PLN' }, ctx());
  insertTransaction(pid, { date: addDays(START, 3), ticker: 'CDR.WA', side: 'BUY', qty: 100, price: 100, currency: 'PLN' }, ctx());

  const wynik = await rebuildPortfolioHistory(pid);
  const historia = listHistory([pid]);

  assert.equal(wynik.from, START);
  assert.equal(wynik.to, DZIS);
  assert.equal(historia[0].day, START);
  assert.equal(historia[historia.length - 1].day, DZIS);

  // Dni kalendarzowe, nie tylko sesyjne - portfel ma wartosc rowniez w sobote.
  let oczekiwane = 0;
  for (let d = START; d <= DZIS; d = addDays(d, 1)) oczekiwane += 1;
  assert.equal(historia.length, oczekiwane, 'brakuje dni w historii');
});

test('przed pierwszym zakupem portfel to sama gotowka', async () => {
  const pid = nowyPortfel();
  insertCashFlow(pid, { date: START, type: 'Deposit', amount: 50000, currency: 'PLN' }, ctx());
  insertTransaction(pid, { date: addDays(START, 5), ticker: 'CDR.WA', side: 'BUY', qty: 100, price: 100, currency: 'PLN' }, ctx());
  await rebuildPortfolioHistory(pid);

  const historia = listHistory([pid]);
  const przedZakupem = historia.find((h) => h.day === addDays(START, 2));
  assert.equal(przedZakupem.investedPln, 0);
  assert.equal(przedZakupem.cashPln, 50000);
  assert.equal(przedZakupem.totalPln, 50000);
});

test('zakup przenosi wartosc z gotowki do pozycji', async () => {
  const pid = nowyPortfel();
  const dzienZakupu = addDays(START, 5);
  insertCashFlow(pid, { date: START, type: 'Deposit', amount: 50000, currency: 'PLN' }, ctx());
  insertTransaction(pid, { date: dzienZakupu, ticker: 'CDR.WA', side: 'BUY', qty: 100, price: 100, fee: 10, currency: 'PLN' }, ctx());
  await rebuildPortfolioHistory(pid);

  const historia = listHistory([pid]);
  const po = historia.find((h) => h.day === dzienZakupu);
  assert.equal(po.cashPln, 50000 - (100 * 100 + 10), 'gotowka pomniejszona o wartosc i prowizje');
  assert.ok(po.investedPln > 0, 'pozycja ma wycene');
});

test('weekend dostaje przeniesiona cene z piatku, a nie zero', async () => {
  const pid = nowyPortfel();
  insertCashFlow(pid, { date: START, type: 'Deposit', amount: 50000, currency: 'PLN' }, ctx());
  insertTransaction(pid, { date: addDays(START, 1), ticker: 'CDR.WA', side: 'BUY', qty: 100, price: 100, currency: 'PLN' }, ctx());
  await rebuildPortfolioHistory(pid);

  const historia = listHistory([pid]);
  const weekendy = historia.filter((h) => isWeekend(h.day) && h.day > addDays(START, 1));
  assert.ok(weekendy.length >= 2, 'test wymaga co najmniej jednego weekendu w zakresie');
  for (const dzien of weekendy) {
    assert.ok(dzien.investedPln > 0, `weekend ${dzien.day} stracil wycene pozycji`);
  }
});

test('pozycja w obcej walucie wyceniana kursem z danego dnia', async () => {
  const pid = nowyPortfel();
  insertCashFlow(pid, { date: START, type: 'Deposit', amount: 50000, currency: 'PLN' }, ctx());
  insertTransaction(pid, { date: addDays(START, 2), ticker: 'AAPL.US', side: 'BUY', qty: 10, price: 200, currency: 'USD' }, ctx());
  await rebuildPortfolioHistory(pid);

  const historia = listHistory([pid]);
  const badany = addDays(START, 10);
  const dzien = historia.find((h) => h.day === badany);
  const fxHistory = await getFxHistory();
  const seria = await getDailyCloses('AAPL.US');

  // Kurs musimy PRZENIESC tak samo, jak robi to silnik: idac dzien po dniu od poczatku.
  // Wolanie ratesForDay z pusta mapa dawaloby kurs awaryjny, gdy badany dzien wypadnie
  // w weekend - a to zalezy od tego, w ktory dzien tygodnia akurat uruchomiono testy.
  const ostatnieZnane = {};
  for (let d = START; d <= badany; d = addDays(d, 1)) ratesForDay(fxHistory, d, ostatnieZnane);
  const kurs = ratesForDay(fxHistory, badany, ostatnieZnane).USDPLN;

  // Wartosc pozycji = ilosc * cena z tego dnia * kurs z tego dnia
  const dni = Object.keys(seria.byDay).filter((d) => d <= badany).sort();
  const cena = seria.byDay[dni[dni.length - 1]];
  assert.ok(Math.abs(dzien.investedPln - 10 * cena * kurs) < 0.01,
    `wycena ${dzien.investedPln} != 10 * ${cena} * ${kurs}`);
});

test('sprzedaz zmniejsza pozycje i zwieksza gotowke', async () => {
  const pid = nowyPortfel();
  insertCashFlow(pid, { date: START, type: 'Deposit', amount: 50000, currency: 'PLN' }, ctx());
  insertTransaction(pid, { date: addDays(START, 2), ticker: 'CDR.WA', side: 'BUY', qty: 100, price: 100, currency: 'PLN' }, ctx());
  insertTransaction(pid, { date: addDays(START, 20), ticker: 'CDR.WA', side: 'SELL', qty: 40, price: 110, currency: 'PLN' }, ctx());
  await rebuildPortfolioHistory(pid);

  const historia = listHistory([pid]);
  const przed = historia.find((h) => h.day === addDays(START, 19));
  const po = historia.find((h) => h.day === addDays(START, 20));
  assert.ok(po.cashPln > przed.cashPln, 'sprzedaz musi podniesc gotowke');
  assert.ok(po.investedPln < przed.investedPln, 'sprzedaz musi zmniejszyc pozycje');
  assert.ok(Math.abs(po.cashPln - (przed.cashPln + 40 * 110)) < 0.01);
});

test('powtorne przeliczenie daje ten sam wynik i nie mnozy wierszy', async () => {
  const pid = nowyPortfel();
  insertCashFlow(pid, { date: START, type: 'Deposit', amount: 10000, currency: 'PLN' }, ctx());
  insertTransaction(pid, { date: addDays(START, 2), ticker: 'CDR.WA', side: 'BUY', qty: 10, price: 100, currency: 'PLN' }, ctx());

  const pierwsze = await rebuildPortfolioHistory(pid);
  const historia1 = listHistory([pid]);
  const drugie = await rebuildPortfolioHistory(pid);
  const historia2 = listHistory([pid]);

  assert.equal(drugie.days, pierwsze.days);
  assert.equal(historia2.length, historia1.length, 'upsert nie moze dokladac wierszy');
  assert.equal(historia2[historia2.length - 1].totalPln, historia1[historia1.length - 1].totalPln);
});

test('wpisy sa oznaczone jako odtworzone', async () => {
  const pid = nowyPortfel();
  insertCashFlow(pid, { date: START, type: 'Deposit', amount: 1000, currency: 'PLN' }, ctx());
  await rebuildPortfolioHistory(pid);
  const wiersz = getDb().prepare('SELECT source FROM portfolio_history WHERE portfolio_id = ? LIMIT 1').get(pid);
  assert.equal(wiersz.source, 'rebuilt');
});

test('notowania pobierane sa raz na ticker, nie raz na dzien', async () => {
  // Sedno wymagania "rob cache zawsze": 40 dni historii to jedno zapytanie,
  // a nie czterdziesci. Cache jest wspolny dla instancji, wiec drugi portfel
  // z tym samym tickerem nie rusza siec w ogole.
  const pid = nowyPortfel();
  insertCashFlow(pid, { date: START, type: 'Deposit', amount: 10000, currency: 'PLN' }, ctx());
  insertTransaction(pid, { date: addDays(START, 1), ticker: 'CDR.WA', side: 'BUY', qty: 10, price: 100, currency: 'PLN' }, ctx());

  zapytaneSymbole.length = 0;
  await rebuildPortfolioHistory(pid);
  const cdrPierwszy = zapytaneSymbole.filter((s) => s === 'CDR.WA').length;
  assert.ok(cdrPierwszy <= 1, `CDR.WA pobrane ${cdrPierwszy} razy przy jednym przebiegu`);

  const pid2 = nowyPortfel('Drugi');
  insertCashFlow(pid2, { date: START, type: 'Deposit', amount: 10000, currency: 'PLN' }, ctx());
  insertTransaction(pid2, { date: addDays(START, 1), ticker: 'CDR.WA', side: 'BUY', qty: 5, price: 100, currency: 'PLN' }, ctx());

  zapytaneSymbole.length = 0;
  await rebuildPortfolioHistory(pid2);
  assert.equal(zapytaneSymbole.filter((s) => s === 'CDR.WA').length, 0,
    'drugi portfel musi wziac notowania z cache wspolnego');
});

test('ticker bez notowan jest zglaszany, a nie pomijany po cichu', async () => {
  // Symbol spoza slownika CENY - atrapa oddaje pusty wykres, jak Yahoo dla literowki.
  // Bez tego zgloszenia uzytkownik widzi pusty wykres i nie ma czego szukac.
  const pid = nowyPortfel();
  insertCashFlow(pid, { date: START, type: 'Deposit', amount: 10000, currency: 'PLN' }, ctx());
  insertTransaction(pid, { date: addDays(START, 1), ticker: 'NIEMA.WA', side: 'BUY', qty: 10, price: 50, currency: 'PLN' }, ctx());

  const wynik = await rebuildPortfolioHistory(pid);
  assert.deepEqual(wynik.missing, ['NIEMA.WA'], 'brakujacy ticker musi trafic do raportu');

  const zrodlo = wynik.sources.find((z) => z.ticker === 'NIEMA.WA');
  assert.equal(zrodlo.ok, false);
  assert.equal(zrodlo.points, 0);
});

test('raport zrodel pokazuje liczbe notowan dla tickera, ktory ma dane', async () => {
  const pid = nowyPortfel();
  insertCashFlow(pid, { date: START, type: 'Deposit', amount: 10000, currency: 'PLN' }, ctx());
  insertTransaction(pid, { date: addDays(START, 1), ticker: 'CDR.WA', side: 'BUY', qty: 10, price: 100, currency: 'PLN' }, ctx());

  const wynik = await rebuildPortfolioHistory(pid);
  assert.deepEqual(wynik.missing, []);
  const zrodlo = wynik.sources.find((z) => z.ticker === 'CDR.WA');
  assert.equal(zrodlo.ok, true);
  assert.ok(zrodlo.points > 20, `spodziewalem sie serii dziennej, jest ${zrodlo.points} punktow`);
  assert.ok(zrodlo.first && zrodlo.last, 'raport musi podac zakres dat');
});

// ---------------------------------------------------------------- czyszczenie starych dni

test('poprawienie omylkowej daty usuwa dni, ktorych juz nie ma w ksiedze', async () => {
  // Prawdziwy przypadek: przeplyw wpisany z rokiem 2003 zamiast biezacego.
  // Sam upsert zostawialby dwadziescia lat pustego wykresu, bo nowy przebieg
  // po prostu tych dni nie dotyka.
  const pid = nowyPortfel();
  const { updateCashFlow } = await import('../src/ledger.mjs');

  const omylka = insertCashFlow(pid, { date: '2003-05-14', type: 'Deposit', amount: 10000, currency: 'PLN' }, ctx());
  await rebuildPortfolioHistory(pid);
  const przed = listHistory([pid]);
  // Zakres jest przycinany do 20 lat wstecz od DZIS, wiec zaczyna sie pozniej niz 2003,
  // ale konczy dzisiaj - swieze dane nie moga wypasc przez omylke w starej dacie.
  assert.ok(przed.length > 5000, `przygotowanie: spodziewalem sie lat historii, jest ${przed.length} dni`);
  assert.equal(przed[przed.length - 1].day, DZIS, 'przyciecie nie moze obcinac konca zakresu');

  updateCashFlow(pid, omylka.id, { date: START }, ctx());
  const wynik = await rebuildPortfolioHistory(pid);
  const po = listHistory([pid]);

  assert.equal(wynik.from, START, 'zakres ma zaczynac sie od poprawionej daty');
  assert.equal(po[0].day, START, 'pierwszy dzien historii nie zostal przesuniety');
  assert.ok(po.length < 100, `stare dni zostaly w bazie: ${po.length} wierszy`);

  const stare = getDb()
    .prepare("SELECT COUNT(*) AS n FROM portfolio_history WHERE portfolio_id = ? AND day < ?")
    .get(pid, START).n;
  assert.equal(stare, 0, 'w bazie nie moze zostac ani jeden dzien sprzed nowego zakresu');
});

test('usuniecie wszystkich zdarzen nie kasuje historii po cichu', async () => {
  // Portfel bez transakcji i przeplywow konczy sie wczesnym powrotem. Nie wolno
  // wtedy skasowac tego, co zebral zapis biezacy - to nie jest przeliczenie.
  const pid = nowyPortfel();
  const at = nowIso();
  getDb().prepare(`
    INSERT INTO portfolio_history (portfolio_id, day, total_pln, invested_pln, cash_pln, provisional, source, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, 'eod', ?)
  `).run(pid, START, 1234, 1000, 234, at);

  const wynik = await rebuildPortfolioHistory(pid);
  assert.equal(wynik.days, 0);
  assert.equal(listHistory([pid]).length, 1, 'wpis EOD musi przetrwac przebieg bez zdarzen');
});

// ---------------------------------------------------------------- niezmiennik nadrzedny

test('ostatni dzien historii zgadza sie z silnikiem widoku biezacego', async () => {
  const pid = nowyPortfel();
  insertCashFlow(pid, { date: START, type: 'Deposit', amount: 100000, currency: 'PLN' }, ctx());
  insertCashFlow(pid, { date: addDays(START, 10), type: 'Dividend', amount: 50, currency: 'USD' }, ctx());
  insertTransaction(pid, { date: addDays(START, 2), ticker: 'CDR.WA', side: 'BUY', qty: 100, price: 100, fee: 12, currency: 'PLN' }, ctx());
  insertTransaction(pid, { date: addDays(START, 4), ticker: 'AAPL.US', side: 'BUY', qty: 20, price: 200, fee: 3, currency: 'USD' }, ctx());
  insertTransaction(pid, { date: addDays(START, 25), ticker: 'CDR.WA', side: 'SELL', qty: 30, price: 108, fee: 5, currency: 'PLN' }, ctx());

  await rebuildPortfolioHistory(pid);
  const ostatni = listHistory([pid]).slice(-1)[0];

  // Ta sama arytmetyka co w snapshot.mjs, tyle ze na kursach z ostatniego dnia.
  const fxHistory = await getFxHistory();
  const ostatnieZnane = {};
  for (let d = START; d <= DZIS; d = addDays(d, 1)) ratesForDay(fxHistory, d, ostatnieZnane);
  const rates = ratesForDay(fxHistory, DZIS, ostatnieZnane);

  const ledger = replayLedger({
    transactions: listTransactions([pid]),
    baseline: listBaseline([pid]),
    fxRates: rates,
  });

  let invested = 0;
  for (const [, pozycja] of ledger.positionState) {
    if (pozycja.qty <= 1e-9) continue;
    // eslint-disable-next-line no-await-in-loop
    const seria = await getDailyCloses(pozycja.ticker);
    const dni = Object.keys(seria.byDay).filter((d) => d <= DZIS).sort();
    invested += pozycja.qty * seria.byDay[dni[dni.length - 1]] * fxToPln(rates, pozycja.currency);
  }

  const { listCashFlows } = await import('../src/ledger.mjs');
  let cash = ledger.tradeCashPln;
  for (const flow of listCashFlows([pid])) cash += (Number(flow.amount) || 0) * fxToPln(rates, flow.currency);

  assert.ok(Math.abs(ostatni.investedPln - invested) < 0.01,
    `pozycje: odtworzone ${ostatni.investedPln} vs silnik ${invested}`);
  assert.ok(Math.abs(ostatni.cashPln - cash) < 0.01,
    `gotowka: odtworzona ${ostatni.cashPln} vs silnik ${cash}`);
  assert.ok(Math.abs(ostatni.totalPln - (invested + cash)) < 0.01,
    `suma: odtworzona ${ostatni.totalPln} vs silnik ${invested + cash}`);
});

test('tradeCashByCurrency zgadza sie z tradeCashPln po przeliczeniu', async () => {
  // Ta rownosc jest fundamentem odtwarzania: historia mnozy kwoty w walutach
  // oryginalnych przez kurs z danego dnia, zamiast zamrazac przeliczenie.
  const pid = nowyPortfel();
  insertTransaction(pid, { date: addDays(START, 1), ticker: 'CDR.WA', side: 'BUY', qty: 10, price: 100, fee: 7, currency: 'PLN' }, ctx());
  insertTransaction(pid, { date: addDays(START, 2), ticker: 'AAPL.US', side: 'BUY', qty: 5, price: 200, fee: 2, currency: 'USD' }, ctx());
  insertTransaction(pid, { date: addDays(START, 9), ticker: 'AAPL.US', side: 'SELL', qty: 2, price: 210, fee: 1, currency: 'USD' }, ctx());

  const rates = { PLNPLN: 1, USDPLN: 4.1234, EURPLN: 4.3, SEKPLN: 0.38, GBPPLN: 5, CHFPLN: 4.6 };
  const ledger = replayLedger({ transactions: listTransactions([pid]), baseline: [], fxRates: rates });

  let zWalut = 0;
  for (const [waluta, kwota] of Object.entries(ledger.tradeCashByCurrency)) {
    zWalut += kwota * fxToPln(rates, waluta);
  }
  assert.ok(Math.abs(zWalut - ledger.tradeCashPln) < 1e-6,
    `${zWalut} != ${ledger.tradeCashPln}`);
});

test('zapytania do zrodel nie rosna z liczba dni', () => {
  // Kontrola sanity dla calego pliku: kilkanascie przebiegow po ~40 dni kazdy
  // zmiescilo sie w kilku zapytaniach dzieki cache.
  assert.ok(liczbaZapytan < 30, `za duzo zapytan do zrodel: ${liczbaZapytan}`);
});
