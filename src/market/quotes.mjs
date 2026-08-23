// src/market/quotes.mjs - biezace notowania z lancuchem fallbackow i cache dyskowym.
// Cache jest GLOBALNY (wspoldzielony przez portfele i uzytkownikow) - to sa dane publiczne, nie prywatne.
import path from 'node:path';
import config from '../config.mjs';
import { createDiskCache } from '../jsonstore.mjs';
import { fetchText, fetchJson } from './providers.mjs';
import { toStooqSymbol, toYahooSymbol, normalizeTickerKey } from './tickers.mjs';
import { lastBusinessDay, todayWarsaw } from '../dates.mjs';
import { log } from '../log.mjs';

const cache = createDiskCache(path.join(config.cacheDir, 'quote-cache.json'));
const MEMO_TTL_MS = 60 * 1000;
const memo = new Map(); // symbol -> { at, quote }
const inflight = new Map();

function cacheKeys(symbol) {
  const upper = String(symbol).toUpperCase();
  return [upper, upper.toLowerCase(), normalizeTickerKey(upper)];
}

function readCache(symbol) {
  for (const key of cacheKeys(symbol)) {
    const hit = cache.get(key);
    if (hit && Number.isFinite(hit.price)) return hit;
  }
  return null;
}

function writeCache(symbol, quote) {
  for (const key of cacheKeys(symbol)) cache.set(key, quote);
}

/**
 * Odpowiedz ze Stooq ma byc plikiem CSV. Od sierpnia 2026 serwis oddaje na kodzie 200
 * strone antybotowa ("This site requires JavaScript to verify your browser") z zagadka
 * proof-of-work, ktorej serwer bez silnika JavaScript nie rozwiaze. Bez tej kontroli
 * traktowalibysmy taka strone jako poprawna odpowiedz.
 */
export const wygladaJakCsv = (text) => {
  const t = String(text).trim();
  return t.length > 0 && !t.startsWith('<') && !/<!DOCTYPE|<html|<script/i.test(t.slice(0, 200)) && t.includes(',');
};

async function fromStooqLive(symbol) {
  const text = await fetchText(
    'stooq',
    `https://stooq.com/q/l/?s=${toStooqSymbol(symbol)}&f=sd2t2ohlcv&e=csv`,
    { looksValid: wygladaJakCsv },
  );
  if (!text) return null;
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const [, day, , open, , , close] = lines[1].split(',');
  const price = Number.parseFloat(close);
  const openPrice = Number.parseFloat(open);
  if (!Number.isFinite(price) || price <= 0) return null;
  return { price, prevClose: Number.isFinite(openPrice) ? openPrice : null, day, source: 'stooq' };
}

async function fromStooqDaily(symbol) {
  const text = await fetchText(
    'stooq',
    `https://stooq.com/q/d/l/?s=${toStooqSymbol(symbol)}&i=d`,
    { looksValid: wygladaJakCsv },
  );
  if (!text) return null;
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 3) return null;
  const last = lines[lines.length - 1].split(',');
  const prev = lines[lines.length - 2].split(',');
  const price = Number.parseFloat(last[4]);
  const prevClose = Number.parseFloat(prev[4]);
  if (!Number.isFinite(price) || price <= 0) return null;
  return { price, prevClose: Number.isFinite(prevClose) ? prevClose : null, day: last[0], source: 'stooq-daily' };
}

async function fromYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(toYahooSymbol(symbol))}?interval=1d&range=5d`;
  const json = await fetchJson('yahoo', url);
  const result = json?.chart?.result?.[0];
  if (!result) return null;
  const meta = result.meta ?? {};
  const price = Number(meta.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  const stamps = result.timestamp ?? [];
  const day = stamps.length
    ? new Date(stamps[stamps.length - 1] * 1000).toISOString().slice(0, 10)
    : todayWarsaw();
  return {
    price,
    prevClose: Number.isFinite(Number(meta.chartPreviousClose)) ? Number(meta.chartPreviousClose) : null,
    day,
    currency: meta.currency,
    source: 'yahoo',
  };
}

/**
 * Kolejnosc zrodel. Yahoo jest pierwsze, bo Stooq przestal byc uzyteczny dla serwera:
 * endpoint biezacych notowan zwraca 404 z bledem ich wlasnej bazy, a endpoint dzienny
 * jest za zabezpieczeniem antybotowym wymagajacym wykonania JavaScriptu.
 *
 * Stooq zostaje jako zapas, bo moze wrocic - z dzialajacym bezpiecznikiem kosztuje to
 * kilka nieudanych zapytan na minute, nie wiecej.
 *
 * Uwaga na 'source' z holdingow: wartosc 'stooq' jest tam zapisywana AUTOMATYCZNIE
 * jako domyslna, a nie wybrana przez uzytkownika. Dlatego nie traktujemy jej jako
 * preferencji - inaczej kazdy portfel zaczynalby od martwego zrodla.
 */
const LANCUCH = [fromYahoo, fromStooqLive, fromStooqDaily];

/** Cena jednego instrumentu. Nigdy nie rzuca - zwraca obiekt ze statusem swiezosci. */
export async function getQuote(symbol, { fallbackPrice = null } = {}) {
  const key = String(symbol).toUpperCase();
  const memoized = memo.get(key);
  if (memoized && Date.now() - memoized.at < MEMO_TTL_MS) return memoized.quote;
  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    const chain = LANCUCH;

    let quote = null;
    for (const provider of chain) {
      // eslint-disable-next-line no-await-in-loop
      quote = await provider(key);
      if (quote) break;
    }

    const expectedDay = lastBusinessDay();
    if (quote && quote.day && quote.day < expectedDay) {
      const cached = readCache(key);
      if (cached && cached.day && cached.day >= quote.day) quote = { ...cached, source: `${cached.source}-cache` };
    }
    if (!quote) {
      const cached = readCache(key);
      if (cached) quote = { ...cached, source: `${cached.source}-cache`, stale: true };
    }
    if (!quote && Number.isFinite(fallbackPrice)) {
      quote = { price: fallbackPrice, prevClose: fallbackPrice, day: null, source: 'fallback', stale: true };
    }
    if (!quote) {
      quote = { price: null, prevClose: null, day: null, source: 'none', stale: true };
    } else if (quote.source !== 'fallback' && !String(quote.source).endsWith('-cache')) {
      writeCache(key, { price: quote.price, prevClose: quote.prevClose, day: quote.day, source: quote.source, at: Date.now() });
    }

    quote.symbol = key;
    quote.fresh = Boolean(quote.day && quote.day >= expectedDay);
    memo.set(key, { at: Date.now(), quote });
    return quote;
  })().finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

/** Notowania dla listy symboli, rownolegle z ograniczeniem wspolbieznosci. */
export async function getQuotes(specs, { concurrency = 6 } = {}) {
  const out = new Map();
  const queue = [...specs];
  const workers = Array.from({ length: Math.min(concurrency, Math.max(queue.length, 1)) }, async () => {
    while (queue.length) {
      const spec = queue.shift();
      // eslint-disable-next-line no-await-in-loop
      const quote = await getQuote(spec.symbol, { fallbackPrice: spec.fallbackPrice });
      out.set(String(spec.symbol).toUpperCase(), quote);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Udzial swiezych notowan - brama dla zapisu historii EOD. */
export function coverage(quotes) {
  const values = [...quotes.values()];
  if (!values.length) return { total: 0, fresh: 0, ratio: 1 };
  const fresh = values.filter((q) => q.fresh).length;
  return { total: values.length, fresh, ratio: fresh / values.length };
}

export function flushQuoteCache() {
  cache.flushNow();
  log.debug('quotes.cache_flushed', { keys: cache.keys().length });
}
