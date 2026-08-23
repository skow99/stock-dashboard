#!/usr/bin/env bash
# tests/smoke.sh - end-to-end smoke test na czystej bazie, w trybie offline (bez ruchu sieciowego).
# Uruchomienie: bash tests/smoke.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMOKE_PORT:-8799}"
WORK="$(mktemp -d)"
JAR="$WORK/cookies.jar"
B="http://127.0.0.1:$PORT/stock-dashboard/api/v1"
PASS=0
FAIL=0

cleanup() { [[ -n "${SRV_PID:-}" ]] && kill "$SRV_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (oczekiwano '$3', otrzymano '$2')"; fi; }
jqp()  { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null || echo "PARSE_ERROR"; }

echo "== start serwera (offline, tymczasowa baza)"
SD_OFFLINE=1 SD_DATA_DIR="$WORK/data" SD_DB_PATH="$WORK/test.db" SD_PORT="$PORT" \
  node "$ROOT/server.mjs" > "$WORK/server.log" 2>&1 &
SRV_PID=$!
for _ in $(seq 1 40); do
  curl -sf "$B/health" >/dev/null 2>&1 && break
  sleep 0.25
done

echo "== health i stan instalacji"
check "health ok" "$(curl -s "$B/health" | jqp "d['ok']")" "True"
check "needsBootstrap" "$(curl -s "$B/auth/bootstrap" | jqp "d['needsBootstrap']")" "True"

echo "== polityka hasel"
check "slabe haslo odrzucone" \
  "$(curl -s -X POST "$B/auth/register" -H 'content-type: application/json' \
      -d '{"email":"a@example.com","password":"haslo"}' | jqp "d['error']['code']")" "weak_password"

echo "== rejestracja pierwszego uzytkownika (owner)"
REG=$(curl -s -c "$JAR" -X POST "$B/auth/register" -H 'content-type: application/json' \
  -d '{"email":"owner@example.com","password":"Portfel!2026x","displayName":"Owner"}')
check "rola owner" "$(echo "$REG" | jqp "d['user']['role']")" "owner"
CSRF=$(echo "$REG" | jqp "d['csrfToken']")
PF1=$(echo "$REG" | jqp "d['portfolios'][0]['id']")
check "domyslny portfel utworzony" "$(echo "$REG" | jqp "len(d['portfolios'])")" "1"

AUTH=(-b "$JAR" -H 'content-type: application/json' -H "x-csrf-token: $CSRF")

echo "== ochrona CSRF i sesji"
check "zapis bez CSRF odrzucony" \
  "$(curl -s -b "$JAR" -X POST "$B/portfolios" -H 'content-type: application/json' -d '{"name":"X"}' | jqp "d['error']['code']")" "csrf_missing"
check "odczyt bez sesji odrzucony" \
  "$(curl -s "$B/dashboard" | jqp "d['error']['code']")" "unauthorized"

echo "== drugi portfel"
PF2=$(curl -s "${AUTH[@]}" -X POST "$B/portfolios" -d '{"name":"IKE","kind":"ike","color":"#f6c85f"}' | jqp "d['portfolio']['id']")
check "portfel IKE utworzony" "$([[ "$PF2" == pf_* ]] && echo yes)" "yes"

echo "== ledger portfela 1"
curl -s "${AUTH[@]}" -X POST "$B/portfolios/$PF1/cash-flows" -d '{"date":"2026-01-02","type":"Deposit","amount":100000,"currency":"PLN"}' >/dev/null
curl -s "${AUTH[@]}" -X POST "$B/portfolios/$PF1/transactions" -d '{"date":"2026-01-10","ticker":"GPW.PL","name":"GPW","side":"BUY","qty":100,"price":45.12,"currency":"PLN"}' >/dev/null
SELL=$(curl -s "${AUTH[@]}" -X POST "$B/portfolios/$PF1/transactions" -d '{"date":"2026-03-10","ticker":"GPW.WA","side":"SELL","qty":40,"price":52.30,"currency":"PLN"}')
check "kanonizacja GPW.PL -> GPW.WA" \
  "$(curl -s -b "$JAR" "$B/portfolios/$PF1/transactions" | jqp "d['transactions'][0]['ticker']")" "GPW.WA"
check "realized P/L policzony" "$(echo "$SELL" | jqp "d['ok']")" "True"

echo "== ledger portfela 2"
curl -s "${AUTH[@]}" -X POST "$B/portfolios/$PF2/cash-flows" -d '{"date":"2026-02-01","type":"Deposit","amount":20000,"currency":"PLN"}' >/dev/null
curl -s "${AUTH[@]}" -X POST "$B/portfolios/$PF2/transactions" -d '{"date":"2026-02-05","ticker":"MSFT","side":"BUY","qty":10,"price":420,"currency":"USD"}' >/dev/null

echo "== ochrona przed osieroconym SELL"
curl -s "${AUTH[@]}" -X POST "$B/portfolios/$PF1/transactions" -d '{"date":"2026-04-10","ticker":"ZZZZ.WA","side":"SELL","qty":10,"price":100,"currency":"PLN"}' >/dev/null
D1=$(curl -s -b "$JAR" "$B/dashboard?portfolio=$PF1&force=1")
check "ostrzezenie orphan_sell" "$(echo "$D1" | jqp "d['warnings'][0]['code']")" "orphan_sell"
check "osierocony SELL nie podnosi gotowki" \
  "$(echo "$D1" | jqp "f\"{d['totals']['cashPln']:.2f}\"")" "97580.00"
check "pozycja GPW 60 szt." "$(echo "$D1" | jqp "d['positions'][0]['qty']")" "60"

echo "== widok skonsolidowany"
DALL=$(curl -s -b "$JAR" "$B/dashboard?portfolio=all&force=1")
check "tryb all" "$(echo "$DALL" | jqp "d['scope']['mode']")" "all"
check "dwa portfele w zakresie" "$(echo "$DALL" | jqp "d['scope']['portfolioCount']")" "2"
check "suma = suma portfeli" \
  "$(echo "$DALL" | jqp "round(d['totals']['totalPln'] - sum(p['totalPln'] for p in d['portfolios']),6)")" "0.0"
check "pozycje z obu portfeli" "$(echo "$DALL" | jqp "len(d['positions'])")" "2"

echo "== izolacja miedzy kontami"
JAR2="$WORK/other.jar"
INV=$(curl -s "${AUTH[@]}" -X POST "$B/admin/invites" -d '{"role":"user"}' | jqp "d['code']")
REG2=$(curl -s -c "$JAR2" -X POST "$B/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"other@example.com\",\"password\":\"Inne!Haslo2026\",\"inviteCode\":\"$INV\"}")
CSRF2=$(echo "$REG2" | jqp "d['csrfToken']")
check "rejestracja na zaproszenie" "$(echo "$REG2" | jqp "d['user']['role']")" "user"
check "cudzy portfel niewidoczny (404)" \
  "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR2" "$B/portfolios/$PF1")" "404"
check "zapis do cudzego portfela odrzucony" \
  "$(curl -s -b "$JAR2" -H 'content-type: application/json' -H "x-csrf-token: $CSRF2" -X POST \
      "$B/portfolios/$PF1/transactions" -d '{"date":"2026-05-01","ticker":"X.WA","side":"BUY","qty":1,"price":1}' | jqp "d['error']['code']")" "portfolio_not_found"
check "rejestracja bez zaproszenia odrzucona" \
  "$(curl -s -X POST "$B/auth/register" -H 'content-type: application/json' \
      -d '{"email":"intruz@example.com","password":"Inne!Haslo2026"}' | jqp "d['error']['code']")" "registration_closed"


echo "== domyslna nazwa portfela zalezy od jezyka rejestracji"
JAR3="$WORK/en.jar"
INV_EN=$(curl -s "${AUTH[@]}" -X POST "$B/admin/invites" -d '{"role":"user"}' | jqp "d['code']")
REG_EN=$(curl -s -c "$JAR3" -X POST "$B/auth/register" -H 'content-type: application/json' -H 'accept-language: en-GB,en;q=0.9' \
  -d "{\"email\":\"english@example.com\",\"password\":\"Another!Pass2026\",\"inviteCode\":\"$INV_EN\"}")
check "portfel domyslny po angielsku" "$(echo "$REG_EN" | jqp "d['portfolios'][0]['name']")" "Main portfolio"

echo "== walidacja"
check "zla data" "$(curl -s "${AUTH[@]}" -X POST "$B/portfolios/$PF1/transactions" -d '{"date":"10-01-2026","ticker":"A.WA","side":"BUY","qty":1,"price":1}' | jqp "d['error']['code']")" "invalid_date"
check "ujemna ilosc" "$(curl -s "${AUTH[@]}" -X POST "$B/portfolios/$PF1/transactions" -d '{"date":"2026-01-01","ticker":"A.WA","side":"BUY","qty":-5,"price":1}' | jqp "d['error']['code']")" "number_must_be_positive"
check "nieznana waluta" "$(curl -s "${AUTH[@]}" -X POST "$B/portfolios/$PF1/cash-flows" -d '{"date":"2026-01-01","type":"Deposit","amount":1,"currency":"XYZ"}' | jqp "d['error']['code']")" "invalid_currency"
check "wyplata zapisana jako ujemna" \
  "$(curl -s "${AUTH[@]}" -X POST "$B/portfolios/$PF2/cash-flows" -d '{"date":"2026-03-01","type":"Withdrawal","amount":500,"currency":"PLN"}' | jqp "f\"{d['cashFlow']['amount']:.2f}\"")" "-500.00"

echo "== wielojezycznosc (PL / EN)"
BASEURL="http://127.0.0.1:$PORT/stock-dashboard"
check "blad po polsku (domyslnie)" \
  "$(curl -s "${AUTH[@]}" -X POST "$B/portfolios/$PF1/transactions" -d '{"date":"zle","ticker":"A.WA","side":"BUY","qty":1,"price":1}' | jqp "d['error']['message']")" \
  "Pole date musi miec format YYYY-MM-DD"
check "blad po angielsku (Accept-Language)" \
  "$(curl -s "${AUTH[@]}" -H 'accept-language: en-GB,en;q=0.9' -X POST "$B/portfolios/$PF1/transactions" -d '{"date":"zle","ticker":"A.WA","side":"BUY","qty":1,"price":1}' | jqp "d['error']['message']")" \
  "Field date must use the YYYY-MM-DD format"
check "kod bledu jest niezmienny miedzy jezykami" \
  "$(curl -s "${AUTH[@]}" -H 'accept-language: en' -X POST "$B/portfolios/$PF1/transactions" -d '{"date":"zle","ticker":"A.WA","side":"BUY","qty":1,"price":1}' | jqp "d['error']['code']")" "invalid_date"
check "?lang= wygrywa z naglowkiem" \
  "$(curl -s "${AUTH[@]}" -H 'accept-language: en' -X POST "$B/portfolios/$PF1/transactions?lang=pl" -d '{"date":"zle","ticker":"A.WA","side":"BUY","qty":1,"price":1}' | jqp "d['error']['message']")" \
  "Pole date musi miec format YYYY-MM-DD"
check "naglowek content-language" \
  "$(curl -s -D- -o /dev/null -b "$JAR" -H 'accept-language: en' "$B/dashboard?portfolio=$PF1" | grep -i '^content-language' | tr -d '\r' | awk '{print $2}')" "en"
check "nieobslugiwany jezyk wraca do PL" \
  "$(curl -s "${AUTH[@]}" -H 'accept-language: de-DE,de;q=0.9' -X POST "$B/portfolios/$PF1/transactions" -d '{"date":"zle","ticker":"A.WA","side":"BUY","qty":1,"price":1}' | jqp "d['error']['message']")" \
  "Pole date musi miec format YYYY-MM-DD"
check "CSV z naglowkami PL" \
  "$(curl -s -b "$JAR" "$B/dashboard.csv?portfolio=$PF1&lang=pl" | head -1)" \
  "ticker,waluta,ilosc,srednia_cena_zakupu,ostatnia_cena,wartosc_pln,wynik_pln,udzial_pct"
check "CSV z naglowkami EN" \
  "$(curl -s -b "$JAR" "$B/dashboard.csv?portfolio=$PF1&lang=en" | head -1)" \
  "ticker,currency,quantity,avg_buy_price,last_price,value_pln,pnl_pln,weight_pct"
check "modul i18n serwowany" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASEURL/i18n.js")" "200"

echo "== webhook"
WHT=$(curl -s "${AUTH[@]}" -X POST "$B/portfolios/$PF1/webhook-token" | jqp "d['token']")
check "webhook bez tokena odrzucony" \
  "$(curl -s -X POST "$B/webhook/ibkr" -H 'content-type: application/json' -d '{"text":"BOUGHT 1 X @WSE @ 1"}' | jqp "d['error']['code']")" "webhook_token_missing"
check "webhook IBKR parsuje zlecenie" \
  "$(curl -s -X POST "$B/webhook/ibkr" -H 'content-type: application/json' -H "authorization: Bearer $WHT" \
      -d '{"text":"BOUGHT 35 ETFBM40TR @WSE @ 172.38 (ABC123)","date":"2026-06-01"}' | jqp "d['transaction']['ticker']")" "ETFBM40TR.WA"
check "webhook deduplikuje" \
  "$(curl -s -X POST "$B/webhook/ibkr" -H 'content-type: application/json' -H "authorization: Bearer $WHT" \
      -d '{"text":"BOUGHT 35 ETFBM40TR @WSE @ 172.38 (ABC123)","date":"2026-06-01"}' | jqp "d['duplicate']")" "True"
check "webhook XTB parsuje zlecenie" \
  "$(curl -s -X POST "$B/webhook/xtb" -H 'content-type: application/json' -H "authorization: Bearer $WHT" \
      -d '{"text":"Your order BUY 10 GPW.PL at 50.25","date":"2026-06-02","dryRun":true}' | jqp "d['parsed']['ticker']")" "GPW.WA"

echo "== link publiczny tylko do odczytu"
SHARE=$(curl -s "${AUTH[@]}" -X POST "$B/share-links" -d "{\"portfolioId\":\"$PF1\",\"scope\":\"summary\",\"label\":\"Test\"}" | jqp "d['token']")
SH=$(curl -s "$B/share/$SHARE")
check "link publiczny dziala bez sesji" "$(echo "$SH" | jqp "d['readOnly']")" "True"
check "summary nie ujawnia ledgeru" "$(echo "$SH" | jqp "'transactions' in d")" "False"
# Nieistniejacy i uniewazniony token daja te sama odpowiedz - brak wyroczni do zgadywania tokenow.
check "nieznany token nie do odroznienia od wygaslego" \
  "$(curl -s "$B/share/$(printf 'x%.0s' {1..32})" | jqp "d['error']['code']")" "share_expired"
check "nieznany token zwraca 404" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$B/share/$(printf 'x%.0s' {1..32})")" "404"

echo "== eksport / CSV"
check "eksport zawiera transakcje" \
  "$(curl -s -b "$JAR" "$B/portfolios/$PF1/export" | jqp "len(d['transactions'])>0")" "True"
check "CSV ma naglowek" \
  "$(curl -s -b "$JAR" "$B/dashboard.csv?portfolio=$PF1" | head -1 | cut -d, -f1)" "ticker"
check "CSV skonsolidowany ma kolumne portfela" \
  "$(curl -s -b "$JAR" "$B/dashboard.csv?portfolio=all" | head -1 | cut -d, -f1)" "portfel"

echo "== zgodnosc wsteczna i wersjonowanie API"
check "/api/portfolio przekierowuje" \
  "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "http://127.0.0.1:$PORT/stock-dashboard/api/portfolio")" "301"
check "stare API zwraca 410" \
  "$(curl -s "http://127.0.0.1:$PORT/stock-dashboard/api/deposits" | jqp "d['error']['code']")" "api_version_removed"

echo "== frontend statyczny"
BASEURL="http://127.0.0.1:$PORT/stock-dashboard"
for f in "/" "/index.html" "/login.html" "/share.html" "/app.js" "/ui.js" "/charts.js" "/auth.js" "/share.js" "/styles.css" "/favicon.svg"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASEURL$f")
  check "serwuje $f" "$code" "200"
done
check "naglowek CSP obecny" \
  "$(curl -s -D- -o /dev/null "$BASEURL/" | grep -ci 'content-security-policy')" "1"
check "nosniff obecny" \
  "$(curl -s -D- -o /dev/null "$BASEURL/" | grep -ci 'x-content-type-options')" "1"
check "path traversal zablokowany" \
  "$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "$BASEURL/../../etc/passwd")" "404"
check "nieznany plik = 404" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASEURL/sekret.txt")" "404"
check "przekierowanie z / " \
  "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")" "302"

echo "== wylogowanie"
curl -s -b "$JAR" -X POST "$B/auth/logout" >/dev/null
check "po wylogowaniu brak dostepu" "$(curl -s -b "$JAR" "$B/dashboard" | jqp "d['error']['code']")" "unauthorized"

echo
printf 'Wynik: \033[32m%d PASS\033[0m, \033[31m%d FAIL\033[0m\n' "$PASS" "$FAIL"
if [[ $FAIL -gt 0 ]]; then echo "--- ostatnie linie logu serwera:"; tail -20 "$WORK/server.log"; fi
exit $(( FAIL > 0 ? 1 : 0 ))
