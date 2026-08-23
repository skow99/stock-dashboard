// src/import/csv.mjs - odczyt plikow tabelarycznych bez zadnej zaleznosci npm.
//
// Pliki, ktore ludzie naprawde wrzucaja, sa niechlujne: Excel na Windows zapisuje
// w Windows-1250 i rozdziela srednikiem, bank eksportuje przecinkiem, broker
// tabulatorem, a liczby maja spacje nierozdzielajace w srodku. Ten modul sprowadza
// to wszystko do tablicy tablic i do liczb typu Number.
//
// Zasada nadrzedna: nic nie zgadujemy per komorka, jesli mozemy wywnioskowac
// z calej kolumny. Separator dziesietny i format daty ustalamy raz dla kolumny -
// dzieki temu "1,234" w kolumnie, gdzie indziej stoi "12,5", jest czytane jako 1,234
// zamiast jako tysiac dwiescie trzydziesci cztery.

const NBSP = /[   ]/g;      // spacje nierozdzielajace uzywane jako separator tysiecy
const APOSTROPHE = /[’']/g;           // szwajcarski separator tysiecy: 1'234.56

/**
 * Bajty -> tekst. Rozpoznaje BOM, a przy niepoprawnym UTF-8 wraca do Windows-1250
 * (to domyslne kodowanie Excela na polskim Windows).
 * @returns {{ text: string, encoding: string }}
 */
export function decodeBytes(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  }
  // UTF-16 spotyka sie w eksportach "Unicode text" z Excela.
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
  }

  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1250').decode(buf), encoding: 'windows-1250' };
  }
}

/**
 * Separator kolumn. Liczymy wystapienia POZA cudzyslowami - inaczej przecinek
 * w nazwie spolki ("Acme, Inc.") przewazylby glosowanie.
 */
export function detectDelimiter(text) {
  const candidates = [';', ',', '\t', '|'];
  const sample = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 20);
  if (!sample.length) return ',';

  let best = ',';
  let bestScore = -1;
  for (const delimiter of candidates) {
    const counts = sample.map((line) => countOutsideQuotes(line, delimiter));
    if (!counts.some((c) => c > 0)) continue;
    // Dobry separator daje TE SAMA liczbe kolumn w kazdym wierszu. Premiujemy stalosc,
    // a nie samo wystapienie - stad kara za odchylenie.
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
    const score = mean - variance * 2;
    if (score > bestScore) { bestScore = score; best = delimiter; }
  }
  return best;
}

function countOutsideQuotes(line, delimiter) {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { i += 1; continue; }
      inQuotes = !inQuotes;
    } else if (!inQuotes && ch === delimiter) count += 1;
  }
  return count;
}

/**
 * Parser CSV zgodny z RFC 4180: cudzyslowy, podwojony cudzyslow w srodku,
 * znaki nowej linii wewnatrz pola.
 * @returns {{ delimiter: string, rows: string[][] }}
 */
export function parseCsv(text, { delimiter = null } = {}) {
  const sep = delimiter ?? detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => {
    pushField();
    // Wiersz zlozony z samych pustych pol to zwykle pusta linia w pliku.
    if (row.some((cell) => cell.trim() !== '')) rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }

    if (ch === '"' && field.trim() === '') { inQuotes = true; field = ''; i += 1; continue; }
    if (ch === sep) { pushField(); i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\n') { pushRow(); i += 1; continue; }
    field += ch; i += 1;
  }
  if (field !== '' || row.length) pushRow();

  return { delimiter: sep, rows };
}

// ---------------------------------------------------------------- liczby

/**
 * Ustala separator dziesietny dla CALEJ kolumny. To jedyny sposob, zeby
 * bezpiecznie odczytac "1,234" - w izolacji ta wartosc jest nierozstrzygalna.
 * @returns {'dot'|'comma'}
 */
export function inferDecimalSeparator(values) {
  const cleaned = values
    .map((v) => String(v ?? '').replace(NBSP, ' ').replace(APOSTROPHE, '').trim())
    .filter((v) => /\d/.test(v));

  for (const value of cleaned) {
    const lastDot = value.lastIndexOf('.');
    const lastComma = value.lastIndexOf(',');
    // Oba znaki w jednej liczbie: ten dalej z prawej jest dziesietny.
    if (lastDot >= 0 && lastComma >= 0) return lastDot > lastComma ? 'dot' : 'comma';
  }

  for (const value of cleaned) {
    // Separator powtorzony (1.234.567) moze byc tylko separatorem tysiecy.
    if ((value.match(/\./g) ?? []).length > 1) return 'comma';
    if ((value.match(/,/g) ?? []).length > 1) return 'dot';
  }

  for (const value of cleaned) {
    // Liczba cyfr po separatorze rozna od 3 wyklucza grupowanie tysiecy.
    const dot = /\.(\d+)$/.exec(value);
    if (dot && dot[1].length !== 3) return 'dot';
    const comma = /,(\d+)$/.exec(value);
    if (comma && comma[1].length !== 3) return 'comma';
  }

  // Same przypadki niejednoznaczne (np. wylacznie "1,234"). Kontekst jest polski,
  // wiec przecinek traktujemy jako dziesietny - to samo zalozenie ma Excel PL.
  return 'comma';
}

/**
 * Tekst -> liczba. Zwraca null, gdy wartosc nie jest liczba (pusta komorka, myslnik).
 * Obsluguje nawiasy ksiegowe: "(1 234,56)" == -1234.56.
 */
export function parseNumber(raw, style = 'comma') {
  let value = String(raw ?? '').replace(NBSP, '').replace(APOSTROPHE, '').replace(/\s/g, '').trim();
  if (!value || value === '-' || value === '—') return null;

  value = value.replace(/(PLN|USD|EUR|GBP|CHF|SEK|zl|zł|\$|€|£)/gi, '');

  let negative = false;
  if (/^\(.*\)$/.test(value)) { negative = true; value = value.slice(1, -1); }
  if (value.startsWith('-')) { negative = true; value = value.slice(1); }
  else if (value.startsWith('+')) value = value.slice(1);

  if (style === 'comma') value = value.replace(/\./g, '').replace(',', '.');
  else value = value.replace(/,/g, '');

  if (!/^\d*\.?\d+$/.test(value) && !/^\d+\.?\d*$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// ---------------------------------------------------------------- daty

const DATE_PATTERNS = [
  { re: /^(\d{4})-(\d{2})-(\d{2})$/, order: 'ymd' },
  { re: /^(\d{4})\/(\d{2})\/(\d{2})$/, order: 'ymd' },
  { re: /^(\d{4})(\d{2})(\d{2})$/, order: 'ymd' },            // IBKR Flex: 20260115
  { re: /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, order: 'dmy' },    // zapis polski
  { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, order: 'slash' },  // niejednoznaczny
  { re: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, order: 'slash' },
];

/**
 * Ustala, czy "03/04/2026" to 3 kwietnia czy 4 marca - na podstawie calej kolumny.
 * @returns {'dmy'|'mdy'}
 */
export function inferSlashOrder(values) {
  for (const raw of values) {
    const value = String(raw ?? '').trim().split(/[ T]/)[0];
    const m = /^(\d{1,2})[/-](\d{1,2})[/-]\d{4}$/.exec(value);
    if (!m) continue;
    if (Number(m[1]) > 12) return 'dmy';   // pierwsza liczba > 12 moze byc tylko dniem
    if (Number(m[2]) > 12) return 'mdy';
  }
  return 'dmy'; // domyslnie europejsko
}

/** Tekst -> 'YYYY-MM-DD'. Zwraca null przy nierozpoznanym formacie lub nieistniejacej dacie. */
export function parseDate(raw, slashOrder = 'dmy') {
  const value = String(raw ?? '').trim().split(/[ T]/)[0].replace(/,$/, '');
  if (!value) return null;

  for (const { re, order } of DATE_PATTERNS) {
    const m = re.exec(value);
    if (!m) continue;
    let year; let month; let day;
    if (order === 'ymd') [, year, month, day] = m;
    else if (order === 'dmy') [, day, month, year] = m;
    else if (slashOrder === 'mdy') [, month, day, year] = m;
    else [, day, month, year] = m;

    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    // Walidacja przez round-trip lapie 31.02 i podobne.
    const parsed = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) return null;
    return iso;
  }
  return null;
}
