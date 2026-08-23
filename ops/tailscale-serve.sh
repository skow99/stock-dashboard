#!/usr/bin/env bash
# ops/tailscale-serve.sh - publikacja dashboardu w tailnecie (HTTPS, bez wystawiania na internet).
set -euo pipefail

PORT="${SD_PORT:-8787}"
BASE="${SD_BASE_PATH:-/stock-dashboard}"

tailscale serve --bg --set-path "$BASE" "http://127.0.0.1:${PORT}${BASE}"

# Webhook brokera - osobna sciezka, autoryzacja tokenem Bearer po stronie aplikacji.
tailscale serve --bg --set-path /xtb-webhook  "http://127.0.0.1:${PORT}${BASE}/api/v1/webhook/xtb"
tailscale serve --bg --set-path /ibkr-webhook "http://127.0.0.1:${PORT}${BASE}/api/v1/webhook/ibkr"

echo "Aktualna konfiguracja:"
tailscale serve status

echo
echo "UWAGA: 'tailscale funnel' wystawilby dashboard na publiczny internet."
echo "Ta aplikacja jest przeznaczona do tailnetu - nie wlaczaj funnel bez swiadomej decyzji."
