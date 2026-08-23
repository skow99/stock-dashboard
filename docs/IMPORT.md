# Import danych z pliku

Zakładka **Import** w panelu przyjmuje pliki CSV z trzema rodzajami danych. Nie musisz wybierać rodzaju z listy — aplikacja rozpoznaje go po nagłówku.

Zanim cokolwiek trafi do bazy, zobaczysz podgląd: ile wierszy wejdzie, ile jest duplikatami, które zostały odrzucone i dlaczego.

---

## Trzy kształty pliku

### 1. Transakcje

```csv
data;ticker;strona;ilosc;cena;prowizja;waluta;nazwa;notatka
2026-01-15;AAPL.US;BUY;10;185,50;1,20;USD;Apple Inc;
2026-03-02;CDR.WA;SELL;50;142,00;3,50;PLN;CD Projekt;realizacja zysku
```

Wymagane: `data`, `ticker`, `strona`, `ilosc`, `cena`. Reszta opcjonalna.

### 2. Przepływy pieniężne

```csv
data;typ;kwota;waluta;ticker;notatka
2026-01-02;Wplata;10000;PLN;;przelew z konta
2026-02-14;Dywidenda;23,40;USD;AAPL.US;dywidenda kwartalna
2026-02-14;Podatek;3,51;USD;AAPL.US;podatek u zrodla
```

Wymagane: `data`, `typ`, `kwota`.

Rodzaje operacji: `Wpłata`, `Wypłata`, `Dywidenda`, `Odsetki`, `Prowizja`, `Podatek` (albo `Deposit`, `Withdrawal`, `Dividend`, `Interest`, `Fee`, `Tax`).

**Znak podajesz jak chcesz.** Wypłaty, prowizje i podatki zapisują się jako ujemne niezależnie od tego, czy wpiszesz `500` czy `-500`.

### 3. Stan portfela

Dla sytuacji, gdy nie masz historii transakcji, tylko bieżące pozycje.

```csv
ticker;ilosc;cena_srednia;waluta;nazwa
AAPL.US;10;185,50;USD;Apple Inc
```

Wymagane: `ticker`, `ilosc`.

Ten rodzaj działa jako **nadpisanie**: druga wgrana pozycja tego samego waloru zastępuje poprzednią, nie dokłada się do niej. Dlatego jako jedyny **nie da się go cofnąć** — poprzednich wartości już nie ma.

---

## Czego plik nie musi spełniać

Formatów jest tyle, ile banków i brokerów, więc parser toleruje:

| Element | Co przyjmuje |
|---|---|
| Separator kolumn | `;` `,` tabulator `|` — wykrywany po tym, który daje równą liczbę kolumn |
| Liczby | `1234.56`, `1234,56`, `1 234,56`, `1'234.56`, `(1 234,56)` = −1234,56 |
| Waluta w komórce | `185,50 zł`, `$185.50` — symbol jest odcinany |
| Daty | `2026-01-15`, `15.01.2026`, `15/01/2026`, `20260115`, `2026-01-15 10:30:00` |
| Kodowanie | UTF‑8, UTF‑8 z BOM, UTF‑16, Windows‑1250 (domyślne w polskim Excelu) |
| Nagłówki | polskie i angielskie: `ilosc`/`quantity`/`shares`, `strona`/`side`/`buysell` |
| Strona | `BUY`/`Kupno`/`K`/`B`, `SELL`/`Sprzedaż`/`S` |
| Cudzysłowy | zgodnie z RFC 4180 — przecinek i znak nowej linii mogą być wewnątrz pola |

### Skąd wiadomo, czy `1,234` to tysiąc czy jeden i ćwierć

Z **całej kolumny**, nie z pojedynczej komórki. Jeśli gdziekolwiek w kolumnie stoi wartość, gdzie po separatorze jest liczba cyfr różna od trzech (`12,5`), separator jest dziesiętny. Jeśli separator się powtarza (`1.234.567`), grupuje tysiące. Przy pełnej niejednoznaczności przyjmowany jest zapis polski — przecinek dziesiętny.

To samo dotyczy `03/04/2026`: jeśli gdziekolwiek w kolumnie pierwsza liczba przekracza 12, cały plik czytany jest jako dzień/miesiąc.

Wykryty separator i kodowanie widać w podglądzie. Jeśli automat się pomyli, poprawisz to ręcznie.

---

## Profile brokerskie

Nagłówki eksportów z **XTB** i **Interactive Brokers** są rozpoznawane dodatkowo, razem z ich osobliwościami:

- **IBKR** nie ma kolumny „strona" — koduje ją znakiem ilości. `-10` staje się sprzedażą 10 sztuk. Prowizja przychodzi ujemna i jest odwracana.
- **XTB** trzyma w kolumnie `Typ` zarówno stronę transakcji, jak i rodzaj operacji gotówkowej. Są rozdzielane.

**Te profile powstały z dokumentacji formatów, nie ze sprawdzenia na prawdziwych plikach z tych kont.** Jeśli nagłówki się nie zgodzą, nic się nie psuje: plik przejdzie przez ogólne aliasy, a w ostateczności przypiszesz kolumny ręcznie. Profil jest ułatwieniem, nigdy warunkiem powodzenia.

Gdy prześlesz mi prawdziwy plik z eksportu, dostroję profil i dopiszę do niego test.

---

## Duplikaty

Duplikat to wiersz zgodny z **istniejącym już w bazie** co do daty, tickera, strony, ilości i ceny (dla przepływów: daty, rodzaju, kwoty i waluty).

Kluczowa właściwość: duplikaty liczą się wyłącznie względem stanu **sprzed** importu. Dwa identyczne zlecenia z tego samego dnia w jednym pliku to dwie prawdziwe transakcje i obie wejdą. Ten sam plik wgrany po raz drugi nie doda niczego.

Gdy naprawdę potrzebujesz wpisać coś, co wygląda na duplikat, zaznacz **Wpisz także duplikaty** w podglądzie.

---

## Cofanie

Każdy import transakcji i przepływów dostaje identyfikator wsadu i można go cofnąć jednym kliknięciem w **Historii importów**.

Jeden wyjątek, celowy: **wiersz poprawiony ręcznie po imporcie przestaje należeć do wsadu**. Cofnięcie go nie usunie. Twoja poprawka jest wartościowsza niż porządek po pliku — a bez tego jedno kliknięcie kasowałoby pracę, o której już zapomniałeś.

Podsumowanie po cofnięciu pokazuje, ile wierszy usunięto i ile zostawiono.

---

## Historia wykresu po imporcie transakcji z przeszłości

Zaimportowanie transakcji sprzed lat samo w sobie nie tworzy wykresu wartości — ten powstawał dotąd wyłącznie z migawek zapisywanych po zamknięciu sesji, więc zaczynał się w dniu uruchomienia systemu.

Po każdym imporcie transakcji lub przepływów historia jest więc **odtwarzana wstecz automatycznie**: od pierwszego zdarzenia do dziś, dzień po dniu. Pozycje biorą się z księgi transakcji, a wycena z notowań i kursów walut obowiązujących **w tamtym dniu** — nie z dzisiejszych.

W zakładce Import jest też przycisk **Przelicz historię**, przydatny po ręcznej edycji transakcji.

| | |
|---|---|
| Dni bez sesji (weekendy, święta) | ostatnie znane zamknięcie |
| Dni przed pierwszym notowaniem instrumentu | pomijane — żadna cena nie byłaby prawdziwa |
| Kursy walut | historyczne, dzień po dniu |
| Zapytania do źródeł | jedno na ticker, potem cache wspólny dla całej instancji |

Odtworzenie dziesięciu lat dla pięciu spółek to pięć zapytań, nie kilkanaście tysięcy. Cache notowań i kursów jest wspólny dla wszystkich użytkowników i portfeli — to dane publiczne, więc drugi portfel z tą samą spółką nie rusza sieci w ogóle.

Z konsoli, dla wszystkich portfeli naraz:

```bash
node scripts/admin.mjs rebuild-history            # cala instancja
node scripts/admin.mjs rebuild-history a@b.pl     # portfele jednego konta
```

## Limity

| | |
|---|---|
| Wierszy na jeden import | 5000 |
| Rozmiar pliku | 3 MB |

Limit wierszy chroni maszynę — dashboard stoi na instancji z 1 GB pamięci. Większą historię podziel na części; duplikaty i tak nie pozwolą jej się zdublować na styku plików.

---

## Wzorce

W panelu, pod polem wyboru pliku, są linki do gotowych wzorców CSV w języku interfejsu. Warto od nich zacząć — otwierają się w Excelu poprawnie i przechodzą przez import bez zmian (pilnuje tego test).

---

## Dla rozwijających projekt

| Plik | Odpowiada za |
|---|---|
| `src/import/csv.mjs` | dekodowanie bajtów, separator, parser RFC 4180, liczby, daty |
| `src/import/schema.mjs` | aliasy nagłówków, kształty rekordów, profile brokerskie |
| `src/import/engine.mjs` | plan importu, deduplikacja, zapis, cofanie |
| `src/import/template.mjs` | wzorce do pobrania |
| `src/routes/import.mjs` | `analyze`, `commit`, `batches`, `template` |
| `public/import.js` | zakładka w panelu |

Podgląd i zapis liczą plan **tą samą funkcją** (`buildPlan`) na podstawie identycznego ciała żądania. Serwer nie trzyma stanu między jednym a drugim, więc nie ma sesji importu, która mogłaby wygasnąć albo rozjechać się z tym, co użytkownik widział na ekranie.

Dodając nowy alias nagłówka albo profil, dopisz test w `tests/import.test.mjs` — najlepiej z prawdziwym wierszem z pliku, który go wymusił.
