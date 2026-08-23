# Wdrożenie na Google Cloud — free tier

Dashboard na darmowej maszynie `e2-micro`, z publicznym adresem HTTPS i **bez własnej domeny**.

---

## Co dostaniesz

| | |
|---|---|
| **Adres** | `https://<IP-z-myślnikami>.sslip.io/stock-dashboard/` — np. `https://34-16-22-9.sslip.io/stock-dashboard/` |
| **Certyfikat** | prawdziwy Let's Encrypt, odnawiany automatycznie przez Caddy |
| **Maszyna** | `e2-micro`, Debian 12, dysk 30 GB `pd-standard` |
| **Koszt** | 0 zł w granicach free tier (patrz „Koszty" niżej) |
| **Dostęp SSH** | wyłącznie przez Google IAP — port 22 **nie jest** wystawiony na internet |
| **Konto** | właściciel zakładany automatycznie, hasło pokazane raz podczas instalacji |

Bez domeny wykorzystujemy **sslip.io**: nazwa `34-16-22-9.sslip.io` rozwiązuje się na adres `34.16.22.9`. Domena jest na Public Suffix List, więc Let's Encrypt wystawia dla niej normalny certyfikat — to nie jest obejście ani self-signed.

---

## Zanim zaczniesz

1. **Konto Google Cloud z włączonym rozliczeniem.** Free tier wymaga podpiętej karty, mimo że nic nie płacisz. Bez rozliczenia nie utworzysz maszyny.
2. **`gcloud` CLI** — albo lokalnie ([instalacja](https://cloud.google.com/sdk/docs/install)), albo po prostu otwórz **Cloud Shell** w konsoli GCP (ma `gcloud` gotowe).
3. **Projekt GCP**:

```bash
gcloud auth login
gcloud projects create portfel-dashboard --name="Portfel"     # albo użyj istniejącego
gcloud config set project portfel-dashboard
# Podepnij konto rozliczeniowe w konsoli: Billing -> Link a billing account
```

---

## Wdrożenie

Rozpakuj `master-portfolio-dashboard-v2.zip`, wejdź do katalogu `stock-dashboard` i uruchom:

```bash
bash deploy/gcp/deploy.sh
```

Skrypt zapyta o adres e-mail konta właściciela i dalej zrobi wszystko sam:

1. włączy potrzebne API (Compute Engine, IAP),
2. utworzy reguły firewalla — 80/443 z internetu, SSH **tylko** z zakresu IAP,
3. utworzy maszynę `e2-micro` z dyskiem `pd-standard` (jedyna darmowa kombinacja),
4. wyśle kod i uruchomi instalację: Node.js 22, Caddy, systemd, automatyczne poprawki bezpieczeństwa,
5. założy konto właściciela i **wypisze hasło — zapisz je od razu**,
6. sprawdzi, czy serwis odpowiada publicznie, i poda adres.

Całość trwa zwykle 3–6 minut. Certyfikat Let's Encrypt potrafi dojść jeszcze minutę po zakończeniu skryptu.

### Jeśli chcesz inny region albo własną domenę

```bash
ZONE=us-west1-b bash deploy/gcp/deploy.sh                       # Oregon zamiast Iowa
PUBLIC_HOST=portfel.mojadomena.pl bash deploy/gcp/deploy.sh     # własna domena (najpierw rekord A na IP maszyny)
```

---

## Codzienna obsługa

```bash
# Stan i logi
gcloud compute ssh stock-dashboard --zone us-central1-a --tunnel-through-iap \
  --command 'sudo systemctl status stock-dashboard --no-pager'
gcloud compute ssh stock-dashboard --zone us-central1-a --tunnel-through-iap \
  --command 'sudo journalctl -u stock-dashboard -n 100 --no-pager' | jq -r 'select(.level=="error")'

# Nowa wersja kodu (z testami przed wysyłką, kopia bazy, możliwość cofnięcia)
bash deploy/gcp/update.sh

# Kopia bazy na Twój komputer
bash deploy/gcp/backup-pull.sh ~/kopie-portfela

# Zatrzymanie maszyny (przestaje zużywać godziny free tier)
gcloud compute instances stop stock-dashboard --zone us-central1-a
gcloud compute instances start stock-dashboard --zone us-central1-a

# Usunięcie wszystkiego
bash deploy/gcp/destroy.sh
```

**Uwaga po restarcie maszyny:** adres IP jest efemeryczny, więc po `stop` + `start` zmienia się, a razem z nim nazwa `sslip.io`. Wtedy uruchom ponownie `bash deploy/gcp/deploy.sh` — wykryje istniejącą maszynę, tylko zaktualizuje nazwę hosta i certyfikat. Jeśli chcesz stały adres, zarezerwuj statyczne IP (patrz niżej).

---

## Migracja Twoich danych z v1

```bash
# 1. Wyślij katalog data/ ze starej instalacji
gcloud compute scp --recurse ~/stare-dane/data stock-dashboard:~/v1data \
  --zone us-central1-a --tunnel-through-iap

# 2. Podgląd bez zapisu
gcloud compute ssh stock-dashboard --zone us-central1-a --tunnel-through-iap --command \
  'sudo -u sdapp env $(sudo cat /etc/stock-dashboard.env | grep -v "^#" | xargs) \
   node /opt/stock-dashboard/scripts/migrate-v1.mjs --from ~/v1data --email TWOJ@EMAIL --dry-run'

# 3. Właściwa migracja — usuń --dry-run
```

---

## Koszty — na co uważać

Free tier Compute Engine obejmuje **1 maszynę `e2-micro` miesięcznie** w `us-west1`, `us-central1` lub `us-east1`, **30 GB dysku standard** i **1 GB ruchu wychodzącego** na miesiąc. Zewnętrzny adres IP dla maszyny w free tier też jest darmowy.

Rzeczy, które **wychodzą poza darmowy limit**:

| Pułapka | Skutek | Jak uniknąć |
|---|---|---|
| Region inny niż us-west1 / us-central1 / us-east1 | pełna cena maszyny | `deploy.sh` ostrzega i pyta o potwierdzenie |
| Dysk `pd-balanced` lub `pd-ssd` | płatny | skrypt wymusza `pd-standard` |
| Druga maszyna `e2-micro` | limit to suma godzin, nie liczba maszyn | trzymaj jedną |
| Ponad 1 GB egress/miesiąc | ~0,12 USD/GB | dashboard dla jednej osoby zużywa rzędu megabajtów |
| Statyczne IP **nieprzypięte** do działającej maszyny | ~0,005 USD/h | jeśli rezerwujesz IP, trzymaj je przypięte |

Ustaw budżet z alertem — to najtańsze ubezpieczenie:

```bash
# Konsola: Billing -> Budgets & alerts -> Create budget -> próg np. 5 PLN
```

Region `us-central1` oznacza ~120–140 ms opóźnienia z Polski. Dla dashboardu bez znaczenia, dla świadomości — warto wiedzieć.

### Stały adres (opcjonalnie)

```bash
gcloud compute addresses create stock-dashboard-ip --region us-central1
gcloud compute instances delete-access-config stock-dashboard --zone us-central1-a --access-config-name "external-nat"
gcloud compute instances add-access-config stock-dashboard --zone us-central1-a \
  --access-config-name "external-nat" --address stock-dashboard-ip
bash deploy/gcp/deploy.sh   # odświeży nazwę hosta i certyfikat
```

---

## Bezpieczeństwo — co warto wiedzieć

Wystawiasz dashboard finansowy publicznie. Instalator ustawia to, co powinno być ustawione:

- **Konto właściciela powstaje w trakcie instalacji**, zanim adres stanie się osiągalny. Bez tego pierwsza osoba, która trafiłaby na URL, mogłaby przejąć konto właściciela — aplikacja oddaje rolę `owner` pierwszemu rejestrującemu się użytkownikowi.
- **Hasło właściciela** jest losowe (20+ znaków), pokazane raz, a potem usunięte z pliku `/etc/stock-dashboard.env`.
- **Rejestracja tylko na zaproszenie** (`SD_OPEN_REGISTRATION=0`). Nowe konta zakładasz kodem z panelu administracyjnego.
- **SSH tylko przez IAP** — port 22 nie odpowiada z internetu, nie ma czego skanować.
- **Aplikacja słucha na 127.0.0.1**, na świat wychodzi wyłącznie Caddy.
- **Ciasteczko sesji**: `HttpOnly`, `Secure`, `SameSite=Lax`; w bazie tylko SHA-256 tokenu.
- **Log Caddy nie zapisuje sekretów** — nagłówki `Cookie`, `Authorization`, `X-CSRF-Token` i `Set-Cookie` są odfiltrowane.
- **Automatyczne poprawki bezpieczeństwa** przez `unattended-upgrades`.
- **Blokada konta** po 8 nieudanych logowaniach na 15 minut, limit 30 prób logowania na IP na 15 minut.

Co warto zrobić samemu po wdrożeniu:

1. Zaloguj się i **zmień hasło** na własne (zakładka Konto).
2. Ustaw **budżet z alertem** w Billing.
3. Rozważ, czy publiczna dostępność jest naprawdę potrzebna. Jeśli dashboard ma być tylko dla Ciebie, **Tailscale** daje ten sam efekt bez wystawiania czegokolwiek na internet — w projekcie jest gotowy `ops/tailscale-serve.sh`.

---

## Gdy coś nie działa

| Objaw | Sprawdź |
|---|---|
| `deploy.sh` kończy się bez potwierdzenia HTTPS | `sudo journalctl -u caddy -n 50 --no-pager` — najczęściej Let's Encrypt jeszcze nie wydał certyfikatu, poczekaj 2 minuty |
| Przeglądarka: „nie można nawiązać połączenia" | czy reguła firewalla `stock-dashboard-web` istnieje i maszyna ma tag `stock-dashboard` |
| `caddy: failed`, w logu `open /var/log/caddy/access.log: permission denied` | Caddy loguje do journala od tej wersji. Jeśli masz starszy `Caddyfile` z logiem do pliku: `sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy && sudo systemctl restart caddy` |
| `502 Bad Gateway` | `sudo systemctl status stock-dashboard` — usługa nie wstała, logi powiedzą dlaczego |
| Usługa restartuje się w kółko | `sudo journalctl -u stock-dashboard -n 50` — zwykle błąd w `/etc/stock-dashboard.env` |
| „Sesja wygasła" zaraz po zalogowaniu | czy `SD_COOKIE_SECURE=1` i wchodzisz przez `https://`, a nie `http://` |
| Zapomniane hasło właściciela | `sudo -u sdapp node /opt/stock-dashboard/scripts/admin.mjs reset-password TWOJ@EMAIL` |
| Nie pamiętam adresu | `gcloud compute instances describe stock-dashboard --zone us-central1-a --format='get(networkInterfaces[0].accessConfigs[0].natIP)'` |

---

## Źródła

- [Free Tier — Compute Engine](https://cloud.google.com/free/docs/compute-getting-started)
- [Cennik adresów IPv4 w GCP](https://cloud.google.com/vpc/pricing-announce-external-ips)
- [Cennik sieci GCP](https://cloud.google.com/vpc/network-pricing)
