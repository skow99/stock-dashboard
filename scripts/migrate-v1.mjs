#!/usr/bin/env node
// scripts/migrate-v1.mjs - przeniesienie danych z plikow JSON v1 do SQLite v2.
//
// Uzycie:
//   node scripts/migrate-v1.mjs --from ../stock-dashboard-v1/data --email ja@example.com [--portfolio "Portfel glowny"] [--dry-run]
//
// Migracja jest IDEMPOTENTNA na poziomie portfela: jesli portfel o podanej nazwie juz istnieje
// i zawiera dane, skrypt przerywa prace zamiast dublowac ledger.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';

import { getDb, tx, nowIso } from '../src/db.mjs';
import { findUserByEmail, createUser } from '../src/auth.mjs';
import { createPortfolio, listPortfolios } from '../src/portfolios.mjs';
import { insertTransaction, insertCashFlow, upsertBaseline, saveNote, upsertSector, upsertHistoryPoint } from '../src/ledger.mjs';
import { normalizeTickerKey } from '../src/market/tickers.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
    ? process.argv[index + 1]
    : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

function readJson(dir, file, fallback) {
  const filePath = path.join(dir, file);
  if (!fs.existsSync(filePath)) {
    console.log(`  - ${file}: brak pliku, pomijam`);
    return fallback;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    console.log(`  - ${file}: ${Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length} rekordow`);
    return parsed;
  } catch (err) {
    throw new Error(`Plik ${file} nie jest poprawnym JSON: ${err.message}`);
  }
}

const FLOW_TYPE_MAP = {
  deposit: 'Deposit', wplata: 'Deposit',
  withdrawal: 'Withdrawal', wyplata: 'Withdrawal',
  dividend: 'Dividend', dywidenda: 'Dividend',
};

async function main() {
  const from = arg('from');
  const email = arg('email');
  const portfolioName = arg('portfolio', 'Portfel glowny');
  const dryRun = hasFlag('dry-run');

  if (!from || !email) {
    console.error('Wymagane: --from <katalog data v1> --email <adres konta>');
    process.exit(1);
  }
  if (!fs.existsSync(from)) {
    console.error(`Katalog nie istnieje: ${from}`);
    process.exit(1);
  }

  console.log(`\nZrodlo: ${from}`);
  console.log('Wczytywanie plikow v1:');
  const transactions = readJson(from, 'transactions.json', []);
  const deposits = readJson(from, 'deposits.json', []);
  const holdings = readJson(from, 'holdings.json', []);
  const sectors = readJson(from, 'sectors.json', {});
  const notes = readJson(from, 'position-notes.json', {});
  const history = readJson(from, 'portfolio-history.json', []);

  getDb();
  let user = findUserByEmail(email);
  if (!user && dryRun) {
    console.log(`\n[dry-run] Konto ${email} nie istnieje - zostaloby utworzone.`);
  } else if (!user) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`\nKonto ${email} nie istnieje - zostanie utworzone.`);
    const password = await rl.question('Podaj haslo dla nowego konta (min. 10 znakow): ');
    rl.close();
    user = createUser({ email, password, displayName: email.split('@')[0], role: 'owner' });
    console.log(`Utworzono konto ${user.email} (rola: ${user.role})`);
  }

  const existing = user
    ? listPortfolios(user.id, { includeArchived: true }).find((p) => p.name === portfolioName)
    : null;
  if (existing) {
    const count = getDb().prepare('SELECT COUNT(*) AS n FROM transactions WHERE portfolio_id = ?').get(existing.id).n;
    if (count > 0) {
      console.error(`\nPortfel "${portfolioName}" juz istnieje i ma ${count} transakcji. Przerwano, zeby nie zdublowac danych.`);
      console.error('Uzyj innej nazwy przez --portfolio albo usun istniejacy portfel.');
      process.exit(1);
    }
  }

  console.log(`\nDocelowe konto: ${user?.email ?? email}`);
  console.log(`Docelowy portfel: ${portfolioName}`);
  if (dryRun) {
    console.log('\n[dry-run] Do zapisania:');
    console.log(`  transakcje:        ${transactions.length}`);
    console.log(`  przeplywy:         ${deposits.length}`);
    console.log(`  baseline pozycji:  ${holdings.length}`);
    console.log(`  notatki:           ${Object.keys(notes).length}`);
    console.log(`  sektory:           ${Object.keys(sectors).length}`);
    console.log(`  punkty historii:   ${history.length}`);
    process.exit(0);
  }

  const stats = tx(() => {
    const portfolio = existing ?? createPortfolio(user.id, { name: portfolioName, baseCurrency: 'PLN', kind: 'brokerage' });
    const counters = { transactions: 0, flows: 0, baseline: 0, notes: 0, sectors: 0, history: 0, skipped: [] };

    for (const item of holdings) {
      upsertBaseline(portfolio.id, {
        symbol: item.symbol, name: item.name, qty: item.qty, avg: item.avg,
        currency: item.currency, sector: item.sector, market: item.market,
        source: item.source, fallbackPrice: item.fallbackPrice,
      });
      counters.baseline += 1;
    }

    for (const item of transactions) {
      try {
        insertTransaction(portfolio.id, {
          date: item.date, ticker: item.ticker, name: item.name, side: item.side,
          qty: item.qty, price: item.price, currency: item.currency,
          note: item.note, source: 'import',
        }, { userId: user.id });
        counters.transactions += 1;
      } catch (err) {
        counters.skipped.push({ kind: 'transaction', item, reason: err.message });
      }
    }

    for (const item of deposits) {
      try {
        const type = FLOW_TYPE_MAP[String(item.type ?? '').toLowerCase()] ?? item.type;
        insertCashFlow(portfolio.id, {
          date: item.date, type, amount: item.amount, currency: item.currency,
          comment: item.comment, source: 'import',
        }, { userId: user.id });
        counters.flows += 1;
      } catch (err) {
        counters.skipped.push({ kind: 'cashflow', item, reason: err.message });
      }
    }

    for (const [symbol, note] of Object.entries(notes)) {
      if (typeof note !== 'string' || !note.trim()) continue;
      saveNote(portfolio.id, { symbol, note });
      counters.notes += 1;
    }

    for (const [ticker, sector] of Object.entries(sectors)) {
      upsertSector(normalizeTickerKey(ticker), sector);
      counters.sectors += 1;
    }

    for (const point of history) {
      if (!point?.day || !Number.isFinite(Number(point.totalPln))) continue;
      upsertHistoryPoint(portfolio.id, {
        day: point.day,
        totalPln: Number(point.totalPln),
        provisional: Boolean(point.provisional),
      });
      counters.history += 1;
    }

    counters.portfolioId = portfolio.id;
    return counters;
  });

  console.log('\nZapisano:');
  console.log(`  transakcje:        ${stats.transactions}`);
  console.log(`  przeplywy:         ${stats.flows}`);
  console.log(`  baseline pozycji:  ${stats.baseline}`);
  console.log(`  notatki:           ${stats.notes}`);
  console.log(`  sektory:           ${stats.sectors}`);
  console.log(`  punkty historii:   ${stats.history}`);
  if (stats.skipped.length) {
    console.log(`\nPominieto ${stats.skipped.length} rekordow (nie przeszly walidacji):`);
    for (const item of stats.skipped.slice(0, 20)) {
      console.log(`  [${item.kind}] ${JSON.stringify(item.item).slice(0, 120)} -> ${item.reason}`);
    }
    if (stats.skipped.length > 20) console.log(`  ...oraz ${stats.skipped.length - 20} kolejnych`);
  }
  console.log(`\nGotowe. Portfel: ${stats.portfolioId}, czas: ${nowIso()}`);
}

main().catch((err) => {
  console.error(`\nMigracja nie powiodla sie: ${err.message}`);
  process.exit(1);
});
