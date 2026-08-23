#!/usr/bin/env bash
# deploy/gcp/destroy.sh - usuwa wszystko, co utworzyl deploy.sh.
#
# UWAGA: kasuje maszyne razem z baza danych. Zrob najpierw kopie:
#   bash deploy/gcp/backup-pull.sh
set -euo pipefail

VM_NAME="${VM_NAME:-stock-dashboard}"
ZONE="${ZONE:-us-central1-a}"
TAG="stock-dashboard"
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"

echo "Projekt: $PROJECT_ID"
echo "Zostanie usuniete:"
echo "  - maszyna $VM_NAME ($ZONE) WRAZ Z BAZA DANYCH"
echo "  - reguly firewalla ${TAG}-web i ${TAG}-ssh-iap"
echo
read -r -p "Wpisz nazwe maszyny, zeby potwierdzic: " confirm
[[ "$confirm" == "$VM_NAME" ]] || { echo "Anulowano."; exit 1; }

gcloud compute instances delete "$VM_NAME" --zone "$ZONE" --project "$PROJECT_ID" --quiet || true
gcloud compute firewall-rules delete "${TAG}-web" --project "$PROJECT_ID" --quiet 2>/dev/null || true
gcloud compute firewall-rules delete "${TAG}-ssh-iap" --project "$PROJECT_ID" --quiet 2>/dev/null || true

echo "Usunieto. Sprawdz rozliczenia: https://console.cloud.google.com/billing"
