#!/usr/bin/env bash
# deploy/gcp/update.sh - wgrywa nowa wersje kodu na dzialajaca maszyne.
#
# Baza, konfiguracja i konta zostaja nietkniete. Poprzednia wersja kodu
# ladauje w /opt/stock-dashboard.old, wiec cofniecie to jedna komenda.
set -euo pipefail

VM_NAME="${VM_NAME:-stock-dashboard}"
ZONE="${ZONE:-us-central1-a}"
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "==> Uruchamiam testy przed wysylka"
( cd "$ROOT" && SD_OFFLINE=1 SD_DATA_DIR=/tmp/upd SD_DB_PATH=/tmp/upd.db node --test tests/*.test.mjs >/dev/null 2>&1 ) \
  || { echo "Testy nie przechodza - wstrzymuje aktualizacje."; exit 1; }
echo "    testy OK"

echo "==> Robie kopie bazy przed aktualizacja"
gcloud compute ssh "$VM_NAME" --zone "$ZONE" --project "$PROJECT_ID" --tunnel-through-iap --quiet \
  --command="sudo systemctl start stock-dashboard-backup.service"

echo "==> Pakuje i wysylam"
# Kopiujemy do katalogu nazwanego "stock-dashboard" i pakujemy go wprost -
# dziala identycznie z BSD tar (macOS) i GNU tar (Linux), bez --transform/--mode,
# ktorych BSD tar nie zna. Prawa w archiwum nie maja znaczenia - zdalna strona
# i tak wymusza je przez chmod/find po rozpakowaniu (nizej).
STAGE="$(mktemp -d)"
rsync -a --exclude='.git' --exclude='data' --exclude='.env' --exclude='node_modules' \
  "$ROOT/" "$STAGE/stock-dashboard/"
PKG="$(mktemp -d)/stock-dashboard.tar.gz"
tar -czf "$PKG" -C "$STAGE" stock-dashboard
rm -rf "$STAGE"
gcloud compute scp "$PKG" "$VM_NAME":~/ --zone "$ZONE" --project "$PROJECT_ID" --tunnel-through-iap --quiet

echo "==> Podmieniam kod i restartuje usluge"
gcloud compute ssh "$VM_NAME" --zone "$ZONE" --project "$PROJECT_ID" --tunnel-through-iap --quiet --command='
  set -e
  TMP=$(mktemp -d)
  tar -xzf ~/stock-dashboard.tar.gz -C "$TMP"
  sudo rm -rf /opt/stock-dashboard.old
  sudo cp -r /opt/stock-dashboard /opt/stock-dashboard.old
  sudo rsync -a --delete --exclude="data" "$TMP/stock-dashboard/" /opt/stock-dashboard/
  sudo chown -R root:root /opt/stock-dashboard
  sudo chmod 755 /opt/stock-dashboard
  sudo find /opt/stock-dashboard -type d -exec chmod 755 {} +
  sudo find /opt/stock-dashboard -type f -exec chmod 644 {} +
  rm -rf "$TMP"
  sudo systemctl restart stock-dashboard
  sleep 3
  sudo systemctl is-active --quiet stock-dashboard && echo "    usluga dziala" || { sudo journalctl -u stock-dashboard -n 30 --no-pager; exit 1; }
'

echo "==> Sprawdzam zdrowie"
gcloud compute ssh "$VM_NAME" --zone "$ZONE" --project "$PROJECT_ID" --tunnel-through-iap --quiet \
  --command="curl -s http://127.0.0.1:8787/stock-dashboard/api/v1/health | jq -c '{ok,version}'"

echo
echo "Cofniecie aktualizacji, gdyby cos poszlo nie tak:"
echo "  gcloud compute ssh $VM_NAME --zone $ZONE --tunnel-through-iap --command \\"
echo "    'sudo rsync -a --delete /opt/stock-dashboard.old/ /opt/stock-dashboard/ && sudo systemctl restart stock-dashboard'"
