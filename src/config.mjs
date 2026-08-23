// src/config.mjs - jedyne miejsce, w ktorym czytamy zmienne srodowiskowe.
import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function envStr(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

// Opcjonalny .env obok projektu. Nie nadpisuje zmiennych juz ustawionych w srodowisku.
const dotenvPath = path.join(ROOT_DIR, '.env');
if (fs.existsSync(dotenvPath)) {
  for (const line of fs.readFileSync(dotenvPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value;
  }
}

const DATA_DIR = path.resolve(envStr('SD_DATA_DIR', path.join(ROOT_DIR, 'data')));

export const config = {
  rootDir: ROOT_DIR,
  publicDir: path.join(ROOT_DIR, 'public'),
  dataDir: DATA_DIR,
  cacheDir: path.join(DATA_DIR, 'cache'),
  dbPath: envStr('SD_DB_PATH', path.join(DATA_DIR, 'dashboard.db')),

  env: envStr('NODE_ENV', 'development'),
  host: envStr('SD_HOST', '127.0.0.1'),
  port: envInt('SD_PORT', 8787),
  basePath: envStr('SD_BASE_PATH', '/stock-dashboard').replace(/\/+$/, ''),

  // Bezpieczenstwo
  cookieName: envStr('SD_COOKIE_NAME', 'sd_session'),
  cookieSecure: envBool('SD_COOKIE_SECURE', envStr('NODE_ENV', 'development') === 'production'),
  sessionTtlMs: envInt('SD_SESSION_TTL_HOURS', 24 * 14) * 3600 * 1000,
  sessionIdleMs: envInt('SD_SESSION_IDLE_HOURS', 24 * 3) * 3600 * 1000,
  trustProxy: envBool('SD_TRUST_PROXY', true),
  openRegistration: envBool('SD_OPEN_REGISTRATION', false), // domyslnie: tylko na zaproszenie
  maxBodyBytes: envInt('SD_MAX_BODY_BYTES', 256 * 1024),
  loginMaxAttempts: envInt('SD_LOGIN_MAX_ATTEMPTS', 8),
  loginLockoutMs: envInt('SD_LOGIN_LOCKOUT_MINUTES', 15) * 60 * 1000,
  minPasswordLength: envInt('SD_MIN_PASSWORD_LENGTH', 10),

  // Bootstrap pierwszego konta (tylko gdy baza nie ma uzytkownikow)
  bootstrapEmail: envStr('SD_BOOTSTRAP_EMAIL', ''),
  bootstrapPassword: envStr('SD_BOOTSTRAP_PASSWORD', ''),

  // Webhook brokerski (globalny fallback; docelowo token per portfel)
  webhookToken: envStr('STOCK_DASHBOARD_WEBHOOK_TOKEN', ''),

  // Dane rynkowe
  quoteTimeoutMs: envInt('SD_QUOTE_TIMEOUT_MS', 8000),
  priceHistoryFreshMs: envInt('SD_PRICE_HISTORY_FRESH_HOURS', 6) * 3600 * 1000,
  portfolioCacheMs: envInt('SD_PORTFOLIO_CACHE_SECONDS', 60) * 1000,
  offlineMarketData: envBool('SD_OFFLINE', false), // tryb testowy: zero ruchu sieciowego

  eodTimezone: envStr('SD_EOD_TIMEZONE', 'Europe/Warsaw'),
  eodCutoffHour: envInt('SD_EOD_CUTOFF_HOUR', 22),

  logLevel: envStr('SD_LOG_LEVEL', 'info'),
  defaultLocale: envStr('SD_DEFAULT_LOCALE', 'pl'),
  version: '2.0.0',
};

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.cacheDir, { recursive: true });

export default config;
