// tests/import.test.mjs - import z pliku: odczyt, rozpoznanie, zapis, cofniecie.
//
// Nacisk polozony na to, co w prawdziwych plikach psuje sie najczesciej: kodowanie
// z Excela, przecinek dziesietny, przecinek w cudzyslowie, ilosc ze znakiem u brokera.
// Plus dwie gwarancje wobec zywego systemu: duplikaty nie zjadaja prawdziwych transakcji,
// a cofniecie importu nie kasuje wierszy poprawionych recznie.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-import-'));
process.env.SD_DATA_DIR = TMP;
process.env.SD_DB_PATH = path.join(TMP, 'test.db');
process.env.SD_OFFLINE = '1';

const {
  decodeBytes, detectDelimiter, parseCsv, inferDecimalSeparator,
  parseNumber, parseDate, inferSlashOrder,
} = await import('../src/import/csv.mjs');
const {
  normKey, mapHeader, detectShape, detectProfile, parseSide, parseFlowType, PROFILES,
} = await import('../src/import/schema.mjs');
const { csvTemplate } = await import('../src/import/template.mjs');
const { buildPlan, toPreview, commitPlan, listBatches, undoBatch } = await import('../src/import/engine.mjs');
const { getDb, newId, nowIso } = await import('../src/db.mjs');
const { listTransactions, listCashFlows, updateTransaction } = await import('../src/ledger.mjs');

// ---------------------------------------------------------------- srodowisko

let userId;
function freshPortfolio(name = 'Test') {
  const db = getDb();
  const at = nowIso();
  if (!userId) {
    userId = newId('u_');
    db.prepare('INSERT INTO users (id,email,display_name,password_hash,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(userId, 'import@test.local', 'T', 'x', 'owner', 'active', at, at);
  }
  const pid = newId('p_');
  db.prepare('INSERT INTO portfolios (id,user_id,name,slug,base_currency,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(pid, userId, name, `slug-${pid.slice(-8)}`, 'PLN', at, at);
  return pid;
}
const ctx = () => ({ userId, ip: '127.0.0.1' });

// ---------------------------------------------------------------- kodowanie i separatory

test('plik z Excela w Windows-1250 czyta sie z polskimi znakami', () => {
  // "Sprzedaż" zapisane w CP1250: 'z' z kropka to bajt 0xBF
  const bytes = Buffer.from([0x53, 0x70, 0x72, 0x7a, 0x65, 0x64, 0x61, 0xbf]);
  const { text, encoding } = decodeBytes(bytes);
  assert.equal(encoding, 'windows-1250');
  assert.equal(text, 'Sprzedaż');
});

test('BOM nie wchodzi do pierwszego naglowka', () => {
  const { text, encoding } = decodeBytes(Buffer.from('﻿data;ticker', 'utf8'));
  assert.equal(encoding, 'utf-8-bom');
  assert.equal(text, 'data;ticker');
  assert.equal(normKey(parseCsv(text).rows[0][0]), 'data');
});

test('przecinek w cudzyslowie nie moze byc wziety za separator', () => {
  const text = 'data;ticker;nazwa\n2026-01-15;KO.US;"Coca-Cola Company, The"';
  assert.equal(detectDelimiter(text), ';');
  assert.equal(parseCsv(text).rows[1][2], 'Coca-Cola Company, The');
});

test('podwojony cudzyslow i nowa linia w polu', () => {
  const { rows } = parseCsv('a,b\n"on ""tak"" powiedzial","dwie\nlinie"');
  assert.equal(rows[1][0], 'on "tak" powiedzial');
  assert.equal(rows[1][1], 'dwie\nlinie');
});

test('separator wybierany po stalosci liczby kolumn, nie po liczbie trafien', () => {
  // Przecinkow jest wiecej, ale to srednik daje rowna liczbe kolumn w kazdym wierszu.
  const text = 'a;b;c\n1,5;2,5;3,5\n4,5;5,5;6,5';
  assert.equal(detectDelimiter(text), ';');
});

// ---------------------------------------------------------------- liczby

test('separator dziesietny ustalany dla calej kolumny, nie dla komorki', () => {
  assert.equal(inferDecimalSeparator(['185,50', '1 234,56', '12,5']), 'comma');
  assert.equal(inferDecimalSeparator(['185.50', '1,234.56', '12.5']), 'dot');
  // Powtorzony separator moze byc tylko grupowaniem tysiecy.
  assert.equal(inferDecimalSeparator(['1.234.567']), 'comma');
  assert.equal(inferDecimalSeparator(['1,234,567']), 'dot');
});

test('1,234 w kolumnie z prawdziwymi ulamkami czyta sie jako 1.234', () => {
  const kolumna = ['1,234', '12,5'];
  const styl = inferDecimalSeparator(kolumna);
  assert.equal(parseNumber('1,234', styl), 1.234);
});

test('spacja nierozdzielajaca i nawias ksiegowy', () => {
  assert.equal(parseNumber('1 234,56', 'comma'), 1234.56);
  assert.equal(parseNumber('(1 234,56)', 'comma'), -1234.56);
  assert.equal(parseNumber('185,50 zl', 'comma'), 185.5);
  assert.equal(parseNumber('', 'comma'), null);
  assert.equal(parseNumber('-', 'comma'), null);
});

// ---------------------------------------------------------------- daty

test('trzy formaty daty plus czas doklejony do daty', () => {
  assert.equal(parseDate('2026-01-15'), '2026-01-15');
  assert.equal(parseDate('15.01.2026'), '2026-01-15');
  assert.equal(parseDate('20260115'), '2026-01-15');
  assert.equal(parseDate('2026-01-15 10:30:00'), '2026-01-15');
  assert.equal(parseDate('31.02.2026'), null, 'data nieistniejaca musi byc odrzucona');
});

test('kolejnosc dzien/miesiac wnioskowana z calej kolumny', () => {
  assert.equal(inferSlashOrder(['03/04/2026', '25/12/2026']), 'dmy');
  assert.equal(inferSlashOrder(['12/25/2026']), 'mdy');
  assert.equal(parseDate('03/04/2026', 'dmy'), '2026-04-03');
  assert.equal(parseDate('03/04/2026', 'mdy'), '2026-03-04');
});

// ---------------------------------------------------------------- rozpoznanie

test('aliasy naglowkow dzialaja po polsku i po angielsku', () => {
  assert.equal(normKey('Ilość'), 'ilosc');
  assert.equal(normKey('T. Price'), 'tprice');
  assert.equal(parseSide('Kupno'), 'BUY');
  assert.equal(parseSide('SPRZEDAŻ'), 'SELL');
  assert.equal(parseSide('cokolwiek'), null);
  assert.equal(parseFlowType('Wpłata'), 'Deposit');
  assert.equal(parseFlowType('Podatek u źródła'), 'Tax');
});

test('kazdy z trzech ksztaltow rozpoznaje sie po naglowku', () => {
  const shapeOf = (header) => {
    const profile = detectProfile(header.map(normKey));
    const { mapping } = mapHeader(header, profile);
    return detectShape(mapping, { provides: PROFILES[profile]?.provides ?? [] }).shape;
  };
  assert.equal(shapeOf(['data', 'ticker', 'strona', 'ilosc', 'cena']), 'transactions');
  assert.equal(shapeOf(['data', 'typ', 'kwota']), 'cashflows');
  assert.equal(shapeOf(['ticker', 'ilosc', 'cena_srednia']), 'holdings');
  assert.equal(shapeOf(['date', 'ticker', 'side', 'quantity', 'price']), 'transactions');
});

test('plik IBKR to transakcje, mimo ze nie ma kolumny strony', () => {
  const header = ['Symbol', 'TradeDate', 'Quantity', 'T. Price', 'Comm/Fee', 'CurrencyPrimary'];
  const profile = detectProfile(header.map(normKey));
  assert.equal(profile, 'ibkr');
  const { mapping } = mapHeader(header, profile);
  assert.equal(detectShape(mapping, { provides: PROFILES.ibkr.provides }).shape, 'transactions');
});

test('nierozpoznany uklad mowi, ktorych kolumn brakuje', () => {
  const { mapping } = mapHeader(['data', 'ticker', 'ilosc']);
  const result = detectShape(mapping);
  assert.equal(result.shape, null);
  assert.deepEqual(result.missing, ['side', 'price']);
});

// ---------------------------------------------------------------- wlasny wzorzec

test('wzorzec pobierany z panelu daje sie zaimportowac bez zmian', () => {
  // Gdyby wzorzec nie przechodzil przez wlasny parser, byloby to najgorsze
  // mozliwe pierwsze wrazenie: uzytkownik pobiera plik i dostaje blad.
  for (const locale of ['pl', 'en']) {
    for (const kind of ['transactions', 'cashflows', 'holdings']) {
      const pid = freshPortfolio();
      const plan = buildPlan({ text: csvTemplate(kind, locale), portfolioId: pid });
      assert.equal(plan.shape, kind, `${locale}/${kind}: zly ksztalt`);
      assert.equal(plan.counts.error, 0, `${locale}/${kind}: wzorzec ma bledne wiersze`);
      assert.ok(plan.counts.ok > 0, `${locale}/${kind}: wzorzec nie ma wierszy`);
    }
  }
});

// ---------------------------------------------------------------- zapis

const PL_CSV = [
  'data;ticker;strona;ilosc;cena;prowizja;waluta;nazwa',
  '15.01.2026;AAPL.US;Kupno;10;185,50;1,20;USD;Apple Inc',
  '02.03.2026;CDR.WA;Sprzedaż;50;142,00;3,50;PLN;CD Projekt',
  '05.03.2026;CDR.WA;Kupno;1 200;1 042,50;12,00;PLN;CD Projekt',
  'zla data;XXX;Kupno;5;10;0;USD;Wiersz bledny',
].join('\n');

test('podglad nie zapisuje niczego do bazy', () => {
  const pid = freshPortfolio();
  buildPlan({ text: PL_CSV, portfolioId: pid });
  buildPlan({ text: PL_CSV, portfolioId: pid });
  assert.equal(listTransactions([pid]).length, 0);
});

test('polski plik czyta sie w calosci, bledny wiersz nie blokuje reszty', () => {
  const pid = freshPortfolio();
  const plan = buildPlan({ text: PL_CSV, portfolioId: pid });
  assert.deepEqual(plan.counts, { ok: 3, duplicate: 0, update: 0, error: 1 });

  const preview = toPreview(plan);
  assert.equal(preview.problems[0].line, 5, 'numer wiersza musi wskazywac linie w pliku');
  assert.equal(preview.problems[0].error.code, 'invalid_date');

  const result = commitPlan(pid, plan, { ...ctx(), filename: 'historia.csv' });
  assert.equal(result.inserted, 3);

  const rows = listTransactions([pid]);
  const duza = rows.find((r) => r.qty === 1200);
  assert.equal(duza.price, 1042.5, 'spacja jako separator tysiecy');
  assert.equal(rows.find((r) => r.ticker === 'CDR.WA' && r.side === 'SELL').qty, 50);
  assert.ok(rows.every((r) => r.source === 'import' && r.import_batch_id));
});

test('ten sam plik wgrany drugi raz nie dubluje danych', () => {
  const pid = freshPortfolio();
  commitPlan(pid, buildPlan({ text: PL_CSV, portfolioId: pid }), ctx());
  const drugi = buildPlan({ text: PL_CSV, portfolioId: pid });
  assert.equal(drugi.counts.duplicate, 3);
  assert.equal(drugi.counts.ok, 0);
  assert.equal(listTransactions([pid]).length, 3);
});

test('dwie identyczne transakcje w JEDNYM pliku to dwie transakcje', () => {
  // Kluczowa roznica wobec deduplikacji naiwnej: duplikat liczymy wzgledem stanu
  // SPRZED importu, wiec dwa takie same zlecenia z jednego dnia obydwa wchodza.
  const pid = freshPortfolio();
  const text = [
    'data;ticker;strona;ilosc;cena;waluta',
    '10.04.2026;MSFT.US;Kupno;5;400,00;USD',
    '10.04.2026;MSFT.US;Kupno;5;400,00;USD',
  ].join('\n');
  const plan = buildPlan({ text, portfolioId: pid });
  assert.equal(plan.counts.ok, 2);
  commitPlan(pid, plan, ctx());
  assert.equal(listTransactions([pid]).length, 2);
});

test('duplikaty mozna swiadomie wymusic', () => {
  const pid = freshPortfolio();
  commitPlan(pid, buildPlan({ text: PL_CSV, portfolioId: pid }), ctx());
  const plan = buildPlan({ text: PL_CSV, portfolioId: pid, includeDuplicates: true });
  assert.equal(plan.counts.ok, 3);
  assert.equal(plan.counts.duplicate, 0);
});

test('przeplywy: podatek i wyplata zapisuja sie jako ujemne', () => {
  const pid = freshPortfolio();
  const text = [
    'data;typ;kwota;waluta;notatka',
    '02.01.2026;Wpłata;10000;PLN;przelew',
    '14.02.2026;Dywidenda;23,40;USD;kwartalna',
    '14.02.2026;Podatek u źródła;3,51;USD;WHT',
    '20.02.2026;Wypłata;500;PLN;na konto',
  ].join('\n');
  const plan = buildPlan({ text, portfolioId: pid });
  assert.equal(plan.shape, 'cashflows');
  commitPlan(pid, plan, ctx());

  const flows = Object.fromEntries(listCashFlows([pid]).map((f) => [f.type, f.amount]));
  assert.equal(flows.Deposit, 10000);
  assert.equal(flows.Dividend, 23.4);
  assert.equal(flows.Tax, -3.51);
  assert.equal(flows.Withdrawal, -500);
});

test('IBKR: ujemna ilosc znaczy sprzedaz, prowizja wchodzi dodatnia', () => {
  const pid = freshPortfolio();
  const text = [
    'Symbol,TradeDate,Quantity,T. Price,Comm/Fee,CurrencyPrimary,Description',
    'NVDA,2026-05-04,25,120.50,-1.05,USD,NVIDIA Corp',
    'NVDA,2026-06-11,-10,145.75,-1.05,USD,NVIDIA Corp',
  ].join('\n');
  const plan = buildPlan({ text, portfolioId: pid });
  assert.equal(plan.profile, 'ibkr');
  assert.equal(plan.shape, 'transactions');
  commitPlan(pid, plan, ctx());

  const rows = listTransactions([pid]);
  assert.equal(rows.length, 2);
  const sprzedaz = rows.find((r) => r.side === 'SELL');
  assert.equal(sprzedaz.qty, 10, 'ilosc musi trafic do bazy bez znaku');
  assert.equal(sprzedaz.fee, 1.05, 'prowizja nie moze byc ujemna');
  assert.equal(rows.find((r) => r.side === 'BUY').qty, 25);
});

test('stan portfela: drugi import nadpisuje, nie dubluje', () => {
  const pid = freshPortfolio();
  const text = 'ticker;ilosc;cena_srednia;waluta\nPKN.WA;100;62,40;PLN';
  commitPlan(pid, buildPlan({ text, portfolioId: pid }), ctx());

  const drugi = buildPlan({ text: 'ticker;ilosc;cena_srednia;waluta\nPKN.WA;150;60,00;PLN', portfolioId: pid });
  assert.equal(drugi.counts.update, 1);
  assert.equal(drugi.counts.ok, 0);
  commitPlan(pid, drugi, ctx());

  const rows = getDb().prepare('SELECT * FROM holdings_baseline WHERE portfolio_id = ?').all(pid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qty, 150);
});

test('reczne przypisanie kolumny nadpisuje automat', () => {
  const pid = freshPortfolio();
  // Dwie kolumny daty: automat wezmie pierwsza, uzytkownik wskazuje druga.
  const text = [
    'data;data rozliczenia;ticker;strona;ilosc;cena',
    '15.01.2026;17.01.2026;AAPL.US;Kupno;10;185,50',
  ].join('\n');
  const auto = buildPlan({ text, portfolioId: pid });
  assert.equal(auto.items[0].value.trade_date, '2026-01-15');

  const reczne = buildPlan({ text, portfolioId: pid, mapping: { date: 1 } });
  assert.equal(reczne.items[0].value.trade_date, '2026-01-17');
});

// ---------------------------------------------------------------- cofanie

test('cofniecie usuwa dokladnie wiersze z tego wsadu', () => {
  const pid = freshPortfolio();
  commitPlan(pid, buildPlan({ text: PL_CSV, portfolioId: pid }), { ...ctx(), filename: 'a.csv' });
  const innyText = 'data;ticker;strona;ilosc;cena;waluta\n01.06.2026;PKO.WA;Kupno;20;55,00;PLN';
  commitPlan(pid, buildPlan({ text: innyText, portfolioId: pid }), { ...ctx(), filename: 'b.csv' });
  assert.equal(listTransactions([pid]).length, 4);

  const wsad = listBatches(pid).find((b) => b.filename === 'a.csv');
  const result = undoBatch(pid, wsad.id, ctx());
  assert.equal(result.removed, 3);
  assert.equal(result.kept, 0);

  const zostalo = listTransactions([pid]);
  assert.equal(zostalo.length, 1);
  assert.equal(zostalo[0].ticker, 'PKO.WA', 'drugi wsad nie moze ucierpiec');
});

test('reczna edycja odpina wiersz od wsadu importu', () => {
  const pid = freshPortfolio();
  commitPlan(pid, buildPlan({ text: PL_CSV, portfolioId: pid }), ctx());
  const wiersz = listTransactions([pid])[0];
  assert.ok(wiersz.import_batch_id, 'po imporcie wiersz nalezy do wsadu');

  updateTransaction(pid, wiersz.id, { note: 'poprawione recznie' }, ctx());
  const po = getDb().prepare('SELECT * FROM transactions WHERE id = ?').get(wiersz.id);
  assert.equal(po.import_batch_id, null, 'edycja musi odpiac wiersz od importu');
  assert.equal(po.source, 'import', 'zrodlo zostaje - wiadomo, skad wiersz pochodzi');
});

test('cofniecie NIE kasuje wiersza poprawionego recznie po imporcie', () => {
  const pid = freshPortfolio();
  commitPlan(pid, buildPlan({ text: PL_CSV, portfolioId: pid }), { ...ctx(), filename: 'a.csv' });
  const wsad = listBatches(pid)[0];

  const wiersz = listTransactions([pid])[0];
  updateTransaction(pid, wiersz.id, { note: 'poprawione recznie' }, ctx());

  const result = undoBatch(pid, wsad.id, ctx());
  assert.equal(result.removed, 2);
  assert.equal(result.kept, 1);

  const ocalaly = getDb().prepare('SELECT note FROM transactions WHERE id = ?').get(wiersz.id);
  assert.ok(ocalaly, 'wiersz zmieniony przez uzytkownika musi przetrwac cofniecie');
  assert.equal(ocalaly.note, 'poprawione recznie');
});

test('wsadu nie da sie cofnac dwa razy', () => {
  const pid = freshPortfolio();
  commitPlan(pid, buildPlan({ text: PL_CSV, portfolioId: pid }), ctx());
  const wsad = listBatches(pid)[0];
  undoBatch(pid, wsad.id, ctx());
  assert.throws(() => undoBatch(pid, wsad.id, ctx()), (err) => err.code === 'import_batch_already_undone');
});

test('cudzego wsadu nie widac i nie da sie go cofnac', () => {
  const mojPid = freshPortfolio();
  const cudzyPid = freshPortfolio();
  commitPlan(cudzyPid, buildPlan({ text: PL_CSV, portfolioId: cudzyPid }), ctx());
  const cudzyWsad = listBatches(cudzyPid)[0];

  assert.equal(listBatches(mojPid).length, 0);
  assert.throws(
    () => undoBatch(mojPid, cudzyWsad.id, ctx()),
    (err) => err.code === 'import_batch_not_found',
  );
  assert.equal(listTransactions([cudzyPid]).length, 3, 'dane w cudzym portfelu nietkniete');
});

test('importu stanu portfela nie da sie cofnac', () => {
  const pid = freshPortfolio();
  commitPlan(pid, buildPlan({ text: 'ticker;ilosc;cena_srednia\nPKN.WA;100;62,40', portfolioId: pid }), ctx());
  const wsad = listBatches(pid)[0];
  assert.equal(wsad.reversible, false);
  assert.throws(() => undoBatch(pid, wsad.id, ctx()), (err) => err.code === 'import_batch_not_reversible');
});

// ---------------------------------------------------------------- odmowy

test('puste i bezsensowne wejscie konczy sie czytelnym kodem', () => {
  const pid = freshPortfolio();
  assert.throws(() => buildPlan({ text: '   ', portfolioId: pid }), (err) => err.code === 'import_empty_file');
  assert.throws(() => buildPlan({ text: 'sam naglowek;bez;wierszy', portfolioId: pid }), (err) => err.code === 'import_no_rows');
  assert.throws(
    () => buildPlan({ text: 'kolumna_a;kolumna_b\n1;2', portfolioId: pid }),
    (err) => err.code === 'import_shape_unknown',
  );
});

test('plik ponad limit jest odrzucany przed dotknieciem bazy', () => {
  const pid = freshPortfolio();
  const wiersze = ['data;ticker;strona;ilosc;cena'];
  for (let i = 0; i < 5001; i += 1) wiersze.push(`01.06.2026;PKO.WA;Kupno;1;55,00`);
  assert.throws(
    () => buildPlan({ text: wiersze.join('\n'), portfolioId: pid }),
    (err) => err.code === 'import_too_many_rows',
  );
});

test('zapis bez ani jednego dobrego wiersza jest odrzucany', () => {
  const pid = freshPortfolio();
  commitPlan(pid, buildPlan({ text: PL_CSV, portfolioId: pid }), ctx());
  const same = buildPlan({ text: PL_CSV, portfolioId: pid });
  assert.throws(() => commitPlan(pid, same, ctx()), (err) => err.code === 'import_nothing_to_insert');
});

test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });
