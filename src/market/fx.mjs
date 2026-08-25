// src/market/fx.mjs - kursy walut wzgledem PLN: biezace i historyczne.
//
// Cache jest GLOBALNY - kursy to dane publiczne, wspolne dla wszystkich uzytkownikow
// i wszystkich portfeli. Jedno pobranie obsluguje cala instancje.
//
// Zrodlem jest Yahoo Finance (para w postaci 'USDPLN=X'). Do sierpnia 2026 bylo nim
// Stooq, ale ten zaczal wymagac wykonania JavaScriptu, wiec kursy cicho spadaly do
// wartosci awaryjnych zaszytych w kodzie - pozycje w USD byly liczone po stalej.
import path from 'node:path';
import config from '../config.mjs';
import { createDiskCache } from '../jsonstore.mjs';
import { fetchJson } from './providers.mjs';
import { log } from '../log.mjs';

export const FX_FALLBACK = { USDPLN: 3.57, EURPLN: 4.22, SEKPLN: 0.395, GBPPLN: 4.85, CHFPLN: 4.45, DKKPLN: 0.566, PLNPLN: 1 };

const cache = createDiskCache(path.join(config.cacheDir, 'fx-cache.json'), { flushMs: 5000 });
const FX_TTL_MS = 30 * 60 * 1000;
/** Historia zmienia sie raz dziennie - trzymamy ja dobe, zeby nie odpytywac na kazde przeliczenie. */
const FX_HISTORY_TTL_MS = 12 * 60 * 60 * 1000;

let inflight = null;
const historyInflight = new Map();

export const PAIRS = ['USDPLN', 'EURPLN', 'SEKPLN', 'GBPPLN', 'CHFPLN', 'DKKPLN'];

const yahooSymbol = (pair) => `${pair}=X`;

async function fetchPair(pair) {
  const json = await fetchJson('yahoo', `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol(pair)}?interval=1d&range=5d`);
  const price = Number(json?.chart?.result?.[0]?.meta?.regularMarketPrice);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** Zwraca mape kursow + metadane o zrodle kazdego kursu (wazne dla wiarygodnosci snapshotu). */
export async function getFxRates() {
  const cached = cache.get('rates');
  if (cached && Date.now() - cached.at < FX_TTL_MS) return cached.value;
  if (inflight) return inflight;

  inflight = (async () => {
    const rates = { PLNPLN: 1 };
    const sources = {};
    for (const pair of PAIRS) {
      // eslint-disable-next-line no-await-in-loop
      const live = await fetchPair(pair);
      if (live) {
        rates[pair] = live;
        sources[pair] = 'yahoo';
      } else if (cached?.value?.rates?.[pair]) {
        rates[pair] = cached.value.rates[pair];
        sources[pair] = 'cache';
      } else {
        rates[pair] = FX_FALLBACK[pair];
        sources[pair] = 'fallback';
      }
    }
    const value = { rates, sources, asOf: new Date().toISOString() };
    cache.set('rates', { at: Date.now(), value });
    cache.flushNow();

    const awaryjne = Object.entries(sources).filter(([, s]) => s === 'fallback').map(([p]) => p);
    if (awaryjne.length) log.warn('fx.fallback_used', { pairs: awaryjne });
    else log.debug('fx.refreshed', { sources });
    return value;
  })().finally(() => { inflight = null; });

  return inflight;
}

// ---------------------------------------------------------------- historia

async function fetchPairHistory(pair) {
  const json = await fetchJson(
    'yahoo',
    `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol(pair)}?interval=1d&range=10y`,
  );
  const result = json?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close;
  const stamps = result?.timestamp;
  if (!Array.isArray(closes) || !Array.isArray(stamps)) return null;

  const byDay = {};
  for (let i = 0; i < stamps.length; i += 1) {
    const value = Number(closes[i]);
    if (!Number.isFinite(value) || value <= 0) continue;
    byDay[new Date(stamps[i] * 1000).toISOString().slice(0, 10)] = value;
  }
  return Object.keys(byDay).length ? byDay : null;
}

/**
 * Historia jednej pary, jako mapa dzien -> kurs. Jedno pobranie na pare na dobe,
 * wspoldzielone przez wszystkich uzytkownikow.
 */
export async function getPairHistory(pair) {
  const key = `history|${pair}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FX_HISTORY_TTL_MS) return hit.value;
  if (historyInflight.has(pair)) return historyInflight.get(pair);

  const task = (async () => {
    const fresh = await fetchPairHistory(pair);
    if (fresh) {
      cache.set(key, { at: Date.now(), value: fresh });
      return fresh;
    }
    // Zrodlo nie odpowiada - lepsza stara historia niz zadna.
    return hit?.value ?? null;
  })().finally(() => historyInflight.delete(pair));

  historyInflight.set(pair, task);
  return task;
}

/**
 * Historia wszystkich par naraz.
 * @returns {Promise<Record<string, Record<string, number>>>} para -> (dzien -> kurs)
 */
export async function getFxHistory(pairs = PAIRS) {
  const out = {};
  const wyniki = await Promise.all(pairs.map((pair) => getPairHistory(pair)));
  pairs.forEach((pair, i) => { if (wyniki[i]) out[pair] = wyniki[i]; });
  return out;
}

/**
 * Kursy obowiazujace danego dnia, w formacie przyjmowanym przez fxToPln.
 * Dni bez notowan (weekendy, swieta) dostaja ostatni znany kurs - waluta nie
 * przestaje istniec w sobote.
 */
export function ratesForDay(history, day, ostatnieZnane = {}) {
  const rates = { PLNPLN: 1 };
  for (const pair of PAIRS) {
    const seria = history?.[pair];
    const wartosc = seria?.[day];
    if (Number.isFinite(wartosc)) {
      rates[pair] = wartosc;
      ostatnieZnane[pair] = wartosc;
    } else {
      rates[pair] = ostatnieZnane[pair] ?? FX_FALLBACK[pair];
    }
  }
  return rates;
}

/** Przelicznik waluty na PLN. Nieznane waluty traktujemy jako 1:1 i logujemy. */
export function fxToPln(rates, currency) {
  const code = String(currency ?? 'PLN').toUpperCase();
  if (code === 'PLN') return 1;
  const rate = rates?.[`${code}PLN`] ?? FX_FALLBACK[`${code}PLN`];
  if (!Number.isFinite(rate)) {
    log.warn('fx.unknown_currency', { currency: code });
    return 1;
  }
  return rate;
}

export function flushFxCache() {
  cache.flushNow();
}
