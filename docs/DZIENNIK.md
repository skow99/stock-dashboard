# Dziennik decyzji i awarii

Zapis tego, **dlaczego** projekt wygląda tak, jak wygląda. Kod mówi, co robi; ten plik mówi, czego próbowaliśmy wcześniej i dlaczego to nie zadziałało.

Każdy wpis to prawdziwa awaria albo prawdziwa decyzja, nie hipoteza.

---

## Decyzje fundamentalne

### Zero zależności npm

Cała aplikacja stoi na module standardowym Node (`node:sqlite`, `node:crypto`, `node:http`). Eliminuje to łańcuch dostaw jako wektor ataku i sprawia, że projekt da się uruchomić za pięć lat bez archeologii.

Konsekwencja: parser CSV, hashowanie haseł, wykresy SVG i klient HTTP są napisane ręcznie. To świadomy koszt.

### Każdy dostęp do danych przez `requirePortfolio(userId, portfolioId)`

Jedna bramka, nie rozsiane sprawdzenia. Cudzy zasób zwraca **404, nie 403** — 403 potwierdzałby, że dany identyfikator istnieje.

### `error.code` jest stabilny, treść komunikatu nie

Klient tłumaczy po kodzie. Dzięki temu zmiana tekstu nigdy nie psuje logiki, a katalogi PL/EN muszą mieć identyczne klucze — pilnuje tego test.

### Historia i widok bieżący liczone JEDNYM silnikiem

`replayLedger` obsługuje oba. Gdyby były dwie implementacje arytmetyki, wykres miałby uskok dokładnie w dniu dzisiejszym — tam, gdzie użytkownik patrzy najczęściej. Test sprawdza zgodność co do grosza.

### Cache notowań i kursów jest wspólny dla całej instancji

Ceny to dane publiczne. Odtworzenie dziesięciu lat dla pięciu spółek to pięć zapytań, nie kilkanaście tysięcy. Drugi portfel z tą samą spółką nie rusza sieci wcale.

---

## Awarie wdrożeniowe

Wszystkie miały jedną wspólną przyczynę: **konfiguracja pisana dla środowisk, których nie dało się uruchomić lokalnie**. Kod aplikacji, który dało się wykonać, przechodził testy od początku.

### Prawa katalogu projektu (700) blokowały usługę

`Changing to the requested working directory failed: Permission denied`

`rsync -a src/ dest/` przenosi prawa katalogu źródłowego na docelowy. Katalog projektu miał 700, więc `sdapp` nie mógł wejść do `/opt/stock-dashboard`.

**Poprawka:** `tar --mode='u+rwX,go=rX'` przy pakowaniu i jawna normalizacja praw po każdym `rsync`.

### Token sesji w logu Caddy

Filtr usuwał nagłówki żądania, ale `Set-Cookie` w **odpowiedzi** przechodził. Wykryte przez uruchomienie prawdziwego Caddy przed aplikacją, nie przez czytanie konfiguracji.

**Poprawka:** `resp_headers>Set-Cookie delete`.

### Caddy nie wstawał: `/var/log/caddy` nie istnieje

Caddy działa jako użytkownik `caddy`, pakiet Debiana nie tworzy katalogu logów, a `MkdirAll` w `/var/log` należącym do roota daje EACCES.

**Poprawka:** logi do journala (`output stderr`) zamiast do pliku.

### `iam.serviceAccounts.actAs` — brakująca rola

`setup-cicd.sh` nadawał trzy role projektowe, ale nie `roles/iam.serviceAccountUser` **na koncie usługowym maszyny**. Bez tego `gcloud compute ssh` odmawia.

Uwaga diagnostyczna: powiązanie na zasobie konta usługowego **nie pojawia się** w polityce projektu. `gcloud projects get-iam-policy` go nie pokaże — trzeba `gcloud iam service-accounts get-iam-policy`.

### `gcloud compute scp` przez tunel IAP zawiesza się

Kod wyjścia 124 (własny `timeout`) przy paczce 164 kB — to wyklucza przepustowość.

**Przyczyna:** od OpenSSH 9.0 `scp` przesyła dane podsystemem SFTP, a ten przez tunel IAP potrafi zawisnąć bez komunikatu. Runner GitHuba ma OpenSSH 9.6.

**Poprawka:** plik idzie strumieniem przez zwykłe `ssh --command='cat > plik'` z flagą `-T` (bez niej pseudoterminal przerobi końce linii i paczka dotrze uszkodzona). Sumy kontrolne po obu stronach.

### `Permission denied (publickey)` mimo poprawnych uprawnień

Sonda połączenia przechodziła, a przesył zaraz potem nie. Różnica: sonda miała sześć prób, przesył jedną.

**Przyczyna:** OS Login rozpropagowuje klucz konta usługowego z opóźnieniem i bez gwarancji.

**Poprawka:** `deploy/gcp/ci-ssh.sh` — jedno miejsce, jedno ponawianie, rozróżnienie błędu przejściowego od trwałego. Kroki **wydania** mają `CI_SSH_PROBY=1` celowo: ponowienie przerwanego `release.sh` nadpisałoby `/opt/stock-dashboard.old` nowym kodem i skasowało wersję do rollbacku.

### Trzy razy ta sama klasa błędu: katalog roota, proces `sdapp`

1. `sanitize-db.mjs` nie mógł zapisać do `/var/lib/stock-dashboard-staging` — `chown` był **po** sanityzacji zamiast przed
2. `config.mjs` przy imporcie zakłada katalog `data` obok kodu; kod należy do roota z prawami 755
3. `mktemp -d` daje 700, a próba generalna migracji biegnie jako `sdapp` → `Cannot find module`, mimo że plik leży na miejscu

**Poprawka systemowa:** `tests/deploy-scripts.test.mjs` wymaga jawnego `SD_DATA_DIR` przy każdym `sudo -u sdapp node` i jawnych praw dla każdego katalogu `mktemp`, z którego coś biegnie jako `sdapp`. Test rozwiązuje zmienne pochodne (`NEW_CODE="$TMP/..."`), bo właśnie tędy `sdapp` tam trafiał.

### Weryfikacja sumy zabijała krok mimo udanego przesyłu

Przy `set -euo pipefail` nieudany `grep` w podstawieniu `$(...)` przerywa cały krok, **zanim** wykona się własny komunikat diagnostyczny. W logu zostawał sam kod wyjścia.

**Poprawka:** `|| true` przy odczycie i osobna diagnoza dla „brak sumy" oraz „suma się nie zgadza".

### Testy przechodziły lokalnie, padały w CI

CI ustawia `SD_OFFLINE=1`. W tym trybie `fetchText` zwraca `null` **zanim** dojdzie do podstawionego `fetch` — mocki nigdy się nie wykonywały.

**Poprawka systemowa:** `scripts/check.sh` — jedno polecenie z kompletem kontroli, które **workflow wywołuje**, zamiast powtarzać jego treść. Rozjazd „u mnie przechodzi" przestaje być możliwy.

---

## Awarie danych rynkowych

### Stooq przestał być użyteczny dla serwera

- `/q/l/` → **404** z błędem ich własnej bazy (`mysqli_query()... null given`)
- `/q/d/l/` → **200**, ale treść to strona antybotowa: „This site requires JavaScript to verify your browser" plus zagadka proof-of-work

Serwer bez silnika JavaScript tego nie przejdzie. To nie awaria przejściowa.

**Poprawka:** Yahoo jako źródło pierwsze, Stooq jako zapas na wypadek powrotu.

Trzy usterki towarzyszące:

1. **Odpowiedź 200 liczyła się jako sukces** niezależnie od treści. Strona antybotowa zerowała licznik bezpiecznika, więc ten nigdy się nie otwierał i martwe źródło było odpytywane bez końca.
2. **Powód awarii szedł na `log.debug`**, a produkcja działa na `info` — w journalu nie było śladu.
3. **Komunikat straszył** mimo poprawnych danych z zapasowego źródła. Teraz pojawia się tylko, gdy realnie brakuje świeżych notowań.

Czwarta, subtelna: pole `source` w `holdings_baseline` ma domyślną wartość `'stooq'` **wpisywaną automatycznie**, nie wybraną przez użytkownika. Sterowało kolejnością źródeł, więc każdy portfel startował od martwego Stooq.

### Kursy walut leciały po stałej zaszytej w kodzie

`fx.mjs` pobierał je ze Stooq. Po jego awarii kursy po cichu spadały do `FX_FALLBACK` — pozycje w USD były przeliczane po **3,57 zamiast 3,69**, czyli ~3% błędu na całej ekspozycji dolarowej.

### Yahoo przy `range=max` oddaje dane MIESIĘCZNE

Mimo `interval=1d`. 320 punktów na 26 lat zamiast dziennych — odtwarzanie historii miało przez to dziury po kilkanaście dni.

**Poprawka:** jawny `period1`/`period2` daje prawdziwe notowania dzienne (6849 punktów).

### Polskie indeksy nie mają historii dziennej u żadnego dostawcy

- `^WIG20` → zero punktów
- `WIG20.WA` → jeden punkt (dzisiejsza wartość)
- archiwum GPW → scraper wyciągał 6 dopasowań z 75 kB strony

**Poprawka:** notowania funduszy odwzorowujących indeksy (`ETFBW20TR.WA`, `ETFBM40TR.WA`) — 1927 i 1754 punkty dzienne w PLN. Świadome przybliżenie, legenda mówi o nim wprost. W zamian wariant total return, czyli porównywalny z TWR portfela.

Scraper GPW wymaga teraz **serii, nie okruchów** (min. 30 punktów). Kilka przypadkowych liczb na wykresie jest gorsze niż pusty wykres, bo wygląda wiarygodnie.

---

## Awarie logiki aplikacji

### Historia nie kasowała starych dni

Przeliczanie **nadpisywało** wiersze, ale nigdy ich nie **usuwało**. Wystarczyło poprawić datę wpisaną omyłkowo (2003 zamiast 2026), żeby dwadzieścia lat pustego wykresu zostało w bazie i ścisnęło prawdziwe dane do płaskiej linii przy zerze.

**Poprawka:** zapis czyści historię portfela i wpisuje policzoną na nowo — w jednej transakcji.

Druga połowa: **żadna ręczna zmiana w księdze nie uruchamiała przeliczenia** — automat działał wyłącznie po imporcie. Teraz wszystkie sześć operacji na transakcjach i przepływach odświeża historię.

Trzecia, wykryta przez test: limit 20 lat obcinał **koniec** zakresu, więc omyłka z 2003 skasowałaby z wykresu ostatnie trzy lata. Obcinany jest początek.

### Brak historii TWR kasował też benchmarki

`renderIndexChart` kończył się przed załadowaniem indeksów, gdy portfel nie miał serii. Jedno zgłoszenie („nie ma historii") tłumaczyło drugie („nie ma indeksów").

### Mapa symboli zduplikowana w przeglądarce

`app.js` miał własną kopię i rozjechała się z backendem — frontend prosił o `^WIG20`, pod którym Yahoo ma zero punktów. Definicje idą teraz z `/benchmarks`.

### Znacznik czasu ma rozdzielczość milisekundy

Pierwsza wersja cofania importu rozpoznawała ręcznie edytowany wiersz po `updated_at != created_at`. Edycja w tej samej milisekundzie co import była nie do odróżnienia od jej braku.

**Poprawka:** ręczna edycja **odpina** wiersz od wsadu (`import_batch_id = NULL`). Mechanizm niezależny od zegara.

---

## Reguły importu, które wynikły z realnych plików

### Separator dziesiętny ustalany dla CAŁEJ kolumny

`1,234` w izolacji jest nierozstrzygalne. Jeśli gdziekolwiek w tej kolumnie stoi `12,5`, przecinek jest dziesiętny. To samo z `03/04/2026`: jeśli gdzieś pierwsza liczba przekracza 12, cały plik czytany jest po europejsku.

### Duplikaty liczone wyłącznie względem stanu SPRZED importu

Dwa identyczne zlecenia z tego samego dnia w jednym pliku to dwie prawdziwe transakcje i obie wchodzą. Ten sam plik wgrany drugi raz nie dodaje niczego.

### Profile brokerskie nie są warunkiem powodzenia

XTB i IBKR to dodatkowe aliasy plus transformacje (IBKR koduje stronę znakiem ilości). Przy niezgodności nagłówków plik przechodzi przez aliasy ogólne albo mapowanie ręczne. **Profile powstały z dokumentacji formatów, nie ze sprawdzenia na prawdziwych plikach** — to jedyny nieprzetestowany empirycznie element importu.

---

## Wnioski metodologiczne

1. **`gh run view --log-failed` zamiast `gh run watch`.** `watch` mówi *który* krok padł, `--log-failed` mówi *dlaczego*. Trzy rundy zgadywania kontra jedno podejście.
2. **Odtwarzać awarię lokalnie, zanim się ją naprawi.** Każda poprawka w tym dzienniku, która wyszła za pierwszym razem, była poprzedzona odtworzeniem objawu.
3. **Jedno źródło prawdy albo rozjazd.** Mapa symboli, komplet kontroli CI, arytmetyka portfela — wszędzie tam, gdzie były dwie kopie, rozjechały się.
4. **Test mutacyjny na własnych testach.** Po napisaniu testu przywrócić błąd i sprawdzić, czy się zapala. Kilka razy okazało się, że test przechodziłby zawsze.
5. **Bramka, która zatrzymuje wydanie, jest sukcesem, nie porażką.** „Proba generalna migracji NIE POWIODLA SIE. Produkcja nietknieta." to komunikat o działającym mechanizmie.
