// src/market/sector.mjs - wyszukiwanie sektora GICS dla tickera (Yahoo assetProfile).
// Osobny cache dyskowy i osobny provider dla bezpiecznika - awaria tego endpointu
// nie moze zamknac zwyklych notowan cenowych (i odwrotnie).
import path from 'node:path';
import config from '../config.mjs';
import { createDiskCache } from '../jsonstore.mjs';
import { fetchJson } from './providers.mjs';
import { toYahooSymbol, normalizeTickerKey } from './tickers.mjs';
import { log } from '../log.mjs';

const cache = createDiskCache(path.join(config.cacheDir, 'sector-cache.json'));
const SECTOR_TTL_MS = 90 * 24 * 3600 * 1000; // sektor GICS zmienia sie rzadko - cache trzyma go dlugo

const memo = new Map(); // klucz -> sector|null
const inflight = new Map();

async function fromYahooProfile(symbol) {
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(toYahooSymbol(symbol))}?modules=assetProfile`;
  const json = await fetchJson('yahoo-sector', url);
  const sector = json?.quoteSummary?.result?.[0]?.assetProfile?.sector;
  return typeof sector === 'string' && sector.trim() ? sector.trim() : null;
}

/** Sektor jednego tickera. Zwraca null zamiast rzucac - wolajacy decyduje o wartosci domyslnej. */
export async function getSector(symbol) {
  const key = normalizeTickerKey(symbol);
  if (!key) return null;

  const memoized = memo.get(key);
  if (memoized !== undefined) return memoized;
  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < SECTOR_TTL_MS) {
      memo.set(key, cached.sector);
      return cached.sector;
    }

    const sector = await fromYahooProfile(symbol);
    if (sector) {
      cache.set(key, { sector, at: Date.now() });
      memo.set(key, sector);
      return sector;
    }

    // Brak wyniku (np. ETF bez assetProfile, symbol nierozpoznany) - nie zapisujemy
    // na dysk, zeby przy nastepnym uruchomieniu sprobowac ponownie zamiast utknac na null.
    if (cached) { memo.set(key, cached.sector); return cached.sector; }
    memo.set(key, null);
    return null;
  })().finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

/** Sektory dla listy symboli, rownolegle z ograniczeniem wspolbieznosci. */
export async function getSectorsFor(symbols, { concurrency = 4 } = {}) {
  const out = new Map();
  const queue = [...new Set(symbols)];
  const workers = Array.from({ length: Math.min(concurrency, Math.max(queue.length, 1)) }, async () => {
    while (queue.length) {
      const symbol = queue.shift();
      // eslint-disable-next-line no-await-in-loop
      const sector = await getSector(symbol);
      if (sector) out.set(normalizeTickerKey(symbol), sector);
    }
  });
  await Promise.all(workers);
  log.debug('sector.lookup_batch', { requested: symbols.length, resolved: out.size });
  return out;
}
