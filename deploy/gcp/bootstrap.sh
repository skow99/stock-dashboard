#!/usr/bin/env bash
# deploy/gcp/bootstrap.sh - instalacja NA maszynie wirtualnej. Uruchamiany przez deploy.sh jako root.
#
# Idempotentny: mozna uruchomic ponownie, zeby zaktualizowac aplikacje bez utraty bazy.
set -euo pipefail

PUBLIC_HOST="${PUBLIC_HOST:?brak PUBLIC_HOST}"
ADMIN_EMAIL="${ADMIN_EMAIL:?brak ADMIN_EMAIL}"

APP_USER="sdapp"
APP_DIR="/opt/stock-dashboard"
DATA_DIR="/var/lib/stock-dashboard"
ENV_FILE="/etc/stock-dashboard.env"
ARCHIVE="$(ls /home/*/stock-dashboard.tar.gz 2>/dev/null | head -1)"
CADDY_TMPL="$(ls /home/*/Caddyfile.tmpl 2>/dev/null | head -1)"

info() { printf '\033[32m==>\033[0m %s\n' "$1"; }

# ---------------------------------------------------------------- system
info "Aktualizuje system i wlaczam automatyczne poprawki bezpieczenstwa"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg debian-keyring debian-archive-keyring \
  apt-transport-https unattended-upgrades jq rsync >/dev/null
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

# ---------------------------------------------------------------- Node.js 22+
# Debian 12 ma Node 18, a aplikacja wymaga >= 22 (wbudowany modul node:sqlite).
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  CURRENT="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
  [[ "$CURRENT" -ge 22 ]] && NEED_NODE=0
fi
if [[ "$NEED_NODE" -eq 1 ]]; then
  info "Instaluje Node.js 22 LTS"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
info "Node.js: $(node -v)"

# ---------------------------------------------------------------- Caddy (HTTPS automatyczne)
if ! command -v caddy >/dev/null 2>&1; then
  info "Instaluje Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

# ---------------------------------------------------------------- uzytkownik i katalogi
if ! id "$APP_USER" >/dev/null 2>&1; then
  info "Tworze uzytkownika systemowego $APP_USER"
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi
mkdir -p "$APP_DIR" "$DATA_DIR/cache" "$DATA_DIR/backups"

# ---------------------------------------------------------------- kod aplikacji
info "Rozpakowuje aplikacje do $APP_DIR"
[[ -n "$ARCHIVE" ]] || { echo "Brak archiwum stock-dashboard.tar.gz"; exit 1; }
TMP="$(mktemp -d)"
tar -xzf "$ARCHIVE" -C "$TMP"
rm -rf "$APP_DIR.old"
# Poprzednia wersja zostaje obok - pozwala cofnac aktualizacje bez ponownego wdrozenia.
if [[ -d "$APP_DIR/src" ]]; then
  cp -r "$APP_DIR" "$APP_DIR.old"
fi
rsync -a --delete --exclude='data' "$TMP/stock-dashboard/" "$APP_DIR/"
rm -rf "$TMP"

# Prawa normalizujemy JAWNIE. Archiwum niesie prawa z maszyny, na ktorej powstalo,
# a rsync ze slashem na koncu zrodla przenosi je takze na katalog docelowy.
# Katalog projektu z prawami 700 sprawilby, ze uzytkownik uslugi nie wejdzie do WorkingDirectory
# i systemd zglosi "Changing to the requested working directory failed: Permission denied".
chown -R root:root "$APP_DIR"
chmod 755 "$APP_DIR"
find "$APP_DIR" -type d -exec chmod 755 {} +
find "$APP_DIR" -type f -exec chmod 644 {} +

# Dane naleza do uslugi i pozostaja prywatne.
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 700 "$DATA_DIR"

# Kontrola: uzytkownik uslugi musi umiec wejsc do katalogu i odczytac wejsciowy plik.
sudo -u "$APP_USER" test -x "$APP_DIR" && sudo -u "$APP_USER" test -r "$APP_DIR/server.mjs" \
  || { echo "Blad praw dostepu do $APP_DIR dla uzytkownika $APP_USER"; ls -ld "$APP_DIR"; exit 1; }

# ---------------------------------------------------------------- konfiguracja
# Konto wlasciciela powstaje PRZY PIERWSZYM STARCIE, zanim serwis stanie sie osiagalny z internetu.
# Bez tego kazdy, kto trafilby na adres przed Toba, moglby przejac konto wlasciciela.
if [[ ! -f "$ENV_FILE" ]]; then
  ADMIN_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20)Aa1!"
  info "Tworze $ENV_FILE i konto wlasciciela"
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
SD_HOST=127.0.0.1
SD_PORT=8787
SD_BASE_PATH=/stock-dashboard
SD_DATA_DIR=$DATA_DIR
SD_DB_PATH=$DATA_DIR/dashboard.db

# Aplikacja stoi za Caddy, ktory terminuje HTTPS i ustawia X-Forwarded-For.
SD_COOKIE_SECURE=1
SD_TRUST_PROXY=1

# Rejestracja wylacznie na zaproszenie - serwis jest publicznie osiagalny.
SD_OPEN_REGISTRATION=0
SD_SESSION_TTL_HOURS=336
SD_SESSION_IDLE_HOURS=72
SD_LOGIN_MAX_ATTEMPTS=8
SD_LOGIN_LOCKOUT_MINUTES=15

SD_DEFAULT_LOCALE=pl
SD_EOD_TIMEZONE=Europe/Warsaw
SD_LOG_LEVEL=info

# Konto wlasciciela tworzone przy pierwszym starcie (tylko gdy baza jest pusta).
SD_BOOTSTRAP_EMAIL=$ADMIN_EMAIL
SD_BOOTSTRAP_PASSWORD=$ADMIN_PASSWORD
EOF
  chmod 600 "$ENV_FILE"
  chown root:"$APP_USER" "$ENV_FILE"
  NEW_ACCOUNT=1
else
  info "Zachowuje istniejacy $ENV_FILE"
  NEW_ACCOUNT=0
fi

# ---------------------------------------------------------------- systemd
info "Konfiguruje usluge systemd"
cat > /etc/systemd/system/stock-dashboard.service <<EOF
[Unit]
Description=Master Portfolio Dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node $APP_DIR/server.mjs
EnvironmentFile=$ENV_FILE
Restart=always
RestartSec=3
TimeoutStopSec=15

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictNamespaces=true
LockPersonality=true
MemoryMax=420M

StandardOutput=journal
StandardError=journal
SyslogIdentifier=stock-dashboard

[Install]
WantedBy=multi-user.target
EOF

# Codzienna kopia zapasowa bazy (e2-micro ma 30 GB dysku, kopie sa male).
cat > /etc/systemd/system/stock-dashboard-backup.service <<EOF
[Unit]
Description=Kopia zapasowa bazy Master Portfolio Dashboard

[Service]
Type=oneshot
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $APP_DIR/scripts/admin.mjs backup
EOF

cat > /etc/systemd/system/stock-dashboard-backup.timer <<'EOF'
[Unit]
Description=Codzienna kopia zapasowa dashboardu

[Timer]
OnCalendar=*-*-* 21:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

# ---------------------------------------------------------------- Caddy
info "Konfiguruje HTTPS dla $PUBLIC_HOST"
sed "s|__PUBLIC_HOST__|$PUBLIC_HOST|g" "$CADDY_TMPL" > /etc/caddy/Caddyfile
# Caddy pisze swoje logi na stderr, wiec samo '>/dev/null' ich nie wycisza.
# Bez tego walidacja wypluwa sciane komunikatow 'info', w tym 'servers shutting down',
# ktore wygladaja na awarie, a sa normalnym demontazem po sprawdzeniu konfiguracji.
if caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>/tmp/caddy-validate.log; then
  info "Konfiguracja Caddy poprawna"
else
  echo "Konfiguracja Caddy jest niepoprawna:"
  cat /tmp/caddy-validate.log
  exit 1
fi

# ---------------------------------------------------------------- start
systemctl daemon-reload
systemctl enable --now stock-dashboard.service >/dev/null
systemctl enable --now stock-dashboard-backup.timer >/dev/null
systemctl restart caddy

sleep 3
if ! systemctl is-active --quiet caddy; then
  echo "Caddy nie wstal. Ostatnie logi:"
  journalctl -u caddy -n 30 --no-pager
  exit 1
fi

# 'is-active' potrafi zwrocic prawde, zanim Caddy zdazy sie wywrocic na konfiguracji.
# Sprawdzamy wiec jeszcze, czy port 443 faktycznie nasluchuje.
sleep 2
if ! ss -ltn 2>/dev/null | grep -q ':443 '; then
  echo "Caddy nie nasluchuje na porcie 443. Ostatnie logi:"
  journalctl -u caddy -n 30 --no-pager
  exit 1
fi
info "Caddy nasluchuje na 443 (certyfikat dla $PUBLIC_HOST moze dojsc jeszcze przez chwile)"

if ! systemctl is-active --quiet stock-dashboard; then
  echo "Usluga nie wstala. Ostatnie logi:"
  journalctl -u stock-dashboard -n 40 --no-pager
  exit 1
fi

for _ in $(seq 1 15); do
  curl -fsS --max-time 5 "http://127.0.0.1:8787/stock-dashboard/api/v1/health" >/dev/null 2>&1 && break
  sleep 2
done

info "Usluga dziala: $(curl -s http://127.0.0.1:8787/stock-dashboard/api/v1/health | jq -c '{ok,version}')"

# Haslo pokazujemy dokladnie raz, a potem usuwamy je z pliku srodowiskowego,
# zeby nie lezalo na dysku dluzej niz to konieczne.
if [[ "$NEW_ACCOUNT" -eq 1 ]]; then
  echo
  echo "┌──────────────────────────────────────────────────────────────┐"
  echo "│  KONTO WLASCICIELA - zapisz teraz, nie bedzie pokazane ponownie │"
  echo "└──────────────────────────────────────────────────────────────┘"
  echo "   login:  $ADMIN_EMAIL"
  echo "   haslo:  $ADMIN_PASSWORD"
  echo
  sed -i '/^SD_BOOTSTRAP_PASSWORD=/d; /^SD_BOOTSTRAP_EMAIL=/d' "$ENV_FILE"
  systemctl restart stock-dashboard
fi

info "Gotowe: https://$PUBLIC_HOST/stock-dashboard/"
