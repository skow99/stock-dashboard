// src/calc/performance.mjs - TWR i wyniki okresowe. Czyste funkcje.
//
// Zasada: depozyty i wyplaty to przeplywy ZEWNETRZNE i musza byc usuniete z licznika stopy zwrotu.
// Dywidendy i odsetki NIE sa przeplywem zewnetrznym - zostaja czescia wyniku.

const EPS = 1e-9;

export const EXTERNAL_FLOW_TYPES = new Set(['Deposit', 'Withdrawal']);

/** Mapa dzien -> suma przeplywow zewnetrznych w PLN. */
export function externalFlowsByDay(cashFlows, fxToPlnFn) {
  const map = new Map();
  for (const flow of cashFlows) {
    if (!EXTERNAL_FLOW_TYPES.has(flow.type)) continue;
    const pln = (Number(flow.amount) || 0) * fxToPlnFn(flow.currency);
    map.set(flow.flow_date, (map.get(flow.flow_date) ?? 0) + pln);
  }
  return map;
}

/**
 * Indeks TWR (baza 100) z serii wartosci EOD i przeplywow zewnetrznych.
 * r_t = (V_t - F_t) / V_{t-1} - 1
 */
export function buildTwrIndex(history, flowsByDay, { base = 100 } = {}) {
  const series = [];
  let factor = 1;
  let previous = null;

  for (const point of history) {
    const total = Number(point.totalPln);
    if (!Number.isFinite(total)) continue;
    if (previous === null) {
      series.push({ day: point.day, index: base, totalPln: total });
      previous = total;
      continue;
    }
    const flow = flowsByDay.get(point.day) ?? 0;
    if (previous > EPS) {
      const r = ((total - flow) / previous) - 1;
      // Odciecie absurdow (np. blad danych rynkowych) - inaczej jeden punkt psuje caly indeks.
      if (Number.isFinite(r) && r > -0.95 && r < 3) factor *= (1 + r);
    }
    series.push({ day: point.day, index: base * factor, totalPln: total });
    previous = total;
  }
  return series;
}

/** Przeskalowanie indeksu do 100 na poczatku wybranego zakresu (porownywalnosc z benchmarkiem). */
export function rebase(series, base = 100) {
  if (!series.length) return [];
  const first = series[0].index;
  if (!Number.isFinite(first) || Math.abs(first) < EPS) return series;
  return series.map((p) => ({ ...p, index: (p.index / first) * base }));
}

function findBaseline(history, fromDay) {
  // Ostatni punkt STRICTLY przed fromDay - to jest wartosc odniesienia okresu.
  let candidate = null;
  for (const point of history) {
    if (point.day < fromDay) candidate = point;
    else break;
  }
  return candidate;
}

/** Wynik okresu z korekta o przeplywy zewnetrzne wewnatrz okresu. */
export function periodPerformance(history, flowsByDay, fromDay, currentTotal) {
  if (!history.length) return null;
  const baseline = findBaseline(history, fromDay) ?? history[0];
  const start = Number(baseline.totalPln);
  if (!Number.isFinite(start) || start <= EPS) return null;

  let flows = 0;
  for (const [day, amount] of flowsByDay) {
    if (day >= fromDay) flows += amount;
  }
  const pln = currentTotal - start - flows;
  return {
    pln,
    pct: start > EPS ? (pln / start) * 100 : null,
    baseDay: baseline.day,
    externalFlowsPln: flows,
  };
}

/**
 * Komplet metryk: Dzien / MTD / YTD / od poczatku.
 * `history` musi byc posortowana rosnaco i zawierac wylacznie punkty EOD.
 */
export function buildPerformance({ history, flowsByDay, currentTotal, today }) {
  const finalHistory = history.filter((p) => !p.provisional);
  const lastFinal = finalHistory.length ? finalHistory[finalHistory.length - 1] : null;

  const dayFrom = lastFinal && lastFinal.day < today ? today : (lastFinal?.day ?? today);
  const monthFrom = `${today.slice(0, 7)}-01`;
  const yearFrom = `${today.slice(0, 4)}-01-01`;

  const totalExternal = [...flowsByDay.values()].reduce((a, b) => a + b, 0);
  const firstPoint = finalHistory[0] ?? null;

  return {
    day: periodPerformance(finalHistory, flowsByDay, dayFrom, currentTotal),
    mtd: periodPerformance(finalHistory, flowsByDay, monthFrom, currentTotal),
    ytd: periodPerformance(finalHistory, flowsByDay, yearFrom, currentTotal),
    sinceStart: firstPoint
      ? {
        pln: currentTotal - Number(firstPoint.totalPln) - totalExternal,
        pct: Number(firstPoint.totalPln) > EPS
          ? ((currentTotal - Number(firstPoint.totalPln) - totalExternal) / Number(firstPoint.totalPln)) * 100
          : null,
        baseDay: firstPoint.day,
        externalFlowsPln: totalExternal,
      }
      : null,
  };
}

/** Zwrot z kapitalu wlasnego: wynik / suma netto wplat. Odporny na zerowy mianownik. */
export function returnOnCapital(currentTotal, netExternalPln) {
  if (!Number.isFinite(netExternalPln) || Math.abs(netExternalPln) < EPS) return null;
  return ((currentTotal - netExternalPln) / netExternalPln) * 100;
}
