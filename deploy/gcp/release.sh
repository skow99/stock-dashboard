#!/usr/bin/env bash
# deploy/gcp/release.sh - wydanie wersji NA MASZYNIE. Uruchamiany przez CI albo recznie, jako root.
#
#   sudo bash release.sh <archiwum.tar.gz> production
#   sudo bash release.sh <archiwum.tar.gz> staging
#
# Produkcja przechodzi przez bramki, ktore maja zatrzymac zle wydanie ZANIM dotknie danych:
#   1. kopia zapasowa bazy,
#   2. proba generalna migracji na kopii biezacej bazy, NOWYM kodem,
#   3. podmiana kodu z zachowaniem poprzedniej wersji,
#   4. health check po restarcie,
#   5. automatyczny powrot do poprzedniej wersji, gdy health check nie przejdzie.
#
# Staging dostaje sanityzowana kopie produkcji i nasluchuje wylacznie na 127.0.0.1.
set -euo pipefail

ARCHIVE="${1:?Uzycie: release.sh <archiwum.tar.gz> <production|staging>}"
TARGET="${2:?Uzycie: release.sh <archiwum.tar.gz> <production|staging>}"

APP_USER="sdapp"
PROD_DIR="/opt/stock-dashboard"
PROD_DATA="/var/lib/stock-dashboard"
PROD_ENV="/etc/stock-dashboard.env"

STAGING_DIR="/opt/stock-dashboard-staging"
STAGING_DATA="/var/lib/stock-dashboard-staging"
STAGING_ENV="/etc/stock-dashboard-staging.env"
STAGING_PORT=8788

info() { printf '\033[32m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$1"; }
fail() { printf '\033[31m[x]\033[0m %s\n' "$1" >&2; exit 1; }

[[ -f "$ARCHIVE" ]] || fail "Brak archiwum: $ARCHIVE"

# Prawa normalizujemy zawsze - archiwum niesie prawa z maszyny, na ktorej powstalo.
normalize_perms() {
  local dir="$1"
  chown -R root:root "$dir"
  chmod 755 "$dir"
  find "$dir" -type d -exec chmod 755 {} +
  find "$dir" -type f -exec chmod 644 {} +
}

health() {
  local port="$1" tries="${2:-20}"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS --max-time 4 "http://127.0.0.1:${port}/stock-dashboard/api/v1/health" \
       | grep -q '"ok":true'; then return 0; fi
    sleep 2
  done
  return 1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
tar -xzf "$ARCHIVE" -C "$TMP"
NEW_CODE="$TMP/stock-dashboard"
[[ -f "$NEW_CODE/server.mjs" ]] || fail "Archiwum nie zawiera server.mjs"

VERSION="$(grep -oE "version: '[^']+'" "$NEW_CODE/src/config.mjs" | head -1 | cut -d"'" -f2 || echo '?')"
info "Wydanie ${VERSION} -> ${TARGET}"

# ══════════════════════════════════════════════════════════════════ STAGING
if [[ "$TARGET" == "staging" ]]; then
  info "Przygotowuje srodowisko stagingowe"
  mkdir -p "$STAGING_DIR" "$STAGING_DATA/cache"
  rsync -a --delete --exclude='data' "$NEW_CODE/" "$STAGING_DIR/"
  normalize_perms "$STAGING_DIR"

  # Staging nie ma wlasnego HTTPS - siedzi na petli zwrotnej i jest dostepny
  # wylacznie przez tunel IAP. Stad SD_COOKIE_SECURE=0.
  cat > "$STAGING_ENV" <<EOF
NODE_ENV=production
SD_HOST=127.0.0.1
SD_PORT=${STAGING_PORT}
SD_BASE_PATH=/stock-dashboard
SD_DATA_DIR=${STAGING_DATA}
SD_DB_PATH=${STAGING_DATA}/dashboard.db
SD_COOKIE_SECURE=0
SD_TRUST_PROXY=0
SD_OPEN_REGISTRATION=0
SD_DEFAULT_LOCALE=pl
SD_EOD_TIMEZONE=Europe/Warsaw
SD_LOG_LEVEL=info
EOF
  chmod 640 "$STAGING_ENV"
  chown root:"$APP_USER" "$STAGING_ENV"

  cat > /etc/systemd/system/stock-dashboard-staging.service <<EOF
[Unit]
Description=Master Portfolio Dashboard - STAGING (tylko 127.0.0.1)
After=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${STAGING_DIR}
ExecStart=/usr/bin/node ${STAGING_DIR}/server.mjs
EnvironmentFile=${STAGING_ENV}
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${STAGING_DATA}
MemoryMax=200M
SyslogIdentifier=stock-dashboard-staging

[Install]
WantedBy=multi-user.target
EOF

  info "Odswiezam dane stagingowe z sanityzowanej kopii produkcji"
  systemctl stop stock-dashboard-staging 2>/dev/null || true
  rm -f "$STAGING_DATA"/dashboard.db*
  if [[ -f "$PROD_DATA/dashboard.db" ]]; then
    sudo -u "$APP_USER" node "$STAGING_DIR/scripts/sanitize-db.mjs" \
      "$PROD_DATA/dashboard.db" "$STAGING_DATA/dashboard.db" \
      || fail "Sanityzacja bazy nie powiodla sie - staging NIE dostanie danych produkcyjnych"
  else
    warn "Brak bazy produkcyjnej - staging wystartuje na pustej bazie"
  fi
  chown -R "$APP_USER:$APP_USER" "$STAGING_DATA"
  chmod 700 "$STAGING_DATA"

  systemctl daemon-reload
  systemctl restart stock-dashboard-staging
  if health "$STAGING_PORT" 20; then
    info "Staging dziala na 127.0.0.1:${STAGING_PORT}"
    echo
    echo "  Podglad z Twojego komputera:"
    echo "    gcloud compute ssh stock-dashboard --zone us-central1-a --tunnel-through-iap -- -L ${STAGING_PORT}:127.0.0.1:${STAGING_PORT}"
    echo "    potem otworz http://127.0.0.1:${STAGING_PORT}/stock-dashboard/"
  else
    journalctl -u stock-dashboard-staging -n 40 --no-pager
    fail "Staging nie odpowiada"
  fi
  exit 0
fi

# ══════════════════════════════════════════════════════════════════ PRODUKCJA
[[ "$TARGET" == "production" ]] || fail "Nieznany cel: $TARGET (production albo staging)"

# ---- Bramka 1: kopia zapasowa
info "Bramka 1/4: kopia zapasowa bazy"
if [[ -f "$PROD_DATA/dashboard.db" ]]; then
  systemctl start stock-dashboard-backup.service || fail "Kopia zapasowa nie powiodla sie - przerywam"
  LATEST_BACKUP="$(ls -1t "$PROD_DATA"/backups/*.db 2>/dev/null | head -1)"
  [[ -n "$LATEST_BACKUP" ]] || fail "Nie powstala kopia zapasowa - przerywam"
  info "  kopia: $LATEST_BACKUP ($(du -h "$LATEST_BACKUP" | cut -f1))"
else
  warn "  brak bazy produkcyjnej - pierwsze wdrozenie"
fi

# ---- Bramka 2: proba generalna migracji NOWYM kodem na KOPII biezacej bazy
info "Bramka 2/4: proba generalna migracji na danych produkcyjnych"
if [[ -f "$PROD_DATA/dashboard.db" ]]; then
  REH_DIR="$(mktemp -d)"
  cp "$PROD_DATA/dashboard.db" "$REH_DIR/copy.db"
  for s in -wal -shm; do
    [[ -f "$PROD_DATA/dashboard.db$s" ]] && cp "$PROD_DATA/dashboard.db$s" "$REH_DIR/copy.db$s"
  done
  chmod -R 777 "$REH_DIR"
  if ! sudo -u "$APP_USER" env SD_OFFLINE=1 SD_DATA_DIR="$REH_DIR" SD_DB_PATH="$REH_DIR/copy.db" \
       node "$NEW_CODE/scripts/migrate-rehearse.mjs" "$REH_DIR/copy.db"; then
    rm -rf "$REH_DIR"
    fail "Proba generalna migracji NIE POWIODLA SIE. Produkcja nietknieta."
  fi
  rm -rf "$REH_DIR"
else
  info "  pomijam - brak bazy"
fi

# ---- Bramka 3: podmiana kodu
info "Bramka 3/4: podmiana kodu"
rm -rf "$PROD_DIR.old"
if [[ -d "$PROD_DIR/src" ]]; then
  cp -r "$PROD_DIR" "$PROD_DIR.old"
  info "  poprzednia wersja zachowana w $PROD_DIR.old"
fi
rsync -a --delete --exclude='data' "$NEW_CODE/" "$PROD_DIR/"
normalize_perms "$PROD_DIR"
sudo -u "$APP_USER" test -x "$PROD_DIR" && sudo -u "$APP_USER" test -r "$PROD_DIR/server.mjs" \
  || fail "Uzytkownik $APP_USER nie ma dostepu do $PROD_DIR"

# ---- Bramka 4: restart + health check + automatyczny rollback
info "Bramka 4/4: restart i weryfikacja"
systemctl restart stock-dashboard

if health 8787 20; then
  info "Health check OK"
  echo
  curl -s http://127.0.0.1:8787/stock-dashboard/api/v1/health
  echo
  info "Wydanie ${VERSION} na produkcji"
else
  warn "Health check NIE PRZESZEDL - cofam do poprzedniej wersji"
  journalctl -u stock-dashboard -n 40 --no-pager || true

  if [[ -d "$PROD_DIR.old/src" ]]; then
    rsync -a --delete --exclude='data' "$PROD_DIR.old/" "$PROD_DIR/"
    normalize_perms "$PROD_DIR"
    systemctl restart stock-dashboard
    if health 8787 15; then
      warn "Cofnieto do poprzedniej wersji. Serwis dziala."
      fail "Wydanie odrzucone przez health check (rollback wykonany)"
    fi
    fail "ROLLBACK TEZ NIE WSTAL. Wymagana reczna interwencja - patrz docs/RUNBOOK.md"
  fi
  fail "Brak poprzedniej wersji do cofniecia. Wymagana reczna interwencja."
fi
