# Master Portfolio Dashboard v2

Prywatny dashboard portfela inwestycyjnego. Jeden proces Node.js, **zero zależności npm**, brak kroku budowania.
Nowe w v2: **konta użytkowników**, **wiele portfeli** z widokiem skonsolidowanym, **interfejs PL/EN**.

*A private investment portfolio dashboard. One Node.js process, **zero npm dependencies**, no build step.
New in v2: **user accounts**, **multiple portfolios** with a consolidated view, **Polish/English UI**.*

---

## Wymagania / Requirements

- **Node.js 22 LTS lub nowszy** (wymagane przez wbudowany moduł `node:sqlite`)
- Linux / macOS. Produkcyjnie: user-level `systemd` + Tailscale Serve.

## Szybki start / Quick start

```bash
cp .env.example .env && chmod 600 .env
node server.mjs
```

Otwórz `http://127.0.0.1:8787/stock-dashboard/`. Baza jest pusta, więc ekran logowania przejdzie w tryb
pierwszego uruchomienia i założy konto właściciela. Kolejne konta wymagają kodu zaproszenia.

*Open the URL above. With an empty database the sign-in screen switches to first-run mode and creates the owner
account. Further accounts require an invitation code.*

## Testy / Tests

```bash
node --test tests/*.test.mjs   # 40 testów jednostkowych i integracyjnych
bash tests/smoke.sh            # 65 asercji end-to-end (własny serwer, tymczasowa baza, tryb offline)
```

Testy nie dotykają danych produkcyjnych ani sieci — `smoke.sh` startuje własny serwer na porcie 8799
z `SD_OFFLINE=1` i kasuje po sobie bazę.

## Migracja z v1 / Migrating from v1

```bash
node scripts/migrate-v1.mjs --from /ścieżka/do/v1/data --email ja@example.com --dry-run
node scripts/migrate-v1.mjs --from /ścieżka/do/v1/data --email ja@example.com --portfolio "Portfel główny"
```

Migracja jest idempotentna na poziomie portfela i działa w jednej transakcji SQL.

## Administracja / Administration

```bash
node scripts/admin.mjs users                      # lista kont
node scripts/admin.mjs create-user <email> --role owner
node scripts/admin.mjs reset-password <email>
node scripts/admin.mjs invite --role user --hours 72
node scripts/admin.mjs backup                     # kopia + rotacja do 14 plików
node scripts/admin.mjs vacuum
```

## Wdrożenie / Deployment

**Google Cloud free tier** — publiczny HTTPS, bez własnej domeny, jedna komenda:

```bash
bash deploy/gcp/deploy.sh
```

Szczegóły, koszty i rozwiązywanie problemów: [`deploy/gcp/README.md`](deploy/gcp/README.md).

**Własny serwer / Raspberry Pi** (systemd + Tailscale):

```bash
bash ops/install.sh ~/apps/stock-dashboard        # systemd + timer kopii zapasowej
bash ops/tailscale-serve.sh                       # publikacja w tailnecie
systemctl --user status stock-dashboard.service --no-pager
curl -s http://127.0.0.1:8787/stock-dashboard/api/v1/health | jq
```

## Struktura / Layout

```text
server.mjs             HTTP, routing, cykl życia procesu
src/                   konfiguracja, baza, auth, i18n, dane rynkowe, arytmetyka, endpointy
public/                trzy strony (dashboard, logowanie, widok publiczny) + moduły ES
scripts/               migracja z v1, administracja, strażnik migracji, sanityzacja bazy
deploy/gcp/            wdrożenie na GCP, wydanie z rollbackiem, konfiguracja CI/CD
.github/workflows/     CI na PR, automatyczne wdrożenie z main
docs/                  zasady rozwoju, migracje, runbook awaryjny
tests/                 jednostkowe, i18n, migracje, smoke end-to-end
ops/                   systemd, backup, Tailscale
data/                  SQLite + cache rynkowy (poza repozytorium)
migrations.lock.json   sumy kontrolne wydanych migracji
```

## Rozwój / Development

| Dokument | O czym |
|---|---|
| [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) | przepływ pracy, testy, staging, cofanie zmian |
| [`docs/MIGRATIONS.md`](docs/MIGRATIONS.md) | zmiany schematu na żywym systemie, expand/contract |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | co robić, gdy coś padnie |
| [`docs/IMPORT.md`](docs/IMPORT.md) | format plików CSV do importu, profile brokerskie, cofanie |
| [`deploy/gcp/README.md`](deploy/gcp/README.md) | wdrożenie od zera, koszty, diagnostyka |

```bash
# Pełna bramka jakości — to samo uruchamia CI
node scripts/migration-guard.mjs check
node --test tests/*.test.mjs
bash tests/smoke.sh
```

Merge do `main` uruchamia testy, wydanie na staging (sanityzowana kopia produkcji),
a następnie wydanie produkcyjne z kopią zapasową, próbą generalną migracji
i automatycznym cofnięciem przy nieudanym health checku.

## Bezpieczeństwo / Security

- Hasła: `scrypt` z losową solą; sesje: token w ciasteczku `HttpOnly` + `SameSite=Lax`, w bazie tylko SHA-256.
- Zapisy chronione tokenem CSRF **oraz** kontrolą `Sec-Fetch-Site`.
- Każdy dostęp do danych portfela przechodzi przez `requirePortfolio(userId, portfolioId)`; cudzy zasób to `404`.
- Rejestracja wyłącznie na zaproszenie (`SD_OPEN_REGISTRATION=0`), blokada konta po nieudanych logowaniach.
- CSP bez `unsafe-inline`, statyki z listy dozwolonych plików, brak `innerHTML` dla danych.
- **Sekrety nigdy nie trafiają do repozytorium.** `.env` → `600`, `data/` → `700`.

## Język / Language

Interfejs działa po polsku i po angielsku; przełącznik `PL | EN` jest w nagłówku.
API negocjuje język przez `Accept-Language` albo `?lang=pl|en`, a `error.code` pozostaje niezmienny.

*The UI runs in Polish and English; the `PL | EN` switch sits in the header.
The API negotiates language via `Accept-Language` or `?lang=pl|en`, while `error.code` stays stable.*

## Pełna specyfikacja / Full specification

`master-portfolio-dashboard-v2-spec.md` — 33 sekcje: model danych, model bezpieczeństwa, referencja API,
reguły biznesowe, migracja, testy i lista kontrolna odtworzenia od zera.
