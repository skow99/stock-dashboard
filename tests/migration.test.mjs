// tests/migration.test.mjs - migracja danych v1 -> v2 na tymczasowej bazie.
// Uruchamia skrypt migracyjny jako podproces, tak jak zrobi to uzytkownik.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeLegacyData(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transactions.json'), JSON.stringify([
    { date: '2025-03-04', ticker: 'GPW.PL', name: 'GPW', side: 'BUY', qty: 100, price: 41.2, currency: 'PLN', note: 'start' },
    { date: '2026-08-21', ticker: 'ETFBM40TR.WA', name: 'ETFBM40TR', side: 'BUY', qty: 35, price: 172.38, currency: 'PLN', note: 'IBKR / manual' },
    { date: '2026-01-15', ticker: 'MSFT.US', name: 'Microsoft', side: 'BUY', qty: 10, price: 420, currency: 'USD' },
    { date: 'zla-data', ticker: 'BAD', side: 'BUY', qty: 1, price: 1, currency: 'PLN' },  // ma zostac pominieta
  ]));
  fs.writeFileSync(path.join(dir, 'deposits.json'), JSON.stringify([
    { date: '2025-03-01', type: 'Deposit', amount: 50000, currency: 'PLN', id: 'legacy-1' },
    { date: '2026-02-01', type: 'Dywidenda', amount: 320, currency: 'PLN' },
    { date: '2026-05-01', type: 'Withdrawal', amount: -5000, currency: 'PLN' },
  ]));
  fs.writeFileSync(path.join(dir, 'holdings.json'), JSON.stringify([
    { symbol: 'MSFT.US', name: 'Microsoft', qty: 0, avg: 420, currency: 'USD', sector: 'Technology', market: 'USA', source: 'stooq', fallbackPrice: 420 },
  ]));
  fs.writeFileSync(path.join(dir, 'sectors.json'), JSON.stringify({ 'GPW.WA': 'Financials', ETFBM40TR: 'ETF' }));
  fs.writeFileSync(path.join(dir, 'position-notes.json'), JSON.stringify({ 'GPW.WA': 'Trzymam do 60 zl' }));
  fs.writeFileSync(path.join(dir, 'portfolio-history.json'), JSON.stringify([
    { day: '2026-08-20', totalPln: 249000.1, updatedAt: '2026-08-20T20:15:00.000Z', provisional: false },
    { day: '2026-08-21', totalPln: 250000.42, updatedAt: '2026-08-21T20:15:00.000Z', provisional: false },
  ]));
}

function run(args, env) {
  return execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate-v1.mjs'), ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

test('migracja v1 -> v2 przenosi ledger i pomija bledne rekordy', async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mpd-mig-'));
  const legacy = path.join(work, 'v1data');
  makeLegacyData(legacy);
  const env = { SD_OFFLINE: '1', SD_DATA_DIR: path.join(work, 'data'), SD_DB_PATH: path.join(work, 'test.db') };
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  // Konto tworzymy zawczasu, zeby migracja nie pytala o haslo interaktywnie.
  const { createUser } = await import('../src/auth.mjs');
  process.env.SD_DB_PATH = env.SD_DB_PATH;

  const dry = run(['--from', legacy, '--email', 'mig@example.com', '--dry-run'], env);
  assert.match(dry, /dry-run/);
  void createUser;

  // Prawdziwy przebieg: konto zakladamy przez CLI admina, potem migrujemy.
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'admin.mjs'), 'create-user', 'mig@example.com', '--role', 'owner'], {
    env: { ...process.env, ...env },
    input: 'Migracja!2026x\n',
    encoding: 'utf8',
  });

  const out = run(['--from', legacy, '--email', 'mig@example.com', '--portfolio', 'Import v1'], env);
  assert.match(out, /transakcje:\s+3/);       // 4 wejsciowe, 1 odrzucona przez walidacje
  assert.match(out, /przeplywy:\s+3/);
  assert.match(out, /punkty historii:\s+2/);
  assert.match(out, /Pominieto 1 rekordow/);

  // Powtorna migracja do tego samego portfela musi sie zatrzymac.
  assert.throws(() => run(['--from', legacy, '--email', 'mig@example.com', '--portfolio', 'Import v1'], env), /Status|status|1/);

  // Weryfikacja zawartosci bazy.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(env.SD_DB_PATH);
  const tickers = db.prepare('SELECT ticker FROM transactions ORDER BY trade_date').all().map((r) => r.ticker);
  assert.deepEqual(tickers, ['GPW.WA', 'MSFT.US', 'ETFBM40TR.WA']); // GPW.PL skanonizowane do .WA
  const flows = db.prepare('SELECT type, amount FROM cash_flows ORDER BY flow_date').all();
  assert.deepEqual(flows.map((f) => f.type), ['Deposit', 'Dividend', 'Withdrawal']); // polski alias rozpoznany
  assert.equal(flows[2].amount, -5000);
  assert.equal(db.prepare('SELECT note FROM position_notes').get().note, 'Trzymam do 60 zl');
  assert.equal(db.prepare("SELECT sector FROM sectors WHERE ticker_key = 'GPW'").get().sector, 'Financials');
  db.close();
});
