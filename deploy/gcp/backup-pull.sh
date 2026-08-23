#!/usr/bin/env bash
# deploy/gcp/backup-pull.sh - sciaga kopie bazy z maszyny na Twoj komputer.
#
# Maszyna robi kopie codziennie sama, ale kopia lezaca na tym samym dysku
# nie chroni przed usunieciem maszyny. Ten skrypt zabiera ja lokalnie.
set -euo pipefail

VM_NAME="${VM_NAME:-stock-dashboard}"
ZONE="${ZONE:-us-central1-a}"
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
DEST="${1:-./backups}"

mkdir -p "$DEST"
STAMP="$(date +%Y-%m-%d-%H%M%S)"

echo "==> Wymuszam swieza kopie na maszynie"
gcloud compute ssh "$VM_NAME" --zone "$ZONE" --project "$PROJECT_ID" --tunnel-through-iap --quiet \
  --command="sudo systemctl start stock-dashboard-backup.service && sleep 3 && sudo ls -1t /var/lib/stock-dashboard/backups/*.db | head -1"

LATEST="$(gcloud compute ssh "$VM_NAME" --zone "$ZONE" --project "$PROJECT_ID" --tunnel-through-iap --quiet \
  --command="sudo ls -1t /var/lib/stock-dashboard/backups/*.db | head -1" 2>/dev/null | tr -d '\r')"
[[ -n "$LATEST" ]] || { echo "Nie znalazlem kopii na maszynie."; exit 1; }

echo "==> Kopiuje $LATEST"
gcloud compute ssh "$VM_NAME" --zone "$ZONE" --project "$PROJECT_ID" --tunnel-through-iap --quiet \
  --command="sudo cp '$LATEST' /tmp/backup.db && sudo chmod 644 /tmp/backup.db"
gcloud compute scp "$VM_NAME":/tmp/backup.db "$DEST/dashboard-$STAMP.db" \
  --zone "$ZONE" --project "$PROJECT_ID" --tunnel-through-iap --quiet
gcloud compute ssh "$VM_NAME" --zone "$ZONE" --project "$PROJECT_ID" --tunnel-through-iap --quiet \
  --command="sudo rm -f /tmp/backup.db"

echo "==> Zapisano: $DEST/dashboard-$STAMP.db ($(du -h "$DEST/dashboard-$STAMP.db" | cut -f1))"
echo "    Podglad:  sqlite3 $DEST/dashboard-$STAMP.db 'SELECT COUNT(*) FROM transactions;'"
