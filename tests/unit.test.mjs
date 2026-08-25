// tests/unit.test.mjs - testy jednostkowe warstwy obliczeniowej (node --test tests/).
import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalTicker, normalizeTickerKey, toYahooSymbol, inferCurrency, regionOf } from '../src/market/tickers.mjs';
import { replayLedger, buildPositions, computeCash, summarizeRealized, buildClosedPositions, concentrationTop } from '../src/calc/engine.mjs';
import { buildTwrIndex, periodPerformance, externalFlowsByDay, returnOnCapital } from '../src/calc/performance.mjs';
import { isValidDay, isWeekend, addDays, lastBusinessDay } from '../src/dates.mjs';
import { parseXtb, parseIbkr } from '../src/routes/webhook.mjs';
import { hashPassword, verifyPassword, assertPasswordPolicy } from '../src/auth.mjs';

const FX = { USDPLN: 4, EURPLN: 4.2, SEKPLN: 0.4, PLNPLN: 1 };
const tx = (over) => ({
  id: `tx${Math.random()}`, trade_date: '2026-01-01', ticker: 'GPW.WA', name: 'GPW',
  side: 'BUY', qty: 10, price: 100, fee: 0, currency: 'PLN', source: 'manual', created_at: '2026-01-01T00:00:00Z',
  ...over,
});

// ---------------------------------------------------------------- tickery

test('kanonizacja tickerow', () => {
  assert.equal(canonicalTicker('GPW.PL'), 'GPW.WA');
  assert.equal(canonicalTicker('gpw.wa'), 'GPW.WA');
  assert.equal(canonicalTicker('ETFBM40TR', { venue: 'WSE' }), 'ETFBM40TR.WA');
  assert.equal(canonicalTicker('MSFT', { venue: 'NASDAQ' }), 'MSFT.US');
  assert.equal(canonicalTicker('MSFT', { currency: 'USD' }), 'MSFT.US');
  assert.equal(canonicalTicker('^WIG20'), '^WIG20');
  assert.equal(canonicalTicker('  aapl.us  '), 'AAPL.US');
});

test('klucz porownawczy ignoruje gielde', () => {
  assert.equal(normalizeTickerKey('GPW.WA'), normalizeTickerKey('GPW.PL'));
  assert.equal(normalizeTickerKey('MSFT.US'), 'MSFT');
  assert.equal(normalizeTickerKey('^WIG20'), 'WIG20');
});

test('mapowanie na symbole Yahoo', () => {
  assert.equal(toYahooSymbol('MSFT.US'), 'MSFT');
  assert.equal(toYahooSymbol('INPST.NL'), 'INPST.AS');
  assert.equal(toYahooSymbol('DG.FR'), 'DG.PA');
  assert.equal(toYahooSymbol('GPW.WA'), 'GPW.WA');
  assert.equal(toYahooSymbol('WIG20'), '^WIG20');
  assert.equal(toYahooSymbol('mWIG40TR'), 'MWIG40TR.WA');
});

test('waluta i region z tickera', () => {
  assert.equal(inferCurrency('GPW.WA'), 'PLN');
  assert.equal(inferCurrency('MSFT.US'), 'USD');
  assert.equal(inferCurrency('INPST.NL'), 'EUR');
  assert.equal(regionOf('MSFT.US', 'USD'), 'USA');
  assert.equal(regionOf('GPW.WA', 'PLN'), 'EUROPE');
});

// ---------------------------------------------------------------- ledger

test('BUY zwieksza ilosc i koszt', () => {
  const { positionState, tradeCashPln } = replayLedger({
    transactions: [tx({ qty: 10, price: 100 }), tx({ qty: 10, price: 120, trade_date: '2026-02-01' })],
    fxRates: FX,
  });
  const position = positionState.get('GPW');
  assert.equal(position.qty, 20);
  assert.equal(position.cost, 2200);
  assert.equal(tradeCashPln, -2200);
});

test('SELL realizuje wynik po srednim koszcie', () => {
  const { positionState, transactions } = replayLedger({
    transactions: [
      tx({ qty: 100, price: 45 }),
      tx({ qty: 40, price: 55, side: 'SELL', trade_date: '2026-03-01' }),
    ],
    fxRates: FX,
  });
  const sell = transactions[1];
  assert.equal(sell.realizedPnl, 40 * (55 - 45));
  assert.equal(Math.round(sell.realizedPct), 22);
  assert.equal(positionState.get('GPW').qty, 60);
  assert.equal(positionState.get('GPW').cost, 60 * 45);
});

test('osierocony SELL nie generuje gotowki i zglasza ostrzezenie', () => {
  const { tradeCashPln, warnings, positionState } = replayLedger({
    transactions: [tx({ ticker: 'ZZZ.WA', side: 'SELL', qty: 10, price: 100 })],
    fxRates: FX,
  });
  assert.equal(tradeCashPln, 0);
  assert.equal(warnings[0].code, 'orphan_sell');
  assert.equal(positionState.get('ZZZ').qty, 0);
});

test('czesciowo osierocony SELL rozlicza tylko dostepna ilosc', () => {
  const { tradeCashPln, warnings } = replayLedger({
    transactions: [
      tx({ qty: 10, price: 50 }),
      tx({ qty: 25, price: 60, side: 'SELL', trade_date: '2026-02-01' }),
    ],
    fxRates: FX,
  });
  // -500 za zakup, +600 za sprzedaz 10 szt. (nie 25).
  assert.equal(tradeCashPln, 100);
  assert.equal(warnings.length, 1);
});

test('transakcje bootstrap buduja pozycje, ale nie ruszaja gotowki', () => {
  const { positionState, tradeCashPln } = replayLedger({
    transactions: [tx({ source: 'bootstrap', qty: 10, price: 100 })],
    fxRates: FX,
  });
  assert.equal(positionState.get('GPW').qty, 10);
  assert.equal(tradeCashPln, 0);
});

test('przewalutowanie transakcji USD', () => {
  const { tradeCashPln } = replayLedger({
    transactions: [tx({ ticker: 'MSFT.US', currency: 'USD', qty: 10, price: 400 })],
    fxRates: FX,
  });
  assert.equal(tradeCashPln, -16000); // 4000 USD * 4
});

test('pozycja ma jedna walute niezaleznie od tego, w jakiej walucie broker rozliczyl pojedyncza transakcje', () => {
  // Realny przypadek: XTB czasem ksieguje zlecenie w PLN, choc spolka notowana jest w USD
  // (ASTS.US). Pierwsza chronologicznie transakcja ma walute PLN - stary kod bral ja jako
  // walute calej pozycji, co zanizalo wycene ~4x (brak przewalutowania na USD).
  const { positionState } = replayLedger({
    transactions: [
      tx({
        ticker: 'ASTS.US', name: 'AST SpaceMobile', currency: 'PLN',
        qty: 10, price: 400, trade_date: '2026-01-01',
      }),
      tx({
        ticker: 'ASTS.US', name: 'AST SpaceMobile', currency: 'USD',
        qty: 10, price: 100, trade_date: '2026-02-01',
      }),
    ],
    fxRates: FX,
  });
  const position = positionState.get('ASTS');
  assert.equal(position.currency, 'USD');
  assert.equal(position.qty, 20);
  // 4000 PLN -> 1000 USD (po kursie 4) + 1000 USD = 2000 USD, nie 5000.
  assert.equal(position.cost, 2000);

  const quotes = new Map([['ASTS.US', { price: 150, prevClose: 150, fresh: true, source: 'yahoo' }]]);
  const [astsPosition] = buildPositions({ positionState, quotes, fxRates: FX, sectors: {} });
  assert.equal(astsPosition.avg, 100);
  assert.equal(astsPosition.valuePln, 12000); // 20 * 150 USD * 4
  assert.equal(astsPosition.costPln, 8000);   // 2000 USD * 4
});


test('prowizja obciaza koszt i gotowke', () => {
  const { positionState, tradeCashPln } = replayLedger({
    transactions: [tx({ qty: 10, price: 100, fee: 15 })],
    fxRates: FX,
  });
  assert.equal(positionState.get('GPW').cost, 1015);
  assert.equal(tradeCashPln, -1015);
});

// ---------------------------------------------------------------- pozycje i gotowka

test('pozycje licza wartosc, wynik i udzialy', () => {
  const { positionState } = replayLedger({
    transactions: [
      tx({ qty: 10, price: 100 }),
      tx({ ticker: 'MSFT.US', currency: 'USD', qty: 10, price: 400 }),
    ],
    fxRates: FX,
  });
  const quotes = new Map([
    ['GPW.WA', { price: 120, prevClose: 110, fresh: true, source: 'stooq' }],
    ['MSFT.US', { price: 500, prevClose: 500, fresh: true, source: 'yahoo' }],
  ]);
  const positions = buildPositions({ positionState, quotes, fxRates: FX, sectors: { GPW: 'Financials' } });
  const gpw = positions.find((p) => p.symbol === 'GPW.WA');
  const msft = positions.find((p) => p.symbol === 'MSFT.US');

  assert.equal(gpw.valuePln, 1200);
  assert.equal(gpw.pnlPln, 200);
  assert.equal(gpw.sector, 'Financials');
  assert.equal(msft.valuePln, 20000); // 5000 USD * 4
  assert.equal(Math.round(msft.weight), 94);
  assert.equal(positions[0].symbol, 'MSFT.US'); // sortowanie malejaco po wartosci
});

test('gotowka: depozyty minus zakupy plus sprzedaze', () => {
  const cash = computeCash({
    cashFlows: [
      { flow_date: '2026-01-01', type: 'Deposit', amount: 100000, currency: 'PLN' },
      { flow_date: '2026-02-01', type: 'Withdrawal', amount: -10000, currency: 'PLN' },
      { flow_date: '2026-03-01', type: 'Dividend', amount: 500, currency: 'PLN' },
    ],
    tradeCashPln: -20000,
    fxRates: FX,
  });
  assert.equal(cash.cashPln, 70500);
  assert.equal(cash.externalNetPln, 90000);      // dywidenda NIE jest przeplywem zewnetrznym
  assert.equal(cash.dividendsPln, 500);
});

test('gotowka wielowalutowa', () => {
  const cash = computeCash({
    cashFlows: [
      { flow_date: '2026-01-01', type: 'Deposit', amount: 1000, currency: 'USD' },
      { flow_date: '2026-01-01', type: 'Deposit', amount: 1000, currency: 'PLN' },
    ],
    tradeCashPln: 0,
    fxRates: FX,
  });
  assert.equal(cash.cashPln, 5000);
  assert.deepEqual(cash.byCurrency, { USD: 1000, PLN: 1000 });
});

test('koncentracja Top 5', () => {
  const positions = [60, 20, 10, 5, 3, 2].map((v) => ({ valuePln: v }));
  assert.equal(concentrationTop(positions, 5), 98);
  assert.equal(concentrationTop([], 5), 0);
});

// ---------------------------------------------------------------- wynik i pozycje zamkniete

test('agregacja wyniku per ticker i per rok', () => {
  const { transactions } = replayLedger({
    transactions: [
      tx({ qty: 10, price: 100 }),
      tx({ qty: 10, price: 150, side: 'SELL', trade_date: '2026-06-01' }),
    ],
    fxRates: FX,
  });
  const summary = summarizeRealized(transactions);
  assert.equal(summary.totalPln, 500);
  assert.equal(summary.perYear['2026'], 500);
  assert.equal(summary.perTicker[0].key, 'GPW');
});

test('pozycja zamknieta wykryta tylko przy pelnym wyjsciu', () => {
  const partial = replayLedger({
    transactions: [tx({ qty: 10, price: 100 }), tx({ qty: 4, price: 150, side: 'SELL', trade_date: '2026-06-01' })],
    fxRates: FX,
  });
  assert.equal(buildClosedPositions(partial.transactions).length, 0);

  const closed = replayLedger({
    transactions: [tx({ qty: 10, price: 100 }), tx({ qty: 10, price: 150, side: 'SELL', trade_date: '2026-06-01' })],
    fxRates: FX,
  });
  const [position] = buildClosedPositions(closed.transactions);
  assert.equal(position.qty, 10);
  assert.equal(position.avgBuy, 100);
  assert.equal(position.avgSell, 150);
  assert.equal(position.pnlPct, 50);
  assert.equal(position.closedOn, '2026-06-01');
});

// ---------------------------------------------------------------- TWR

test('TWR neutralizuje wplyw depozytu', () => {
  const history = [
    { day: '2026-01-01', totalPln: 100000 },
    { day: '2026-01-02', totalPln: 110000 },  // +10% z rynku
    { day: '2026-01-03', totalPln: 210000 },  // +100k depozytu, zero z rynku
  ];
  const flows = new Map([['2026-01-03', 100000]]);
  const series = buildTwrIndex(history, flows);
  assert.equal(series[0].index, 100);
  assert.equal(Math.round(series[1].index), 110);
  assert.equal(Math.round(series[2].index), 110); // depozyt nie zmienia indeksu
});

test('wynik okresu odejmuje przeplywy zewnetrzne', () => {
  const history = [
    { day: '2026-01-31', totalPln: 100000 },
    { day: '2026-02-10', totalPln: 150000 },
  ];
  const flows = new Map([['2026-02-05', 40000]]);
  const result = periodPerformance(history, flows, '2026-02-01', 150000);
  assert.equal(result.pln, 10000);
  assert.equal(result.pct, 10);
  assert.equal(result.baseDay, '2026-01-31');
});

test('klasyfikacja przeplywow zewnetrznych', () => {
  const flows = externalFlowsByDay([
    { flow_date: '2026-01-01', type: 'Deposit', amount: 1000, currency: 'PLN' },
    { flow_date: '2026-01-01', type: 'Dividend', amount: 500, currency: 'PLN' },
    { flow_date: '2026-01-02', type: 'Withdrawal', amount: -300, currency: 'PLN' },
  ], () => 1);
  assert.equal(flows.get('2026-01-01'), 1000); // dywidenda pominieta
  assert.equal(flows.get('2026-01-02'), -300);
});

test('zwrot z kapitalu', () => {
  assert.equal(returnOnCapital(120000, 100000), 20);
  assert.equal(returnOnCapital(120000, 0), null);
});

// ---------------------------------------------------------------- daty

test('walidacja i arytmetyka dat', () => {
  assert.equal(isValidDay('2026-08-22'), true);
  assert.equal(isValidDay('2026-02-30'), false);
  assert.equal(isValidDay('22-08-2026'), false);
  assert.equal(isWeekend('2026-08-22'), true);   // sobota
  assert.equal(isWeekend('2026-08-21'), false);  // piatek
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(lastBusinessDay('2026-08-23'), '2026-08-21'); // niedziela -> piatek
});

// ---------------------------------------------------------------- webhooki

test('parser XTB', () => {
  const parsed = parseXtb('Your order BUY 10 GPW.PL at 50.25');
  assert.deepEqual(parsed, { side: 'BUY', qty: 10, ticker: 'GPW.WA', price: 50.25, currency: 'PLN' });
  assert.equal(parseXtb('kompletnie inny tekst'), null);
});

test('parser IBKR', () => {
  const parsed = parseIbkr('BOUGHT 35 ETFBM40TR @WSE @ 172.38 (ABC123)');
  assert.equal(parsed.ticker, 'ETFBM40TR.WA');
  assert.equal(parsed.side, 'BUY');
  assert.equal(parsed.externalId, 'ABC123');
  assert.equal(parseIbkr('SOLD 5 MSFT @ 400').side, 'SELL');
  assert.equal(parseIbkr('SOLD 5 MSFT @ 400').ticker, 'MSFT.US');
});

// ---------------------------------------------------------------- hasla

test('hashowanie hasel jest solone i weryfikowalne', () => {
  const a = hashPassword('Tajne!Haslo2026');
  const b = hashPassword('Tajne!Haslo2026');
  assert.notEqual(a, b);                              // rozne sole
  assert.ok(verifyPassword('Tajne!Haslo2026', a));
  assert.ok(!verifyPassword('Tajne!Haslo2027', a));
  assert.ok(!verifyPassword('', a));
});

test('polityka hasel zglasza stabilne kody bledow', () => {
  // Tresc komunikatu jest tlumaczona dopiero w warstwie HTTP - test sprawdza kod, nie tekst.
  const codeOf = (password) => {
    try { assertPasswordPolicy(password); return null; } catch (err) { return err.code; }
  };
  assert.equal(codeOf('krotkie'), 'weak_password');           // za krotkie
  assert.equal(codeOf('tylkomalelitery'), 'weak_password');   // jedna klasa znakow
  assert.equal(codeOf('password'), 'weak_password');
  assert.equal(codeOf('x'.repeat(250)), 'password_too_long');
  assert.equal(codeOf('Tajne!Haslo2026'), null);
});

test('polityka hasel niesie parametry do interpolacji komunikatu', () => {
  try {
    assertPasswordPolicy('Ab1!');
    assert.fail('powinno rzucic');
  } catch (err) {
    assert.equal(err.code, 'weak_password');
    assert.equal(typeof err.details.min, 'number');
  }
});
