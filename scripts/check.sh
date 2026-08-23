#!/usr/bin/env bash
# scripts/check.sh - komplet kontroli przed commitem.
#
# TO SAMO uruchamia CI: .github/workflows/ci.yml wywoluje ten plik, zamiast powtarzac
# jego tresc. Dzieki temu "u mnie przechodzi" nie moze rozminac sie z wynikiem na
# GitHubie - bo to doslownie to samo polecenie i to samo srodowisko.
#
# Powodem powstania byl przebieg, w ktorym testy przechodzily lokalnie i padaly w CI:
# CI ustawia SD_OFFLINE=1, a ja uruchamialem je bez tej zmiennej.
#
#   bash scripts/check.sh          # wszystko
#   bash scripts/check.sh szybko   # bez testu dymnego (~15 s szybciej)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Zero ruchu do zrodel rynkowych - identycznie jak w CI.
export SD_OFFLINE=1

TRYB="${1:-pelny}"
BLEDY=0

krok() { printf '\n\033[36m== %s\033[0m\n' "$1"; }
zle()  { printf '\033[31m[x] %s\033[0m\n' "$1"; BLEDY=$((BLEDY + 1)); }
ok()   { printf '\033[32m[v] %s\033[0m\n' "$1"; }

krok "Wersja Node (wymagany node:sqlite)"
node -v
if node -e "require('node:sqlite')" 2>/dev/null; then ok "node:sqlite dostepny"; else zle "brak node:sqlite - wymagany Node 22+"; fi

krok "Skladnia backendu i skryptow"
for f in server.mjs src/*.mjs src/*/*.mjs scripts/*.mjs tests/*.mjs; do
  node --check "$f" 2>/dev/null || zle "Blad skladni: $f"
done
[[ $BLEDY -eq 0 ]] && ok "wszystkie moduly parsuja sie poprawnie"

krok "Skladnia frontendu (moduly ES)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
for f in public/*.js; do cp "$f" "$T/$(basename "${f%.js}").mjs"; done
for f in "$T"/*.mjs; do
  node --check "$f" 2>/dev/null || zle "Blad skladni: $(basename "$f")"
done
ok "frontend parsuje sie jako moduly ES"

krok "Skladnia skryptow powloki"
for f in deploy/gcp/*.sh ops/*.sh tests/*.sh scripts/*.sh; do
  [[ -e "$f" ]] || continue
  bash -n "$f" 2>/dev/null || zle "Blad skladni: $f"
done
ok "skrypty powloki parsuja sie poprawnie"

krok "Straznik migracji"
node scripts/migration-guard.mjs check || zle "straznik migracji odrzucil zmiany"

krok "Testy jednostkowe, i18n, migracje, import, odtwarzanie historii"
if node --test tests/*.test.mjs 2>&1 | tail -20 | grep -qE '^# fail 0'; then
  ok "wszystkie testy przechodza"
else
  node --test tests/*.test.mjs 2>&1 | grep -E '^not ok|^# (tests|pass|fail)'
  zle "testy jednostkowe nie przechodza"
fi

if [[ "$TRYB" != "szybko" ]]; then
  krok "Smoke end-to-end"
  bash tests/smoke.sh >/tmp/smoke-out.txt 2>&1
  if grep -q "0 FAIL" /tmp/smoke-out.txt; then
    ok "$(grep 'Wynik:' /tmp/smoke-out.txt | sed 's/\x1b\[[0-9;]*m//g')"
  else
    grep -E "FAIL" /tmp/smoke-out.txt | head -10
    zle "test dymny nie przeszedl"
  fi
else
  printf '\n\033[33m[!] pomijam test dymny (tryb szybki)\033[0m\n'
fi

krok "Sekrety nie moga trafic do repozytorium"
if git ls-files | grep -E '(^|/)\.env$|\.db$|\.db-wal$|\.db-shm$'; then
  zle "w repozytorium sa pliki, ktorych tam byc nie powinno"
else
  ok "brak sekretow i baz w repozytorium"
fi

echo
if [[ $BLEDY -eq 0 ]]; then
  printf '\033[32m════ Wszystko przechodzi. To samo zobaczysz w CI.\033[0m\n'
else
  printf '\033[31m════ Niepowodzen: %d. CI zatrzyma te zmiane.\033[0m\n' "$BLEDY"
fi
exit $(( BLEDY > 0 ? 1 : 0 ))
