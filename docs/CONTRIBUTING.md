# Jak rozwijać ten projekt

System jest **live** i trzyma dane finansowe. Ten dokument opisuje przepływ pracy, który to uwzględnia.

---

## Przepływ w skrócie

```text
gałąź robocza  ──PR──▶  CI (testy)  ──merge do main──▶  CI  ──▶  staging  ──▶  produkcja
                                                                    │             │
                                                          sanityzowana      kopia zapasowa
                                                          kopia produkcji   + próba migracji
                                                                            + health check
                                                                            + rollback
```

Merge do `main` jedzie na produkcję **automatycznie**. To znaczy, że CI jest jedyną bramką jakości — nie ma człowieka, który złapie błąd w ostatniej chwili. Stąd nacisk na testy.

---

## Codzienna praca

```bash
git checkout -b feature/nazwa-zmiany

# ... zmiany w kodzie ...

# Pełny zestaw przed commitem (to samo uruchomi CI)
node scripts/migration-guard.mjs check
node --test tests/*.test.mjs
bash tests/smoke.sh

git add -A
git commit -m "zakres: co i dlaczego"
git push -u origin feature/nazwa-zmiany
# otwórz PR na GitHubie
```

Po merge do `main` reszta dzieje się sama. Postęp widać w zakładce **Actions**.

## Uruchomienie lokalnie

```bash
cp .env.example .env    # jeśli jeszcze nie masz
node server.mjs
# http://127.0.0.1:8787/stock-dashboard/
```

Lokalna baza (`data/dashboard.db`) jest w `.gitignore` i nie ma nic wspólnego z produkcją.

Tryb bez sieci — przydatny, gdy nie chcesz odpytywać źródeł rynkowych:

```bash
SD_OFFLINE=1 node server.mjs
```

## Testy

| Polecenie | Co sprawdza | Czas |
|---|---|---|
| `node --test tests/unit.test.mjs` | arytmetyka portfela, tickery, TWR, daty, parsery, hasła | ~1 s |
| `node --test tests/i18n.test.mjs` | spójność katalogów PL/EN, kompletność kluczy | ~1 s |
| `node --test tests/migrations.test.mjs` | niezmienność migracji, zgodność schematów, zachowanie danych | ~2 s |
| `node --test tests/import.test.mjs` | odczyt CSV, rozpoznanie formatu, deduplikacja, cofanie wsadu | ~2 s |
| `node --test tests/ui-contract.test.mjs` | selektory DOM, kompletność tłumaczeń, whitelist statyków | ~1 s |
| `node --test tests/migration.test.mjs` | migracja z v1 | ~1 s |
| `bash tests/smoke.sh` | 65 asercji end-to-end na czystej bazie | ~15 s |

Smoke test startuje własny serwer na porcie 8799 z tymczasową bazą i `SD_OFFLINE=1`. Nie dotyka niczego, co masz na dysku.

**Każda nowa funkcja powinna mieć test.** Skoro produkcja aktualizuje się sama, test jest jedyną rzeczą, która stoi między błędem a Twoimi danymi.

## Zmiany w bazie danych

Osobny dokument, przeczytaj przed pierwszą migracją: [`MIGRATIONS.md`](MIGRATIONS.md).

Skrót: nowa migracja idzie **na koniec** tablicy `MIGRATIONS`, nigdy nie edytujesz istniejącej, po dodaniu uruchamiasz `node scripts/migration-guard.mjs update`.

## Staging

Staging to druga usługa na tej samej maszynie, na `127.0.0.1:8788`, z **sanityzowaną** kopią produkcji: prawdziwy kształt danych, żadnych działających haseł, sesji, tokenów ani notatek.

Odświeża się przy każdym wdrożeniu. Żeby go obejrzeć:

```bash
gcloud compute ssh stock-dashboard --zone us-central1-a --tunnel-through-iap \
  -- -L 8788:127.0.0.1:8788
# w drugim oknie / przeglądarce:
# http://127.0.0.1:8788/stock-dashboard/
# login: owner@staging.local  hasło: Staging!Haslo2026
```

Staging **nie jest wystawiony na internet** — port nasłuchuje wyłącznie na pętli zwrotnej, dostęp idzie przez tunel IAP.

## Wersjonowanie i cofanie

Wersja aplikacji siedzi w `src/config.mjs` (`version`). Podbijaj ją przy zmianach widocznych dla użytkownika — `/api/v1/health` ją zwraca, więc od razu widać, co stoi na produkcji.

Cofnięcie ostatniego wdrożenia bez czekania na CI:

```bash
gcloud compute ssh stock-dashboard --zone us-central1-a --tunnel-through-iap --command '
  sudo rsync -a --delete /opt/stock-dashboard.old/ /opt/stock-dashboard/
  sudo systemctl restart stock-dashboard
  sleep 3 && curl -s http://127.0.0.1:8787/stock-dashboard/api/v1/health
'
```

Cofnięcie przez git (uruchomi pełny pipeline):

```bash
git revert <sha>
git push
```

**Uwaga:** `git revert` cofa kod, ale **nie cofa migracji bazy**. Jeśli wydanie dodało migrację, wersja schematu zostaje. Dlatego migracje muszą być wstecznie zgodne — stary kod ma działać na nowym schemacie. To kolejny powód, dla którego nie usuwamy kolumn.

## Zasady, które warto zachować

1. **Zero zależności npm.** Cała aplikacja stoi na module standardowym Node. To eliminuje łańcuch dostaw jako wektor ataku i sprawia, że projekt da się uruchomić za pięć lat.
2. **Każdy dostęp do danych portfela przez `requirePortfolio(userId, portfolioId)`.** Cudzy zasób zwraca `404`, nie `403`.
3. **Frontend nie wstawia danych przez `innerHTML`.**
4. **Sekrety nie trafiają do repozytorium.** `.env`, bazy i cache są w `.gitignore`; CI dodatkowo to sprawdza.
5. **`error.code` jest stabilny**, treść komunikatu nie — teksty są tłumaczone po kodzie.
