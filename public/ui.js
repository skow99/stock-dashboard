// public/ui.js - klient API, formatery i pomocniki DOM. Wspolne dla wszystkich stron.
import { getLocale, intlLocale, errorText, t } from './i18n.js';

export const API = './api/v1';

let csrfToken = null;
export const setCsrf = (token) => { csrfToken = token; };
export const getCsrf = () => csrfToken;

export class ApiError extends Error {
  /** `code` jest stabilny; tresc jest tlumaczona lokalnie, z tekstem serwera jako zapasem. */
  constructor(status, code, serverMessage, details) {
    super(errorText(code, serverMessage, details));
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Wywolanie API. Dodaje token CSRF do zapisow i przekierowuje na logowanie przy 401.
 * @param {string} path np. '/dashboard?portfolio=all'
 */
export async function api(path, { method = 'GET', body, raw = false, redirectOn401 = true } = {}) {
  // Accept-Language sprawia, ze nawet bledy spoza katalogu klienta wracaja we wlasciwym jezyku.
  const headers = { accept: 'application/json', 'accept-language': getLocale() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && redirectOn401) {
    window.location.href = './login.html';
    throw new ApiError(401, 'unauthorized', t('auth.sessionExpired'));
  }
  if (raw) {
    if (!res.ok) throw new ApiError(res.status, 'http_error', `HTTP ${res.status}`);
    return res.text();
  }
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.ok === false) {
    const err = payload.error ?? {};
    throw new ApiError(res.status, err.code ?? 'http_error', err.message ?? `HTTP ${res.status}`, err.details);
  }
  return payload;
}

// ---------------------------------------------------------------- formatery

// Formatery zaleza od jezyka, wiec sa cache'owane per locale i odbudowywane po przelaczeniu.
const formatters = new Map();
function nf(min, max) {
  const key = `${intlLocale()}|${min}|${max}`;
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.NumberFormat(intlLocale(), {
      minimumFractionDigits: min, maximumFractionDigits: max,
    }));
  }
  return formatters.get(key);
}

const CURRENCY_SUFFIX = { pl: ' zl', en: ' PLN' };

export const isNum = (value) => Number.isFinite(Number(value));

export function fmtPln(value, { decimals = 0 } = {}) {
  if (!isNum(value)) return '-';
  const suffix = CURRENCY_SUFFIX[getLocale()] ?? CURRENCY_SUFFIX.pl;
  return `${nf(decimals ? 2 : 0, decimals ? 2 : 0).format(Number(value))}${suffix}`;
}

/** Kompaktowy zapis w tysiacach - tabele pozycji operuja na kPLN. */
export function fmtK(value) {
  if (!isNum(value)) return '-';
  const n = Number(value) / 1000;
  return `${nf(Math.abs(n) < 100 ? 1 : 0, Math.abs(n) < 100 ? 1 : 0).format(n)}k`;
}

export function fmtNum(value, decimals = 2) {
  if (!isNum(value)) return '-';
  return nf(decimals === 4 ? 0 : decimals, decimals).format(Number(value));
}

export function fmtPct(value, { sign = true, decimals = 2 } = {}) {
  if (!isNum(value)) return '-';
  const n = Number(value);
  return `${sign && n > 0 ? '+' : ''}${nf(decimals, decimals).format(n)}%`;
}

export function fmtSigned(value, formatter = fmtPln) {
  if (!isNum(value)) return '-';
  return `${Number(value) > 0 ? '+' : ''}${formatter(value)}`;
}

export const signClass = (value) => (!isNum(value) ? '' : (Number(value) > 0 ? 'pos' : (Number(value) < 0 ? 'neg' : '')));

export function fmtDateTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString(intlLocale(), { dateStyle: 'short', timeStyle: 'short' });
}

export const todayIso = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- DOM

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Tworzy element. Ustawia tekst przez textContent - zadne dane nie trafiaja do innerHTML. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value; // uzywane tylko dla wlasnego SVG
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Komorka tabeli z klasa znaku wartosci. */
export function td(text, { cls = '', title = '', onClick = null } = {}) {
  const cell = el('td', { class: cls, title: title || null }, [text]);
  if (onClick) { cell.classList.add('clickable'); cell.addEventListener('click', onClick); }
  return cell;
}

export function toast(message, kind = 'info', ms = 4000) {
  let host = $('#toasts');
  if (!host) { host = el('div', { id: 'toasts' }); document.body.append(host); }
  const node = el('div', { class: `toast ${kind}`, text: message });
  host.append(node);
  setTimeout(() => node.remove(), ms);
}

export function debounce(fn, ms = 400) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Skraca dluga nazwe, pelna zostaje w atrybucie title. */
export function truncated(text, max = 15) {
  const value = String(text ?? '');
  const span = el('span', { class: 'trunc', title: value, text: value });
  return { span, truncated: value.length > max };
}
