// src/market/fx.mjs - kursy walut wzgledem PLN, wspoldzielone przez wszystkie portfele.
import path from 'node:path';
import config from '../config.mjs';
import { createDiskCache } from '../jsonstore.mjs';
import { fetchText } from './providers.mjs';
import { log } from '../log.mjs';

export const FX_FALLBACK = { USDPLN: 3.57, EURPLN: 4.22, SEKPLN: 0.395, GBPPLN: 4.85, CHFPLN: 4.45, PLNPLN: 1 };

const cache = createDiskCache(path.join(config.cacheDir, 'fx-cache.json'));
const FX_TTL_MS = 30 * 60 * 1000;
let inflight = null;

const PAIRS = ['USDPLN', 'EURPLN', 'SEKPLN', 'GBPPLN', 'CHFPLN'];

async function fetchPair(pair) {
  const text = await fetchText('stooq', `https://stooq.com/q/l/?s=${pair.toLowerCase()}&f=sd2t2ohlcv&e=csv`);
  if (!text) return null;
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const cols = lines[1].split(',');
  const close = Number.parseFloat(cols[6]);
  return Number.isFinite(close) && close > 0 ? close : null;
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
      const live = await fetchPair(pair);
      if (live) {
        rates[pair] = live;
        sources[pair] = 'stooq';
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
    log.debug('fx.refreshed', { sources });
    return value;
  })().finally(() => { inflight = null; });

  return inflight;
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
