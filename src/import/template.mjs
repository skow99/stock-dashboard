// src/import/template.mjs - wzorce plikow do pobrania z panelu.
//
// Naglowki sa w jezyku interfejsu, bo i tak rozpoznajemy oba. Separator: srednik,
// bo tego oczekuje Excel w polskiej lokalizacji, a przecinek w liczbie i tak by go
// rozjechal. Liczby zapisujemy przecinkiem dziesietnym dla PL i kropka dla EN -
// dzieki temu plik otwarty w arkuszu od razu wyglada poprawnie.

import { DEFAULT_LOCALE, isSupported } from '../i18n.mjs';

const TEMPLATES = {
  pl: {
    transactions: {
      header: ['data', 'ticker', 'strona', 'ilosc', 'cena', 'prowizja', 'waluta', 'nazwa', 'notatka'],
      rows: [
        ['2026-01-15', 'AAPL.US', 'BUY', '10', '185,50', '1,20', 'USD', 'Apple Inc', ''],
        ['2026-03-02', 'CDR.WA', 'SELL', '50', '142,00', '3,50', 'PLN', 'CD Projekt', 'realizacja zysku'],
      ],
    },
    cashflows: {
      header: ['data', 'typ', 'kwota', 'waluta', 'ticker', 'notatka'],
      rows: [
        ['2026-01-02', 'Wplata', '10000', 'PLN', '', 'przelew z konta'],
        ['2026-02-14', 'Dywidenda', '23,40', 'USD', 'AAPL.US', 'dywidenda kwartalna'],
        ['2026-02-14', 'Podatek', '3,51', 'USD', 'AAPL.US', 'podatek u zrodla'],
      ],
    },
    holdings: {
      header: ['ticker', 'ilosc', 'cena_srednia', 'waluta', 'nazwa'],
      rows: [
        ['AAPL.US', '10', '185,50', 'USD', 'Apple Inc'],
        ['CDR.WA', '50', '128,40', 'PLN', 'CD Projekt'],
      ],
    },
  },

  en: {
    transactions: {
      header: ['date', 'ticker', 'side', 'quantity', 'price', 'fee', 'currency', 'name', 'note'],
      rows: [
        ['2026-01-15', 'AAPL.US', 'BUY', '10', '185.50', '1.20', 'USD', 'Apple Inc', ''],
        ['2026-03-02', 'CDR.WA', 'SELL', '50', '142.00', '3.50', 'PLN', 'CD Projekt', 'took profit'],
      ],
    },
    cashflows: {
      header: ['date', 'type', 'amount', 'currency', 'ticker', 'note'],
      rows: [
        ['2026-01-02', 'Deposit', '10000', 'PLN', '', 'bank transfer'],
        ['2026-02-14', 'Dividend', '23.40', 'USD', 'AAPL.US', 'quarterly dividend'],
        ['2026-02-14', 'Tax', '3.51', 'USD', 'AAPL.US', 'withholding tax'],
      ],
    },
    holdings: {
      header: ['ticker', 'quantity', 'avg_buy_price', 'currency', 'name'],
      rows: [
        ['AAPL.US', '10', '185.50', 'USD', 'Apple Inc'],
        ['CDR.WA', '50', '128.40', 'PLN', 'CD Projekt'],
      ],
    },
  },
};

const escape = (cell) => (/[";\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);

export function csvTemplate(kind, locale = DEFAULT_LOCALE) {
  const lang = isSupported(locale) ? String(locale).toLowerCase() : DEFAULT_LOCALE;
  const template = TEMPLATES[lang]?.[kind] ?? TEMPLATES[DEFAULT_LOCALE][kind];
  const lines = [template.header, ...template.rows].map((row) => row.map(escape).join(';'));
  // BOM sprawia, ze Excel otwiera plik jako UTF-8 zamiast jako Windows-1250.
  return `﻿${lines.join('\r\n')}\r\n`;
}
