// src/market/tickers.mjs - jedno zrodlo prawdy dla normalizacji symboli.
// Ticker spina transakcje, holdingi, sektory, notatki, ceny i wykresy - takze MIEDZY portfelami.

const SUFFIX_ALIASES = { '.PL': '.WA' };
const STRIPPABLE = ['.WA', '.US', '.PL', '.NL', '.FR', '.DE', '.SE', '.GB', '.UK'];

export const CURRENCIES = ['PLN', 'USD', 'EUR', 'SEK', 'GBP', 'CHF'];

/** Kanoniczna postac tickera zapisywana w bazie. */
export function canonicalTicker(raw, { venue = '', currency = '' } = {}) {
  let value = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!value) return '';
  value = value.replace(/^\$/, '');
  for (const [from, to] of Object.entries(SUFFIX_ALIASES)) {
    if (value.endsWith(from)) value = value.slice(0, -from.length) + to;
  }
  if (value.startsWith('^')) return value; // indeksy zostawiamy bez zmian
  if (!value.includes('.')) {
    const v = String(venue).toUpperCase();
    if (['WSE', 'GPW', 'WA', 'PL'].includes(v) || currency === 'PLN') return `${value}.WA`;
    if (['NASDAQ', 'NYSE', 'ARCA', 'BATS', 'US', 'SMART'].includes(v) || currency === 'USD') return `${value}.US`;
    if (v === 'AEB' || v === 'AMS') return `${value}.NL`;
    if (v === 'SBF' || v === 'PAR') return `${value}.FR`;
    return currency === '' ? value : `${value}.US`;
  }
  return value;
}

/** Klucz do porownan miedzy zrodlami: bez sufiksu gieldowego. */
export function normalizeTickerKey(raw) {
  let value = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '').replace(/^\^/, '');
  for (const suffix of STRIPPABLE) {
    if (value.endsWith(suffix)) { value = value.slice(0, -suffix.length); break; }
  }
  return value;
}

const YAHOO_INDEX_ALIASES = {
  WIG20: '^WIG20', '^WIG20': '^WIG20', 'WIG20.WA': '^WIG20',
  MWIG40TR: 'MWIG40TR.WA', '^MWIG40TR': 'MWIG40TR.WA', WIG40TR: 'MWIG40TR.WA', '^WIG40TR': 'MWIG40TR.WA',
  NDX: '^NDX', '^NDX': '^NDX', NASDAQ100: '^NDX',
  SPX: '^GSPC', '^GSPC': '^GSPC', SP500: '^GSPC',
};

/** Symbol w formacie Yahoo Finance. */
export function toYahooSymbol(raw) {
  const value = String(raw ?? '').trim().toUpperCase();
  if (YAHOO_INDEX_ALIASES[value]) return YAHOO_INDEX_ALIASES[value];
  if (value.startsWith('^')) return value;
  if (value.endsWith('.US')) return value.slice(0, -3);
  if (value.endsWith('.PL')) return `${value.slice(0, -3)}.WA`;
  if (value.endsWith('.NL')) return `${value.slice(0, -3)}.AS`;
  if (value.endsWith('.FR')) return `${value.slice(0, -3)}.PA`;
  if (value.endsWith('.GB') || value.endsWith('.UK')) return `${value.slice(0, -3)}.L`;
  if (value.endsWith('.SE')) return `${value.slice(0, -3)}.ST`;
  return value;
}

/** Symbol w formacie Stooq. */
export function toStooqSymbol(raw) {
  const value = String(raw ?? '').trim().toUpperCase();
  if (value.startsWith('^')) return value.toLowerCase();
  if (value.endsWith('.WA') || value.endsWith('.PL')) return value.slice(0, -3).toLowerCase();
  if (value.endsWith('.US')) return value.toLowerCase();
  return `${value.toLowerCase()}.us`;
}

/** Symbol w archiwum GPW (fallback dla indeksow, gdy Yahoo nie ma danych). */
export function toGpwSymbol(raw) {
  const key = normalizeTickerKey(raw);
  if (key === 'WIG20') return 'GPW:WIG20';
  if (['MWIG40TR', 'WIG40TR'].includes(key)) return 'GPW:MWIG40TR';
  if (key === 'WIG') return 'GPW:WIG';
  return null;
}

/** Waluta wywnioskowana z sufiksu tickera. */
export function inferCurrency(ticker, fallback = 'PLN') {
  const value = String(ticker ?? '').toUpperCase();
  if (value.endsWith('.WA') || value.endsWith('.PL')) return 'PLN';
  if (value.endsWith('.US') || !value.includes('.')) return 'USD';
  if (value.endsWith('.NL') || value.endsWith('.FR') || value.endsWith('.DE')) return 'EUR';
  if (value.endsWith('.SE')) return 'SEK';
  if (value.endsWith('.GB') || value.endsWith('.UK')) return 'GBP';
  return fallback;
}

/** Region uzywany przez filtr w tabeli pozycji. */
export function regionOf(ticker, currency) {
  const value = String(ticker ?? '').toUpperCase();
  if (value.endsWith('.US') || currency === 'USD') return 'USA';
  return 'EUROPE';
}
