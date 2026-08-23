# Zmiany schematu bazy na żywym systemie

W bazie są transakcje finansowe użytkowników. Nie ma okna serwisowego, nie ma drugiej kopii, do której można się wycofać bez utraty tego, co użytkownik wpisał w międzyczasie. Ten dokument opisuje reguły, które to chronią, i mechanizmy, które ich pilnują automatycznie.

---

## Trzy reguły

### 1. Migracja raz wydana jest niezmienna

`src/db.mjs` trzyma tablicę `MIGRATIONS`. Indeks + 1 to docelowy `PRAGMA user_version`. Baza produkcyjna zapamiętuje, do której wersji doszła, i **nigdy nie wykona ponownie kroku, który już wykonała**.

Konsekwencja: poprawienie literówki w migracji nr 1 nie naprawi produkcji — tam stara wersja już się wykonała. Zmieni za to schemat u każdego, kto zainstaluje system od zera, i po cichu rozjedzie obie instalacje.

Poprawki dopisuje się **jako kolejną migrację na końcu tablicy**.

Pilnuje tego `migrations.lock.json` — suma kontrolna każdego wydanego kroku. `node scripts/migration-guard.mjs check` zatrzymuje CI, jeśli cokolwiek się zmieniło.

### 2. Nie usuwamy i nie zmieniamy nazw — wzorzec expand/contract

Zmiana kolumny to nie jeden krok, tylko trzy wydania:

| Faza | Co robisz | Stan systemu |
|---|---|---|
| **Expand** | dodajesz nową kolumnę jako `NULL`-owalną, zapisujesz do obu | stary i nowy kod działają równolegle |
| **Migrate** | uzupełniasz dane w nowej kolumnie, przełączasz odczyty | nowy kod czyta nowe, stary wciąż działa |
| **Contract** | dopiero teraz usuwasz starą kolumnę | tylko gdy masz pewność, że nic jej nie czyta |

Między fazami musi minąć co najmniej jedno wdrożenie, które przeżyje kilka dni. Fazy **contract** zwykle nigdy nie wykonujesz — nieużywana kolumna kosztuje bajty, a jej usunięcie kosztuje ryzyko.

`migration-guard.mjs` odrzuca `DROP TABLE`, `DROP COLUMN`, `RENAME`, `DELETE FROM`, `TRUNCATE` i `DROP INDEX`. Jeśli naprawdę musisz — dopisz nazwę migracji do `allowDestructive` w `migrations.lock.json` i uzasadnij w treści commita. To celowo niewygodne.

### 3. Każda migracja przechodzi próbę generalną na prawdziwych danych

Testy jednostkowe działają na danych syntetycznych i nie wykryją, że akurat w Twojej bazie jest wiersz, który łamie nowe ograniczenie `NOT NULL`.

`deploy/gcp/release.sh` przed każdym wdrożeniem produkcyjnym:

1. robi kopię zapasową,
2. kopiuje bieżącą bazę do katalogu tymczasowego,
3. uruchamia `scripts/migrate-rehearse.mjs` **nowym kodem na tej kopii**,
4. sprawdza liczby wierszy w tabelach krytycznych, `integrity_check`, `foreign_key_check` i odczyt kluczowych kolumn,
5. przerywa wdrożenie, jeśli cokolwiek nie gra — produkcja pozostaje nietknięta.

---

## Jak dodać migrację

```bash
# 1. Dopisz nowy element NA KOŃCU tablicy MIGRATIONS w src/db.mjs
#    Przykład bezpiecznej zmiany (expand):
#      ALTER TABLE transactions ADD COLUMN settlement_date TEXT;

# 2. Zarejestruj ją w blokadzie
node scripts/migration-guard.mjs update

# 3. Sprawdź, że obie ścieżki dają ten sam schemat
node --test tests/migrations.test.mjs

# 4. Próba generalna na kopii lokalnej bazy
node scripts/migrate-rehearse.mjs data/dashboard.db

# 5. Commit razem z migrations.lock.json
git add src/db.mjs migrations.lock.json
git commit -m "db: kolumna settlement_date na transakcjach (expand)"
```

## Bezpieczne i niebezpieczne zmiany

| Bezpieczne | Wymagają expand/contract | Nigdy bez bardzo dobrego powodu |
|---|---|---|
| `ADD COLUMN` z `NULL` lub `DEFAULT` | zmiana typu kolumny | `DROP TABLE` |
| `CREATE TABLE` | dodanie `NOT NULL` do istniejącej kolumny | `DROP COLUMN` |
| `CREATE INDEX` | zmiana znaczenia wartości w kolumnie | `RENAME` |
| `INSERT` danych słownikowych | rozbicie kolumny na dwie | `DELETE FROM` |

**Dodanie `NOT NULL` do istniejącej kolumny** to najczęstsza pułapka: w SQLite wymaga przepisania tabeli, a jeśli w bazie jest choć jeden `NULL`, migracja wywala się w połowie. Ścieżka bezpieczna: dodaj kolumnę z wartością domyślną → uzupełnij → dopiero w kolejnym wydaniu wymuszaj ograniczenie.

## Kiedy coś już poszło nie tak

Kopie zapasowe leżą na maszynie w `/var/lib/stock-dashboard/backups/` (14 ostatnich, codziennie o 21:30 plus jedna przed każdym wdrożeniem).

```bash
# Zatrzymaj usługę, podmień bazę, wystartuj
sudo systemctl stop stock-dashboard
sudo -u sdapp cp /var/lib/stock-dashboard/backups/dashboard-<data>.db /var/lib/stock-dashboard/dashboard.db
sudo rm -f /var/lib/stock-dashboard/dashboard.db-wal /var/lib/stock-dashboard/dashboard.db-shm
sudo systemctl start stock-dashboard
```

Uwaga: przywrócenie kopii cofa też dane wpisane po jej wykonaniu. Dlatego bramka z próbą generalną jest ważniejsza niż sama kopia.
