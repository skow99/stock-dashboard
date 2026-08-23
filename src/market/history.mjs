// src/market/history.mjs - historia cen instrumentow i benchmarkow (cache stale-while-revalidate).
import path from 'node:path';
import config from '../config.mjs';
import { createDiskCache } from '../jsonstore.mjs';
import { fetchJson, fetchText } from './providers.mjs';
import { toYahooSymbol, toGpwSymbol } from './tickers.mjs';
import { log } from '../log.mjs';

const cache = createDiskCache(path.join(config.cacheDir, 'price-history-cache.json'), { flushMs: 5000 });
const refreshing = new Set();

export const RANGES = ['1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max'];
export const UI_RANGE_TO_PROVIDER = { T: '1mo', M: '3mo', Q: '6mo', Y: '2y', A: '10y' };

export function normalizeRange(range) {
  const value = String(range ?? '').trim();
  if (UI_RANGE_TO_PROVIDER[value.toUpperCase()]) return UI_RANGE_TO_PROVIDER[value.toUpperCase()];
  return RANGES.includes(value) ? value : '1y';
}

async function fromYahoo(symbol, range) {
  const providerSymbol = toYahooSymbol(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(providerSymbol)}?interval=1d&range=${range}`;
  const json = await fetchJson('yahoo', url);
  const result = json?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close;
  const stamps = result?.timestamp;
  if (!Array.isArray(closes) || !Array.isArray(stamps)) return null;
  const points = [];
  for (let i = 0; i < stamps.length; i += 1) {
    const value = closes[i];
    if (!Number.isFinite(value)) continue;
    points.push({ day: new Date(stamps[i] * 1000).toISOString().slice(0, 10), value });
  }
  return points.length ? { providerSymbol, points, provider: 'yahoo' } : null;
}

/** Fallback dla indeksow GPW, gdy Yahoo nie ma serii (dotyczy m.in. mWIG40TR). */
async function fromGpw(symbol) {
  const gpwSymbol = toGpwSymbol(symbol);
  if (!gpwSymbol) return null;
  const text = await fetchText('gpw', 'https://www.gpw.pl/archiwum-notowan');
  if (!text) return null;
  const points = [];
  const re = /(\d{4}-\d{2}-\d{2})[^0-9]{1,40}([0-9]{1,3}(?:[\s\u00a0\u2009]?[0-9]{3})*(?:[.,][0-9]+)?)/g;
  let match = re.exec(text);
  while (match && points.length < 4000) {
    const value = Number.parseFloat(match[2].replace(/[\s\u00a0\u2009]/g, '').replace(',', '.'));
    if (Number.isFinite(value)) points.push({ day: match[1], value });
    match = re.exec(text);
  }
  return points.length ? { providerSymbol: gpwSymbol, points, provider: 'gpw' } : null;
}

async function fetchSeries(symbol, range) {
  return (await fromYahoo(symbol, range)) ?? (await fromGpw(symbol));
}

/**
 * Zwraca historie z cache jesli swieza; jesli stara - zwraca natychmiast i odswieza w tle.
 * Dzieki temu dashboard nigdy nie czeka na wolne zrodlo.
 */
export async function getPriceHistory(symbol, uiRange) {
  const range = normalizeRange(uiRange);
  const key = `${String(symbol).toUpperCase()}|${range}`;
  const hit = cache.get(key);
  const now = Date.now();

  if (hit && now - hit.at < config.priceHistoryFreshMs) {
    return { ...hit.value, cached: true, cacheAgeMs: now - hit.at, stale: false };
  }

  if (hit) {
    if (!refreshing.has(key)) {
      refreshing.add(key);
      fetchSeries(symbol, range)
        .then((fresh) => { if (fresh) cache.set(key, { at: Date.now(), value: fresh }); })
        .catch((err) => log.debug('history.background_refresh_failed', { key, error: err.message }))
        .finally(() => refreshing.delete(key));
    }
    return { ...hit.value, cached: true, cacheAgeMs: now - hit.at, stale: true };
  }

  const fresh = await fetchSeries(symbol, range);
  if (!fresh) return { providerSymbol: null, points: [], provider: 'none', cached: false, cacheAgeMs: 0, stale: true };
  cache.set(key, { at: Date.now(), value: fresh });
  return { ...fresh, cached: false, cacheAgeMs: 0, stale: false };
}

export function flushHistoryCache() {
  cache.flushNow();
}

export const BENCHMARKS = [
  { id: 'WIG20', label: 'WIG20', symbol: '^WIG20' },
  { id: 'MWIG40TR', label: 'mWIG40TR', symbol: 'MWIG40TR' },
  { id: 'NDX', label: 'Nasdaq 100', symbol: '^NDX' },
  { id: 'SPX', label: 'S&P 500', symbol: '^GSPC' },
];
