#!/usr/bin/env bash
# deploy/gcp/ci-ssh.sh - jedyny sposob, w jaki CI rozmawia z maszyna.
#
# Powstal, bo wdrozenie potrafilo paść na:
#   sa_1084...@compute.5301...: Permission denied (publickey)
# mimo ze sonda polaczenia chwile wczesniej przeszla. OS Login rozpropagowuje klucz
# konta uslugowego z opoznieniem i bez gwarancji - polaczenie, ktore dziala teraz,
# za cztery sekundy moze zostac odrzucone. Jedyna sensowna odpowiedz to ponawianie,
# a zeby nie powtarzac go w szesciu krokach workflow, mieszka w jednym pliku.
#
#   ci-ssh.sh run  <maszyna> <strefa> <polecenie>
#   ci-ssh.sh send <maszyna> <strefa> <plik-lokalny> <sciezka-zdalna>
#
# 'send' NIE uzywa 'gcloud compute scp'. Od OpenSSH 9.0 scp przesyla dane podsystemem
# SFTP, ktory przez tunel IAP potrafi zawisnac na glucho. Strumien na stdin idzie ta sama
# droga co zwykle polecenie, wiec dziala wszedzie tam, gdzie dziala 'run'.
set -uo pipefail

TRYB="${1:?Uzycie: ci-ssh.sh run|send <maszyna> <strefa> ...}"
MASZYNA="${2:?Brak nazwy maszyny}"
STREFA="${3:?Brak strefy}"

PROBY="${CI_SSH_PROBY:-6}"
PRZERWA="${CI_SSH_PRZERWA:-10}"
LIMIT="${CI_SSH_LIMIT:-360}"

# -oNazwa=wartosc bez spacji: przezywa podzial slow, gdy zmienna trafia do polecenia.
FLAGI=(
  --ssh-flag=-oStrictHostKeyChecking=no
  --ssh-flag=-oUserKnownHostsFile=/dev/null
  --ssh-flag=-oBatchMode=yes
  --ssh-flag=-oConnectTimeout=20
  --ssh-flag=-oServerAliveInterval=15
  --ssh-flag=-oServerAliveCountMax=4
)

# Blad przejsciowy: warto ponowic. Blad trwaly (brak uprawnien IAM, zla nazwa maszyny,
# nieudane polecenie na maszynie) ponawiac nie ma po co - tylko przedluza czekanie.
przejsciowy() {
  grep -qiE 'Permission denied \(publickey\)|Connection (closed|refused|reset)|Broken pipe|kex_exchange_identification|Connection timed out|failed to connect to backend' <<<"$1"
}

polaczenie_zdolne() {
  local wyjscie="$1" kod="$2"
  [[ $kod -eq 0 ]] && return 0
  przejsciowy "$wyjscie"
}

uruchom() {
  local polecenie="$1" plik="${2:-}"
  local proba wyjscie kod

  for (( proba = 1; proba <= PROBY; proba++ )); do
    if [[ -n "$plik" ]]; then
      # Plik otwieramy WEWNATRZ petli. Gdyby stdin byl podpiety raz na zewnatrz,
      # druga proba dostalaby strumien juz wyczerpany i wyslala pusta paczke.
      wyjscie=$(timeout "$LIMIT" gcloud compute ssh "$MASZYNA" \
        --zone "$STREFA" --tunnel-through-iap --quiet \
        "${FLAGI[@]}" --ssh-flag=-T \
        --command="$polecenie" < "$plik" 2>&1)
    else
      wyjscie=$(timeout "$LIMIT" gcloud compute ssh "$MASZYNA" \
        --zone "$STREFA" --tunnel-through-iap --quiet \
        "${FLAGI[@]}" --command="$polecenie" 2>&1)
    fi
    kod=$?

    if [[ $kod -eq 0 ]]; then
      [[ -n "$wyjscie" ]] && printf '%s\n' "$wyjscie"
      [[ $proba -gt 1 ]] && echo "[ci-ssh] udalo sie za ${proba}. razem" >&2
      return 0
    fi

    if ! przejsciowy "$wyjscie"; then
      echo "[ci-ssh] blad trwaly (kod $kod), nie ponawiam:" >&2
      printf '%s\n' "$wyjscie" >&2
      return "$kod"
    fi

    echo "[ci-ssh] proba ${proba}/${PROBY} nieudana (kod $kod), czekam ${PRZERWA}s" >&2
    printf '%s\n' "$wyjscie" | tail -3 | sed 's/^/[ci-ssh]   | /' >&2
    sleep "$PRZERWA"
  done

  echo "[ci-ssh] wyczerpalem ${PROBY} prob. Ostatnia odpowiedz:" >&2
  printf '%s\n' "$wyjscie" >&2
  return 1
}

case "$TRYB" in
  run)
    POLECENIE="${4:?Brak polecenia do wykonania}"
    uruchom "$POLECENIE"
    ;;

  send)
    ZRODLO="${4:?Brak pliku zrodlowego}"
    CEL="${5:?Brak sciezki docelowej}"
    [[ -f "$ZRODLO" ]] || { echo "[ci-ssh] brak pliku: $ZRODLO" >&2; exit 1; }

    ROZMIAR=$(stat -c%s "$ZRODLO")
    SUMA_LOKALNA=$(sha256sum "$ZRODLO" | cut -d' ' -f1)
    echo "[ci-ssh] wysylam $ZRODLO -> $CEL ($ROZMIAR B, sha256 ${SUMA_LOKALNA:0:16}...)"

    START=$(date +%s)
    uruchom "cat > $CEL" "$ZRODLO" || exit 1
    echo "[ci-ssh] przeslano w $(( $(date +%s) - START )) s"

    # Weryfikacja jest obowiazkowa: uszkodzona paczka wyszlaby na jaw dopiero przy
    # rozpakowaniu na maszynie, czyli juz po zatrzymaniu uslugi.
    ODPOWIEDZ=$(uruchom "sha256sum $CEL" || true)
    SUMA_ZDALNA=$(printf '%s' "$ODPOWIEDZ" | tr -d '\r' | grep -oE '[0-9a-f]{64}' | head -1 || true)

    if [[ -z "$SUMA_ZDALNA" ]]; then
      echo "[ci-ssh] nie odczytalem sumy kontrolnej z maszyny. Surowa odpowiedz:" >&2
      printf '%s\n' "$ODPOWIEDZ" | sed 's/^/[ci-ssh]   | /' >&2
      exit 1
    fi
    if [[ "$SUMA_LOKALNA" != "$SUMA_ZDALNA" ]]; then
      echo "[ci-ssh] paczka dotarla uszkodzona." >&2
      echo "[ci-ssh]   lokalnie:    $SUMA_LOKALNA" >&2
      echo "[ci-ssh]   na maszynie: $SUMA_ZDALNA" >&2
      exit 1
    fi
    echo "[ci-ssh] suma kontrolna zgadza sie z lokalna"
    ;;

  *)
    echo "Nieznany tryb: $TRYB (run albo send)" >&2
    exit 1
    ;;
esac
