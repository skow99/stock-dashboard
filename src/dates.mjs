// src/dates.mjs - czas gieldowy. Cala logika EOD liczy sie w strefie Europe/Warsaw.
import config from './config.mjs';

const partsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: config.eodTimezone,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

export function zonedParts(date = new Date()) {
  const parts = Object.fromEntries(partsFormatter.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour === '24' ? '00' : parts.hour),
    minute: Number(parts.minute),
  };
}

export const todayWarsaw = (date = new Date()) => zonedParts(date).day;

export function isValidDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function assertDay(value, field = 'date') {
  if (!isValidDay(value)) {
    const err = new Error(`Pole ${field} musi miec format YYYY-MM-DD`);
    err.code = 'invalid_date';
    throw err;
  }
  return value;
}

export function isWeekend(day) {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

export function addDays(day, delta) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Ostatni dzien roboczy <= day (bez kalendarza swiat - swieta traktujemy jako dni bez notowan w danych). */
export function lastBusinessDay(day = todayWarsaw()) {
  let cursor = day;
  for (let i = 0; i < 7; i += 1) {
    if (!isWeekend(cursor)) return cursor;
    cursor = addDays(cursor, -1);
  }
  return cursor;
}

/** Czy minal cutoff EOD (domyslnie 22:00 Europe/Warsaw) dla biezacego dnia. */
export function isAfterEodCutoff(date = new Date()) {
  return zonedParts(date).hour >= config.eodCutoffHour;
}

/** Czy wolno zapisac finalny snapshot dnia. */
export function canWriteFinalSnapshot(date = new Date()) {
  const { day } = zonedParts(date);
  if (isWeekend(day)) return false;
  return isAfterEodCutoff(date);
}

/**
 * Dzien, dla ktorego notowanie ma prawo byc uznane za "swieze".
 * Dzisiejsze notowanie EOD nie istnieje, dopoki gielda dzisiaj nie zamknie sesji -
 * przed cutoffem (domyslnie 22:00 Europe/Warsaw) oczekujemy wiec jeszcze wczorajszego
 * zamkniecia, nie dzisiejszego. Bez tego kazde sprawdzenie od polnocy do wieczora
 * widzialo 0% swiezych notowan (prawidlowe wczorajsze ceny) i blokowalo historie /
 * pokazywalo baner "zrodlo nie odpowiada", mimo ze zrodla dzialaly poprawnie.
 */
export function expectedQuoteDay(date = new Date()) {
  const { day } = zonedParts(date);
  const base = isAfterEodCutoff(date) ? day : addDays(day, -1);
  return lastBusinessDay(base);
}

export const startOfMonth = (day) => `${day.slice(0, 7)}-01`;
export const startOfYear = (day) => `${day.slice(0, 4)}-01-01`;
