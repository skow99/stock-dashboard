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
  // Wzorzec jest luzny, bo strona nie ma stabilnej struktury. Kilka trafien to
  // przypadkowe liczby z tresci, a nie seria notowan - takie "dane" na wykresie
  // sa gorsze niz ich brak, bo wygladaja wiarygodnie. Zadamy serii, nie okruchow.
  const MIN_PUNKTOW = 30;
  const roznychDni = new Set(points.map((p) => p.day)).size;
  if (points.length < MIN_PUNKTOW || roznychDni < MIN_PUNKTOW) {
    log.debug('history.gpw_rejected', { symbol, points: points.length, roznychDni });
    return null;
  }
  return { providerSymbol: gpwSymbol, points, provider: 'gpw' };
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

// ---------------------------------------------------------------- serie dzienne

/** Historia do odtwarzania zmienia sie raz dziennie - trzymamy ja dobe. */
const DAILY_TTL_MS = 12 * 60 * 60 * 1000;
const dailyInflight = new Map();

/** Poczatek okna pobierania. Jedno stale okno = jeden wpis w cache wspolnym dla wszystkich. */
const DAILY_OD = '2000-01-01';

/**
 * Notowania dzienne za jawnie podany okres. Yahoo respektuje interval=1d tylko wtedy,
 * gdy zakres podany jest przez period1/period2 - parametr range=max jest po cichu
 * zamieniany na dane miesieczne.
 */
async function fromYahooDaily(symbol) {
  const providerSymbol = toYahooSymbol(symbol);
  const period1 = Math.floor(new Date(`${DAILY_OD}T00:00:00Z`).getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(providerSymbol)}`
    + `?interval=1d&period1=${period1}&period2=${period2}`;

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
  return points.length ? { providerSymbol, points, provider: 'yahoo-daily' } : null;
}

/**
 * Pelna dzienna seria zamkniec jako mapa dzien -> cena.
 *
 * Uzywana przy odtwarzaniu historii portfela, gdzie ten sam ticker jest potrzebny
 * dla setek dni. Jedno pobranie na ticker na dobe, cache GLOBALNY na dysku -
 * ceny sa danymi publicznymi, wiec dziela je wszyscy uzytkownicy i wszystkie portfele.
 *
 * @returns {Promise<{ byDay: Record<string, number>, first: string|null, last: string|null, provider: string }>}
 */
export async function getDailyCloses(symbol) {
  const key = `daily|${String(symbol).toUpperCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < DAILY_TTL_MS) return hit.value;
  if (dailyInflight.has(key)) return dailyInflight.get(key);

  const task = (async () => {
    // NIE uzywamy range=max: Yahoo oddaje wtedy dane MIESIECZNE (odstep ~30 dni),
    // mimo interval=1d. Przy odtwarzaniu historii dawalo to luki po kilkanascie dni.
    // Jawny okres period1/period2 zwraca prawdziwe notowania dzienne.
    const seria = (await fromYahooDaily(symbol)) ?? (await fetchSeries(symbol, '10y'));
    if (!seria?.points?.length) {
      // Brak swiezych danych nie kasuje tego, co juz mamy.
      return hit?.value ?? { byDay: {}, first: null, last: null, provider: 'none' };
    }
    const byDay = {};
    for (const point of seria.points) {
      if (Number.isFinite(point.value) && point.value > 0) byDay[point.day] = point.value;
    }
    const dni = Object.keys(byDay).sort();
    const value = {
      byDay,
      first: dni[0] ?? null,
      last: dni[dni.length - 1] ?? null,
      provider: seria.provider,
    };
    cache.set(key, { at: Date.now(), value });
    return value;
  })().finally(() => dailyInflight.delete(key));

  dailyInflight.set(key, task);
  return task;
}

/**
 * Cena z danego dnia albo ostatnia znana wczesniej.
 *
 * Gielda nie pracuje w weekendy i swieta, a portfel w te dni nadal ma wartosc -
 * przenosimy wiec ostatnie zamkniecie. Zwraca null przed pierwszym notowaniem
 * instrumentu, bo tam zadna cena nie bylaby prawdziwa.
 */
export function closeOnOrBefore(seria, day, kursor = { day: null, value: null }) {
  const bezposrednio = seria?.byDay?.[day];
  if (Number.isFinite(bezposrednio)) {
    kursor.day = day;
    kursor.value = bezposrednio;
    return bezposrednio;
  }
  return kursor.value;
}

/**
 * Benchmarki wykresu indeksu portfela.
 *
 * Polskie indeksy NIE maja historii dziennej u zadnego dostepnego dostawcy:
 * Yahoo pod '^WIG20' oddaje zero punktow, a pod 'WIG20.WA' jedna wartosc (dzisiejsza).
 * Archiwum GPW nie da sie juz sparsowac. Dlatego jako serie bierzemy notowania
 * funduszy, ktore te indeksy odwzorowuja - maja prawdziwa historie dzienna
 * i sa w PLN.
 *
 * To swiadome przyblizenie i etykieta o tym mowi. Fundusz rozni sie od indeksu
 * o oplate za zarzadzanie i blad odwzorowania (rzedu ulamka procenta rocznie).
 * W zamian jest to wariant TOTAL RETURN, czyli z dywidendami - a wiec porownywalny
 * z wykresem TWR portfela, ktory dywidendy uwzglednia.
 */
export const BENCHMARKS = [
  { id: 'WIG20', label: 'WIG20TR', symbol: 'ETFBW20TR.WA', proxy: 'Beta ETF WIG20TR' },
  { id: 'MWIG40TR', label: 'mWIG40TR', symbol: 'ETFBM40TR.WA', proxy: 'Beta ETF mWIG40TR' },
  { id: 'NDX', label: 'Nasdaq 100', symbol: '^NDX', proxy: null },
  { id: 'SPX', label: 'S&P 500', symbol: '^GSPC', proxy: null },
];
