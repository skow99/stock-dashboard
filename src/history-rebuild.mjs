// src/history-rebuild.mjs - odtworzenie historii portfela wstecz, z transakcji.
//
// Po zaimportowaniu transakcji sprzed lat wykres wartosci zaczynal sie dopiero w dniu,
// w ktorym system zaczal zapisywac migawki EOD. Ten modul liczy brakujace dni wstecz:
// pozycje odtwarza z ledgeru, a wycene bierze z dziennych notowan i kursow walut
// obowiazujacych W TAMTYM DNIU - nie dzisiejszych.
//
// Dwie zasady, ktore trzymaja to w ryzach:
//
//  1. Pozycje i gotowke liczy TEN SAM silnik, co widok biezacy (replayLedger).
//     Gdyby byly dwie implementacje, wykres mialby uskok w dniu dzisiejszym -
//     dokladnie tam, gdzie uzytkownik patrzy najczesciej.
//  2. Kursy walut i ceny sa pobierane raz na ticker i trzymane w cache WSPOLNYM
//     dla calej instancji. Odtworzenie dziesieciu lat dla pieciu spolek to piec
//     zapytan do zrodla, nie kilkanascie tysiecy.

import { getDb, nowIso } from './db.mjs';
import { listTransactions, listCashFlows, listBaseline } from './ledger.mjs';
import { replayLedger } from './calc/engine.mjs';
import { getDailyCloses } from './market/history.mjs';
import { getFxHistory, ratesForDay, fxToPln, PAIRS } from './market/fx.mjs';
import { normalizeTickerKey, inferCurrency } from './market/tickers.mjs';
import { addDays, todayWarsaw, isWeekend } from './dates.mjs';
import { log } from './log.mjs';

/** Zabezpieczenie przed transakcja z bledna data (rok 1900) - i przed praca bez konca. */
const MAX_DNI = 20 * 365;
const EPS = 1e-9;

/** Stan przeliczania per portfel, do pokazania w panelu. */
const wStanie = new Map(); // portfolioId -> { startedAt, days, done, error }

export function rebuildStatus(portfolioId) {
  return wStanie.get(portfolioId) ?? null;
}

const dzien = (value) => String(value ?? '').slice(0, 10);

/**
 * Odtwarza historie jednego portfela.
 *
 * @param {string} portfolioId - juz zweryfikowany przez requirePortfolio
 * @param {{ from?: string|null }} opcje
 * @returns {Promise<{ days: number, from: string|null, to: string, tickers: number, skipped: number }>}
 */
export async function rebuildPortfolioHistory(portfolioId, { from = null } = {}) {
  const transactions = listTransactions([portfolioId]);
  const cashFlows = listCashFlows([portfolioId]);
  const baseline = listBaseline([portfolioId]);

  if (!transactions.length && !cashFlows.length) {
    return { days: 0, from: null, to: todayWarsaw(), tickers: 0, skipped: 0, sources: [], missing: [] };
  }

  // ------------------------------------------------------------ zakres dni
  const daty = [
    ...transactions.map((t) => dzien(t.trade_date)),
    ...cashFlows.map((f) => dzien(f.flow_date)),
  ].filter(Boolean).sort();

  const ostatni = todayWarsaw();
  let pierwszy = from ? dzien(from) : daty[0];

  // Limit chroni przed data wpisana omylkowo (rok 1900) i przed praca bez konca.
  // Obcinamy POCZATEK, nie koniec: gdyby przebieg konczyl sie po MAX_DNI od zlej daty,
  // z wykresu zniknelyby ostatnie lata - czyli dokladnie to, na czym zalezy najbardziej.
  const najwczesniejszy = addDays(ostatni, -MAX_DNI);
  if (pierwszy < najwczesniejszy) {
    log.warn('history.range_capped', { portfolioId, zadany: pierwszy, uzyty: najwczesniejszy });
    pierwszy = najwczesniejszy;
  }

  if (!pierwszy || pierwszy > ostatni) {
    return { days: 0, from: null, to: ostatni, tickers: 0, skipped: 0, sources: [], missing: [] };
  }

  // ------------------------------------------------------------ dane rynkowe
  const tickery = new Map(); // klucz -> { symbol, currency }
  for (const item of baseline) {
    tickery.set(normalizeTickerKey(item.symbol), {
      symbol: item.symbol,
      currency: item.currency || inferCurrency(item.symbol),
    });
  }
  for (const tx of transactions) {
    const klucz = normalizeTickerKey(tx.ticker);
    if (!tickery.has(klucz)) {
      tickery.set(klucz, { symbol: tx.ticker, currency: tx.currency || inferCurrency(tx.ticker) });
    }
  }

  const stan = { startedAt: Date.now(), days: 0, done: false, error: null };
  wStanie.set(portfolioId, stan);

  try {
    // Jedno pobranie na ticker, potem wszystko z cache wspolnego dla instancji.
    const serie = new Map();
    await Promise.all([...tickery.entries()].map(async ([klucz, info]) => {
      serie.set(klucz, await getDailyCloses(info.symbol));
    }));
    const fxHistory = await getFxHistory();

    // Raport per ticker. Bez niego "historia sie nie zaciagnela" jest nie do
    // zdiagnozowania: nie widac, czy zawiodl jeden nieznany symbol, czy cale zrodlo.
    const zrodla = [...tickery.entries()].map(([klucz, info]) => {
      const s = serie.get(klucz);
      const punkty = s?.byDay ? Object.keys(s.byDay).length : 0;
      return {
        ticker: info.symbol,
        currency: info.currency,
        points: punkty,
        first: s?.first ?? null,
        last: s?.last ?? null,
        provider: s?.provider ?? 'none',
        ok: punkty > 0,
      };
    });
    const bezDanych = zrodla.filter((z) => !z.ok);
    if (bezDanych.length) {
      log.warn('history.tickers_without_quotes', {
        portfolioId, tickers: bezDanych.map((z) => z.ticker),
      });
    }

    // ------------------------------------------------------------ przejscie po dniach
    const txPosortowane = [...transactions].sort((a, b) => dzien(a.trade_date).localeCompare(dzien(b.trade_date)));
    const cfPosortowane = [...cashFlows].sort((a, b) => dzien(a.flow_date).localeCompare(dzien(b.flow_date)));

    let txIdx = 0;
    let cfIdx = 0;
    const flowsByCurrency = {};
    let ledger = null;            // przeliczany tylko w dniach z transakcjami
    let trzebaPrzeliczyc = true;

    const ostatniKurs = {};                                  // przenoszenie kursu walut przez weekend

    // Kursory ceny zaczynamy od OSTATNIEGO notowania sprzed pierwszego dnia portfela.
    // Bez tego pierwsze dni nie mialyby wyceny, mimo ze cena z poprzedniego tygodnia
    // jest znana - a wykres zaczynalby sie od sztucznej luki.
    const kursory = new Map();
    for (const klucz of tickery.keys()) {
      const seria = serie.get(klucz);
      let start = { day: null, value: null };
      if (seria?.byDay) {
        const wczesniejsze = Object.keys(seria.byDay).filter((x) => x <= pierwszy).sort();
        const ostatniDzien = wczesniejsze[wczesniejsze.length - 1];
        if (ostatniDzien) start = { day: ostatniDzien, value: seria.byDay[ostatniDzien] };
      }
      kursory.set(klucz, start);
    }
    const punkty = [];
    let pominietych = 0;

    for (let d = pierwszy, licznik = 0; d <= ostatni && licznik <= MAX_DNI; d = addDays(d, 1), licznik += 1) {
      // Transakcje tego dnia: przesuwamy wskaznik i zaznaczamy, ze stan sie zmienil.
      while (txIdx < txPosortowane.length && dzien(txPosortowane[txIdx].trade_date) <= d) {
        txIdx += 1;
        trzebaPrzeliczyc = true;
      }
      while (cfIdx < cfPosortowane.length && dzien(cfPosortowane[cfIdx].flow_date) <= d) {
        const flow = cfPosortowane[cfIdx];
        const waluta = String(flow.currency ?? 'PLN').toUpperCase();
        flowsByCurrency[waluta] = (flowsByCurrency[waluta] ?? 0) + (Number(flow.amount) || 0);
        cfIdx += 1;
      }

      const rates = ratesForDay(fxHistory, d, ostatniKurs);

      // Stan pozycji zmienia sie WYLACZNIE w dniach z transakcjami. Miedzy nimi
      // zmieniaja sie tylko ceny, wiec nie ma po co odtwarzac ledgeru od nowa.
      if (trzebaPrzeliczyc) {
        ledger = replayLedger({ transactions: txPosortowane.slice(0, txIdx), baseline, fxRates: rates });
        trzebaPrzeliczyc = false;
      }

      // Wycena pozycji cenami z tego dnia.
      let investedPln = 0;
      let brakCeny = false;
      for (const [klucz, pozycja] of ledger.positionState) {
        if (pozycja.qty <= EPS) continue;
        const seria = serie.get(klucz);
        const kursor = kursory.get(klucz) ?? { day: null, value: null };
        const cena = seria?.byDay?.[d] ?? kursor.value;
        if (Number.isFinite(seria?.byDay?.[d])) { kursor.day = d; kursor.value = seria.byDay[d]; }
        kursory.set(klucz, kursor);

        if (!Number.isFinite(cena)) { brakCeny = true; continue; }
        investedPln += pozycja.qty * cena * fxToPln(rates, pozycja.currency);
      }

      // Gotowka: kwoty w walutach oryginalnych przeliczone kursem z tego dnia.
      let cashPln = 0;
      for (const [waluta, kwota] of Object.entries(ledger.tradeCashByCurrency ?? {})) {
        cashPln += kwota * fxToPln(rates, waluta);
      }
      for (const [waluta, kwota] of Object.entries(flowsByCurrency)) {
        cashPln += kwota * fxToPln(rates, waluta);
      }

      // Dzien bez zadnej ceny dla posiadanych pozycji to nie jest dzien wart zapisania -
      // wykres pokazalby zjazd do zera zamiast luki.
      if (brakCeny && investedPln === 0 && ledger.positionState.size > 0) {
        pominietych += 1;
        continue;
      }

      punkty.push({
        day: d,
        totalPln: investedPln + cashPln,
        investedPln,
        cashPln,
        // Weekend i swieta nie maja wlasnego zamkniecia - cena jest przeniesiona.
        provisional: isWeekend(d) ? 1 : 0,
      });
      stan.days = punkty.length;
    }

    // ------------------------------------------------------------ zapis
    zapiszPunkty(portfolioId, punkty);

    stan.done = true;
    log.info('history.rebuilt', {
      portfolioId, days: punkty.length, from: pierwszy, to: ostatni,
      tickers: tickery.size, skipped: pominietych,
      bezDanych: bezDanych.map((z) => z.ticker),
    });
    return {
      days: punkty.length,
      from: pierwszy,
      to: ostatni,
      tickers: tickery.size,
      skipped: pominietych,
      sources: zrodla,
      missing: bezDanych.map((z) => z.ticker),
    };
  } catch (err) {
    stan.error = err.message;
    stan.done = true;
    log.error('history.rebuild_failed', { portfolioId, error: err.message });
    throw err;
  } finally {
    setTimeout(() => wStanie.delete(portfolioId), 60_000).unref?.();
  }
}

/**
 * Zapis w jednej transakcji: najpierw czyscimy historie portfela, potem wpisujemy
 * policzona na nowo.
 *
 * Czyszczenie jest konieczne, a nie ostrozne. Sam upsert zostawialby wiersze,
 * ktorych nowy przebieg juz nie dotyka - a to zdarza sie w najzwyklejszej sytuacji:
 * wystarczy poprawic date transakcji wpisana omylkowo (2003 zamiast 2026), zeby
 * dwadziescia lat pustego wykresu zostalo w bazie na zawsze i sciskalo prawdziwe dane
 * do plaskiej linii przy zerze.
 *
 * Usuwanie i wstawianie dzieje sie w JEDNEJ transakcji, wiec nieudany przebieg
 * nie zostawia portfela bez historii.
 */
function zapiszPunkty(portfolioId, punkty) {
  if (!punkty.length) return;
  const db = getDb();
  const at = nowIso();
  const stmt = db.prepare(`
    INSERT INTO portfolio_history (portfolio_id, day, total_pln, invested_pln, cash_pln, provisional, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'rebuilt', ?)
    ON CONFLICT(portfolio_id, day) DO UPDATE SET
      total_pln = excluded.total_pln, invested_pln = excluded.invested_pln,
      cash_pln = excluded.cash_pln, provisional = excluded.provisional,
      source = 'rebuilt', updated_at = excluded.updated_at
  `);

  db.exec('BEGIN IMMEDIATE');
  try {
    const usuniete = db.prepare('DELETE FROM portfolio_history WHERE portfolio_id = ?').run(portfolioId).changes;
    for (const p of punkty) {
      stmt.run(portfolioId, p.day, p.totalPln, p.investedPln, p.cashPln, p.provisional, at);
    }
    db.exec('COMMIT');
    if (Number(usuniete) > punkty.length) {
      log.info('history.stale_days_removed', {
        portfolioId, usuniete: Number(usuniete), zapisane: punkty.length,
      });
    }
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

/** Odtworzenie dla wszystkich portfeli uzytkownika, po kolei (e2-micro ma jeden rdzen). */
export async function rebuildForPortfolios(portfolioIds) {
  const wyniki = [];
  for (const id of portfolioIds) {
    // eslint-disable-next-line no-await-in-loop
    wyniki.push({ portfolioId: id, ...(await rebuildPortfolioHistory(id)) });
  }
  return wyniki;
}

export { PAIRS };
