// src/market/providers.mjs - dostep do zrodel zewnetrznych z timeoutem i bezpiecznikiem.
import config from '../config.mjs';
import { log } from '../log.mjs';

const breakers = new Map(); // provider -> { failures, openUntil }
const BREAKER_THRESHOLD = 4;
const BREAKER_COOLDOWN_MS = 60_000;

export function breakerState(provider) {
  const state = breakers.get(provider);
  if (!state) return { open: false, failures: 0 };
  return { open: state.openUntil > Date.now(), failures: state.failures, openUntil: state.openUntil };
}

function recordSuccess(provider) {
  breakers.delete(provider);
}

function recordFailure(provider) {
  const state = breakers.get(provider) ?? { failures: 0, openUntil: 0 };
  state.failures += 1;
  if (state.failures >= BREAKER_THRESHOLD) {
    state.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    state.failures = 0;
    log.warn('provider.breaker_open', { provider, forMs: BREAKER_COOLDOWN_MS });
  }
  breakers.set(provider, state);
}

/**
 * Pobranie tekstu z zewnetrznego zrodla.
 * Zwraca null zamiast rzucac - warstwa wyzej ma zawsze fallback (cache/holdings).
 */
export async function fetchText(provider, url, { timeoutMs = config.quoteTimeoutMs, headers = {} } = {}) {
  if (config.offlineMarketData) return null;
  if (breakerState(provider).open) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'master-portfolio-dashboard/2.0 (+private)',
        accept: 'text/csv,application/json,text/html;q=0.9,*/*;q=0.8',
        ...headers,
      },
    });
    if (!res.ok) {
      recordFailure(provider);
      log.debug('provider.http_error', { provider, status: res.status });
      return null;
    }
    const text = await res.text();
    recordSuccess(provider);
    return text;
  } catch (err) {
    recordFailure(provider);
    log.debug('provider.fetch_failed', { provider, error: err.message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(provider, url, opts) {
  const text = await fetchText(provider, url, opts);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    recordFailure(provider);
    return null;
  }
}

export function providersStatus() {
  return ['stooq', 'yahoo', 'gpw', 'google'].map((provider) => ({ provider, ...breakerState(provider) }));
}
