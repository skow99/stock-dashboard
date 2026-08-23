// src/import/schema.mjs - co znaczy ktora kolumna.
//
// Trzy ksztalty rekordu (transakcje, przeplywy, stan portfela) rozpoznajemy po
// naglowku, a nie po deklaracji uzytkownika. Kazde pole ma liste aliasow PL i EN.
//
// Profile brokerskie (XTB, IBKR) NIE sa sztywnymi schematami pozycyjnymi - to tylko
// dodatkowe aliasy plus transformacje wartosci. Gdy broker zmieni naglowki eksportu,
// import nie przestanie dzialac: cofnie sie do aliasow ogolnych, a w ostatecznosci
// uzytkownik zmapuje kolumny recznie w panelu. Zadna z tych sciezek nie jest slepa.

/** Klucz porownawczy naglowka: bez ogonkow, bez spacji, bez interpunkcji. */
export function normKey(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')            // 'l' z kreska nie ma formy rozlozonej w NFD
    .replace(/[^a-z0-9]/g, '');
}

/** Aliasy pol kanonicznych. Kolejnosc nie ma znaczenia, dopasowanie jest dokladne. */
const FIELD_ALIASES = {
  date: [
    'data', 'date', 'dzien', 'day', 'datatransakcji', 'datazawarcia', 'dataoperacji',
    'dataksiegowania', 'czas', 'czasotwarcia', 'tradedate', 'transactiondate', 'datetime',
    'datatime', 'settlementdate', 'datarozliczenia', 'reportdate',
  ],
  ticker: [
    'ticker', 'symbol', 'instrument', 'walor', 'spolka', 'papier', 'symbolinstrumentu',
    'nazwainstrumentu', 'underlyingsymbol', 'symbolwaloru', 'kodinstrumentu',
  ],
  side: [
    'strona', 'side', 'kierunek', 'buysell', 'bs', 'direction', 'action', 'operacja',
    'rodzajtransakcji', 'typtransakcji', 'transakcja',
  ],
  qty: [
    'ilosc', 'quantity', 'qty', 'liczba', 'wolumen', 'volume', 'shares', 'units',
    'liczbaakcji', 'liczbasztuk', 'sztuk', 'iloscsztuk',
  ],
  price: [
    'cena', 'price', 'kurs', 'cenajednostkowa', 'cenatransakcji', 'tradeprice',
    'unitprice', 'tprice', 'cenaotwarcia', 'kurstransakcji', 'cenaza1szt',
  ],
  fee: [
    'prowizja', 'fee', 'fees', 'commission', 'oplata', 'oplaty', 'koszt', 'koszty',
    'commfee', 'ibcommission', 'prowizjamaklerska',
  ],
  currency: ['waluta', 'currency', 'ccy', 'curr', 'currencyprimary', 'walutarozliczenia'],
  name: [
    'nazwa', 'name', 'opis', 'description', 'nazwaspolki', 'companyname',
    'instrumentname', 'pelnanazwa', 'emitent',
  ],
  note: ['notatka', 'note', 'komentarz', 'comment', 'uwagi', 'remarks', 'opisoperacji'],
  amount: [
    'kwota', 'amount', 'wartosc', 'value', 'suma', 'total', 'netamount',
    'kwotaoperacji', 'wartoscoperacji', 'kwotanetto', 'proceeds',
  ],
  type: ['typ', 'type', 'rodzaj', 'kategoria', 'transactiontype', 'rodzajoperacji', 'typoperacji'],
  avgPrice: [
    'cenasrednia', 'sredniacena', 'avgprice', 'averageprice', 'avg', 'avgcost',
    'cenazakupu', 'sredniacenazakupu', 'costbasisprice', 'cenanabycia', 'sredniprice',
  ],
};

/**
 * Trzy ksztalty rekordu. `required` decyduje o rozpoznaniu: ksztalt kwalifikuje sie
 * tylko wtedy, gdy WSZYSTKIE pola wymagane maja swoja kolumne. Dlatego transakcje
 * i stan portfela sie nie myla - stan nie ma daty ani strony.
 */
export const SHAPES = {
  transactions: {
    required: ['date', 'ticker', 'side', 'qty', 'price'],
    optional: ['fee', 'currency', 'name', 'note'],
    forbidden: [],
  },
  cashflows: {
    required: ['date', 'type', 'amount'],
    optional: ['currency', 'ticker', 'note'],
    forbidden: [],
  },
  holdings: {
    required: ['ticker', 'qty'],
    optional: ['avgPrice', 'currency', 'name'],
    // Stan portfela to zdjecie na dzis - nie ma daty ani strony transakcji.
    // Bez tego warunku ten ksztalt wygrywalby z transakcjami przy niepelnym naglowku.
    forbidden: ['date', 'side', 'type', 'amount'],
  },
};

// ---------------------------------------------------------------- wartosci

const SIDE_ALIASES = {
  BUY: ['buy', 'b', 'kupno', 'kup', 'k', 'zakup', 'bought', 'long', 'purchase', 'kupil', 'nabycie'],
  SELL: ['sell', 's', 'sprzedaz', 'sprzed', 'sold', 'short', 'sale', 'sprzedal', 'zbycie', 'redemption'],
};

/** @returns {'BUY'|'SELL'|null} */
export function parseSide(raw) {
  const key = normKey(raw);
  if (!key) return null;
  for (const [side, aliases] of Object.entries(SIDE_ALIASES)) {
    if (aliases.includes(key)) return side;
  }
  return null;
}

const FLOW_ALIASES = {
  Deposit: ['deposit', 'wplata', 'wplaty', 'przelew', 'zasilenie', 'wplatasrodkow', 'depozyt', 'funding'],
  Withdrawal: ['withdrawal', 'wyplata', 'wyplaty', 'wyplatasrodkow', 'wycofanie', 'przelewwychodzacy'],
  Dividend: ['dividend', 'dywidenda', 'dywidendy', 'dividends', 'wyplatadywidendy', 'payoutdividend'],
  Interest: ['interest', 'odsetki', 'odsetka', 'oprocentowanie', 'creditinterest'],
  Fee: ['fee', 'fees', 'prowizja', 'oplata', 'oplaty', 'commission', 'oplatadepozytowa', 'koszt'],
  Tax: ['tax', 'podatek', 'podatekuzrodla', 'withholdingtax', 'whtax', 'podatekoddywidendy', 'zryczaltowany'],
};

/** @returns {'Deposit'|'Withdrawal'|'Dividend'|'Interest'|'Fee'|'Tax'|null} */
export function parseFlowType(raw) {
  const key = normKey(raw);
  if (!key) return null;
  for (const [type, aliases] of Object.entries(FLOW_ALIASES)) {
    if (aliases.includes(key)) return type;
  }
  // Czesciowe dopasowanie ratuje warianty typu "Podatek u zrodla (USA)".
  for (const [type, aliases] of Object.entries(FLOW_ALIASES)) {
    if (aliases.some((alias) => alias.length >= 5 && key.startsWith(alias))) return type;
  }
  return null;
}

// ---------------------------------------------------------------- profile brokerskie

/**
 * Profil = dodatkowe aliasy + transformacja wiersza. Rozpoznawany po kolumnach
 * charakterystycznych (`signature`), ktore musza wystapic wszystkie.
 *
 * UWAGA: profile powstaly na podstawie dokumentacji formatow, nie na prawdziwych
 * plikach z tych kont. Jesli naglowki sie nie zgadzaja, import po prostu uzyje
 * aliasow ogolnych - profil nigdy nie jest warunkiem powodzenia.
 */
export const PROFILES = {
  ibkr: {
    label: 'Interactive Brokers',
    signature: [['tprice', 'tradeprice'], ['symbol'], ['datetime', 'tradedate']],
    aliases: { qty: ['quantity'], fee: ['commfee', 'ibcommission'], currency: ['currencyprimary'] },
    provides: ['side'], // strona wynika ze znaku ilosci, nie z osobnej kolumny
    /**
     * IBKR podaje ilosc ZE ZNAKIEM (ujemna = sprzedaz) i nie ma osobnej kolumny strony.
     * Prowizja przychodzi jako wartosc ujemna.
     */
    transform(record) {
      if (record.side === null && typeof record.qty === 'number') {
        record.side = record.qty < 0 ? 'SELL' : 'BUY';
      }
      if (typeof record.qty === 'number') record.qty = Math.abs(record.qty);
      if (typeof record.fee === 'number') record.fee = Math.abs(record.fee);
      return record;
    },
  },

  xtb: {
    label: 'XTB',
    signature: [['symbol'], ['typ', 'type'], ['wolumen', 'ilosc', 'kwota']],
    aliases: { price: ['cenaotwarcia'], date: ['czasotwarcia', 'czas'], qty: ['wolumen'] },
    provides: ['side'], // "Typ" niesie i strone transakcji, i rodzaj operacji gotowkowej
    /**
     * XTB miesza strone transakcji i rodzaj operacji gotowkowej w jednej kolumnie "Typ".
     * Rozdzielamy je: co da sie odczytac jako BUY/SELL idzie na strone, reszta zostaje
     * rodzajem przeplywu.
     */
    transform(record) {
      if (record.side === null && record.type) {
        const side = parseSide(record.type);
        if (side) { record.side = side; record.type = null; }
      }
      if (typeof record.fee === 'number') record.fee = Math.abs(record.fee);
      return record;
    },
  },
};

/** @returns {string} klucz profilu albo 'canonical' */
export function detectProfile(headerKeys) {
  const present = new Set(headerKeys);
  for (const [key, profile] of Object.entries(PROFILES)) {
    const matches = profile.signature.every((group) => group.some((col) => present.has(col)));
    if (matches) return key;
  }
  return 'canonical';
}

// ---------------------------------------------------------------- mapowanie naglowka

/**
 * Naglowek -> mapa pole kanoniczne => indeks kolumny.
 * Pierwsza pasujaca kolumna wygrywa; duplikaty naglowka sa ignorowane.
 */
export function mapHeader(header, profileKey = 'canonical') {
  const profile = PROFILES[profileKey];
  const keys = header.map(normKey);
  const mapping = {};
  const unmatched = [];

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (!key) continue;
    let matched = null;
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      const extra = profile?.aliases?.[field] ?? [];
      if (aliases.includes(key) || extra.includes(key)) { matched = field; break; }
    }
    // Kolumna nierozpoznana ALBO druga w kolejnosci dla tego samego pola trafia
    // na liste do recznego przypisania - uzytkownik moze chciec wlasnie tej drugiej.
    if (matched && mapping[matched] === undefined) mapping[matched] = i;
    else unmatched.push({ index: i, label: header[i] });
  }
  return { mapping, unmatched };
}

/**
 * Wybiera ksztalt rekordu pasujacy do mapowania.
 *
 * `provides` to pola, ktorych nie ma w naglowku, ale profil je wyliczy - np. IBKR
 * nie ma kolumny "strona", bo koduje ja znakiem ilosci. Bez tego argumentu plik
 * z IBKR zostalby uznany za stan portfela.
 *
 * @returns {{ shape: string|null, missing: string[], closest?: string }}
 */
export function detectShape(mapping, { provides = [] } = {}) {
  const has = (field) => mapping[field] !== undefined || provides.includes(field);
  const scored = [];
  for (const [shape, def] of Object.entries(SHAPES)) {
    if ((def.forbidden ?? []).some((field) => mapping[field] !== undefined)) continue;
    const missing = def.required.filter((field) => !has(field));
    const optionalHits = def.optional.filter((field) => has(field)).length;
    scored.push({ shape, missing, score: def.required.length - missing.length + optionalHits * 0.1 });
  }
  if (!scored.length) return { shape: null, missing: [], closest: null };

  const complete = scored.filter((s) => !s.missing.length).sort((a, b) => b.score - a.score);
  if (complete.length) return { shape: complete[0].shape, missing: [] };

  // Nic nie pasuje w calosci - zwracamy najblizszy ksztalt, zeby powiedziec
  // uzytkownikowi, czego konkretnie brakuje, zamiast "nie rozpoznano pliku".
  const best = scored.sort((a, b) => b.score - a.score)[0];
  return { shape: null, missing: best.missing, closest: best.shape };
}

/** Pola, ktore uzytkownik moze przypisac recznie w panelu. */
export const ASSIGNABLE_FIELDS = Object.keys(FIELD_ALIASES);
