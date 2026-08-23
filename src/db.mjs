// src/db.mjs - SQLite (node:sqlite, zero zaleznosci npm) + wersjonowany schemat.
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import config from './config.mjs';
import { log } from './log.mjs';

let db = null;

/** Lista migracji. Indeks + 1 == docelowy PRAGMA user_version. Nigdy nie edytuj juz wydanej migracji.
 *  Eksportowana, bo scripts/migration-guard.mjs pilnuje jej niezmiennosci (docs/MIGRATIONS.md). */
export const MIGRATIONS = [
  // 1 - schemat bazowy v2 (uzytkownicy, portfele, ledgery)
  `
  CREATE TABLE users (
    id             TEXT PRIMARY KEY,
    email          TEXT NOT NULL UNIQUE,
    display_name   TEXT NOT NULL DEFAULT '',
    password_hash  TEXT NOT NULL,
    role           TEXT NOT NULL DEFAULT 'user',        -- owner | admin | user
    status         TEXT NOT NULL DEFAULT 'active',      -- active | disabled
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    last_login_at  TEXT,
    failed_logins  INTEGER NOT NULL DEFAULT 0,
    locked_until   TEXT
  );

  CREATE TABLE sessions (
    id            TEXT PRIMARY KEY,                     -- sha256(token), nigdy sam token
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_secret   TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    ip            TEXT,
    user_agent    TEXT
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);
  CREATE INDEX idx_sessions_exp  ON sessions(expires_at);

  CREATE TABLE invites (
    id          TEXT PRIMARY KEY,                       -- sha256(kod zaproszenia)
    email       TEXT,                                   -- opcjonalne przypiecie do adresu
    role        TEXT NOT NULL DEFAULT 'user',
    created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    used_at     TEXT,
    used_by     TEXT REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE portfolios (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    slug           TEXT NOT NULL,
    base_currency  TEXT NOT NULL DEFAULT 'PLN',
    broker         TEXT NOT NULL DEFAULT '',
    kind           TEXT NOT NULL DEFAULT 'brokerage',   -- brokerage | ike | ikze | pension | crypto | other
    color          TEXT NOT NULL DEFAULT '#4fc3f7',
    tax_rate       REAL NOT NULL DEFAULT 0.19,
    position       INTEGER NOT NULL DEFAULT 0,
    archived       INTEGER NOT NULL DEFAULT 0,
    webhook_token  TEXT,                                -- sha256(token webhooka portfela)
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    UNIQUE (user_id, slug)
  );
  CREATE INDEX idx_portfolios_user ON portfolios(user_id, archived, position);

  CREATE TABLE transactions (
    id           TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    trade_date   TEXT NOT NULL,                         -- YYYY-MM-DD
    ticker       TEXT NOT NULL,                         -- kanoniczny, np. GPW.WA
    name         TEXT NOT NULL DEFAULT '',
    side         TEXT NOT NULL,                         -- BUY | SELL
    qty          REAL NOT NULL,
    price        REAL NOT NULL,
    fee          REAL NOT NULL DEFAULT 0,
    currency     TEXT NOT NULL,
    note         TEXT NOT NULL DEFAULT '',
    source       TEXT NOT NULL DEFAULT 'manual',        -- manual | webhook:xtb | webhook:ibkr | import
    external_id  TEXT,                                  -- id zlecenia u brokera (deduplikacja)
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX idx_tx_portfolio      ON transactions(portfolio_id, trade_date);
  CREATE INDEX idx_tx_ticker         ON transactions(portfolio_id, ticker);
  CREATE UNIQUE INDEX idx_tx_external ON transactions(portfolio_id, external_id)
    WHERE external_id IS NOT NULL;

  CREATE TABLE cash_flows (
    id           TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    flow_date    TEXT NOT NULL,
    type         TEXT NOT NULL,                         -- Deposit | Withdrawal | Dividend | Interest | Fee | Tax
    amount       REAL NOT NULL,                         -- Withdrawal/Fee/Tax zapisywane jako ujemne
    currency     TEXT NOT NULL,
    comment      TEXT NOT NULL DEFAULT '',
    source       TEXT NOT NULL DEFAULT 'manual',
    external_id  TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX idx_flows_portfolio ON cash_flows(portfolio_id, flow_date);
  CREATE UNIQUE INDEX idx_flows_external ON cash_flows(portfolio_id, external_id)
    WHERE external_id IS NOT NULL;

  CREATE TABLE holdings_baseline (
    id             TEXT PRIMARY KEY,
    portfolio_id   TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    symbol         TEXT NOT NULL,
    name           TEXT NOT NULL DEFAULT '',
    qty            REAL NOT NULL DEFAULT 0,
    avg            REAL NOT NULL DEFAULT 0,
    currency       TEXT NOT NULL DEFAULT 'PLN',
    sector         TEXT NOT NULL DEFAULT '',
    market         TEXT NOT NULL DEFAULT '',
    source         TEXT NOT NULL DEFAULT 'stooq',
    fallback_price REAL,
    UNIQUE (portfolio_id, symbol)
  );

  CREATE TABLE position_notes (
    portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    symbol       TEXT NOT NULL,
    note         TEXT NOT NULL DEFAULT '',
    plan         TEXT NOT NULL DEFAULT '',
    stop_loss    REAL,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (portfolio_id, symbol)
  );

  CREATE TABLE portfolio_history (
    portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    day          TEXT NOT NULL,
    total_pln    REAL NOT NULL,
    invested_pln REAL NOT NULL DEFAULT 0,
    cash_pln     REAL NOT NULL DEFAULT 0,
    provisional  INTEGER NOT NULL DEFAULT 0,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (portfolio_id, day)
  );

  CREATE TABLE share_links (
    id            TEXT PRIMARY KEY,                     -- sha256(token)
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    portfolio_id  TEXT REFERENCES portfolios(id) ON DELETE CASCADE, -- NULL = widok skonsolidowany
    label         TEXT NOT NULL DEFAULT '',
    scope         TEXT NOT NULL DEFAULT 'summary',      -- summary | full
    created_at    TEXT NOT NULL,
    expires_at    TEXT,
    revoked_at    TEXT,
    last_access_at TEXT,
    access_count  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_share_user ON share_links(user_id);

  CREATE TABLE sectors (
    ticker_key TEXT PRIMARY KEY,
    sector     TEXT NOT NULL
  );

  CREATE TABLE audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    at           TEXT NOT NULL,
    user_id      TEXT,
    portfolio_id TEXT,
    action       TEXT NOT NULL,
    entity       TEXT,
    entity_id    TEXT,
    ip           TEXT,
    detail       TEXT
  );
  CREATE INDEX idx_audit_at ON audit_log(at);

  CREATE TABLE webhook_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    at           TEXT NOT NULL,
    portfolio_id TEXT,
    source       TEXT,
    status       TEXT,
    message_id   TEXT,
    payload      TEXT,
    result       TEXT
  );
  CREATE INDEX idx_webhook_at ON webhook_log(at);
  `,

  // 2 - wsady importu (expand: nowa tabela + kolumny NULL-owalne, nic nie usuwamy)
  `
  CREATE TABLE import_batches (
    id            TEXT PRIMARY KEY,
    portfolio_id  TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
    kind          TEXT NOT NULL,                        -- transactions | cashflows | holdings
    profile       TEXT NOT NULL DEFAULT 'canonical',    -- canonical | xtb | ibkr
    filename      TEXT NOT NULL DEFAULT '',
    row_count     INTEGER NOT NULL DEFAULT 0,           -- wierszy zapisanych
    skipped_count INTEGER NOT NULL DEFAULT 0,           -- duplikatow pominietych
    created_at    TEXT NOT NULL,
    undone_at     TEXT                                  -- znacznik cofniecia; wiersz zostaje dla historii
  );
  CREATE INDEX idx_import_portfolio ON import_batches(portfolio_id, created_at);

  ALTER TABLE transactions ADD COLUMN import_batch_id TEXT;
  ALTER TABLE cash_flows   ADD COLUMN import_batch_id TEXT;
  CREATE INDEX idx_tx_batch    ON transactions(import_batch_id) WHERE import_batch_id IS NOT NULL;
  CREATE INDEX idx_flows_batch ON cash_flows(import_batch_id)   WHERE import_batch_id IS NOT NULL;
  `,

  // 3 - pochodzenie wpisu historii (expand: kolumna NULL-owalna, nic nie usuwamy)
  //     'eod'         - zapisany na biezaco po zamknieciu sesji
  //     'rebuilt'     - odtworzony wstecz z transakcji i historycznych kursow
  //     NULL          - wpis sprzed tej migracji (traktowany jak 'eod')
  `
  ALTER TABLE portfolio_history ADD COLUMN source TEXT;
  `,
];

function nowIso() {
  return new Date().toISOString();
}

export function openDb(dbPath = config.dbPath) {
  const handle = new DatabaseSync(dbPath);
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA foreign_keys = ON');
  handle.exec('PRAGMA busy_timeout = 5000');
  handle.exec('PRAGMA synchronous = NORMAL');
  migrate(handle);
  return handle;
}

function migrate(handle) {
  const current = handle.prepare('PRAGMA user_version').get().user_version ?? 0;
  if (current >= MIGRATIONS.length) return;
  for (let i = current; i < MIGRATIONS.length; i += 1) {
    handle.exec('BEGIN');
    try {
      handle.exec(MIGRATIONS[i]);
      handle.exec(`PRAGMA user_version = ${i + 1}`);
      handle.exec('COMMIT');
      log.info('db.migrated', { to: i + 1 });
    } catch (err) {
      handle.exec('ROLLBACK');
      throw new Error(`Migracja ${i + 1} nie powiodla sie: ${err.message}`);
    }
  }
}

export function getDb() {
  if (!db) db = openDb();
  return db;
}

/** Uruchamia fn w transakcji. Zagniezdzenia sa splaszczane (savepointy nie sa potrzebne w tym API). */
export function tx(fn, handle = getDb()) {
  handle.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(handle);
    handle.exec('COMMIT');
    return out;
  } catch (err) {
    try { handle.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

export const newId = (prefix = '') => `${prefix}${crypto.randomUUID()}`;
export const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
export { nowIso };

export function audit(entry) {
  try {
    getDb().prepare(`
      INSERT INTO audit_log (at, user_id, portfolio_id, action, entity, entity_id, ip, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nowIso(),
      entry.userId ?? null,
      entry.portfolioId ?? null,
      entry.action,
      entry.entity ?? null,
      entry.entityId ?? null,
      entry.ip ?? null,
      entry.detail ? JSON.stringify(entry.detail) : null,
    );
  } catch (err) {
    log.warn('audit.failed', { error: err.message });
  }
}
