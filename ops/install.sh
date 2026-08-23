#!/usr/bin/env bash
# ops/install.sh - instalacja jako usluga user-level systemd.
set -euo pipefail

APP_DIR="${1:-$HOME/apps/stock-dashboard}"
UNIT_DIR="$HOME/.config/systemd/user"

echo "Katalog aplikacji: $APP_DIR"
[[ -f "$APP_DIR/server.mjs" ]] || { echo "Brak server.mjs w $APP_DIR"; exit 1; }
[[ -f "$APP_DIR/.env" ]] || { echo "Brak .env - skopiuj .env.example do .env i uzupelnij"; exit 1; }

NODE_MAJOR="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
if (( NODE_MAJOR < 22 )); then
  echo "Wymagany Node.js >= 22 (node:sqlite). Wykryto: $(node -v)"; exit 1
fi

mkdir -p "$UNIT_DIR" "$APP_DIR/data/cache"
chmod 700 "$APP_DIR/data"
chmod 600 "$APP_DIR/.env"

for unit in stock-dashboard.service stock-dashboard-backup.service stock-dashboard-backup.timer; do
  sed "s|%h/apps/stock-dashboard|$APP_DIR|g" "$APP_DIR/ops/$unit" > "$UNIT_DIR/$unit"
done

systemctl --user daemon-reload
systemctl --user enable --now stock-dashboard.service
systemctl --user enable --now stock-dashboard-backup.timer
loginctl enable-linger "$USER" 2>/dev/null || echo "Uwaga: nie udalo sie wlaczyc lingera - usluga nie wstanie bez zalogowania."

sleep 2
systemctl --user status stock-dashboard.service --no-pager || true
echo
echo "Health: curl -s http://127.0.0.1:8787/stock-dashboard/api/v1/health"
