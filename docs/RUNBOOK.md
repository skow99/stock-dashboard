# Runbook — co robić, gdy coś padnie

Wszystkie polecenia zakładają maszynę `stock-dashboard` w strefie `us-central1-a`.
Skrót do połączenia:

```bash
alias vm='gcloud compute ssh stock-dashboard --zone us-central1-a --tunnel-through-iap'
```

---

## Najpierw: co jest zepsute

```bash
vm --command '
  echo "== usługi";      sudo systemctl is-active stock-dashboard caddy stock-dashboard-staging 2>&1
  echo "== aplikacja";   curl -s http://127.0.0.1:8787/stock-dashboard/api/v1/health || echo "brak odpowiedzi"
  echo "== port 443";    sudo ss -ltn | grep ":443 " || echo "brak nasłuchu"
  echo "== dysk";        df -h / | tail -1
  echo "== pamięć";      free -m | head -2
'
```

| Objaw | Prawdopodobna przyczyna | Sekcja |
|---|---|---|
| `stock-dashboard: failed` | błąd w kodzie lub konfiguracji | [Aplikacja nie wstaje](#aplikacja-nie-wstaje) |
| `caddy: failed` | błąd w `Caddyfile` lub prawa do plików | [Caddy nie wstaje](#caddy-nie-wstaje) |
| `502 Bad Gateway` | Caddy działa, aplikacja nie | [Aplikacja nie wstaje](#aplikacja-nie-wstaje) |
| Wdrożenie cofnęło się samo | health check nie przeszedł | [Wdrożenie odrzucone](#wdrożenie-odrzucone) |
| Dane wyglądają źle | nieudana migracja albo błąd w kodzie | [Przywrócenie bazy](#przywrócenie-bazy) |
| Brak miejsca na dysku | kopie zapasowe albo journal | [Dysk pełny](#dysk-pełny) |

---

## Aplikacja nie wstaje

```bash
vm --command 'sudo journalctl -u stock-dashboard -n 60 --no-pager'
```

Najczęstsze przyczyny:

| W logu | Co zrobić |
|---|---|
| `Changing to the requested working directory failed` | prawa do `/opt/stock-dashboard` — patrz niżej |
| `SQLITE_CANTOPEN` | prawa do `/var/lib/stock-dashboard` |
| `Migracja N nie powiodla sie` | [Przywrócenie bazy](#przywrócenie-bazy) |
| `EADDRINUSE` | inny proces trzyma port 8787 |

```bash
# Naprawa praw (bezpieczna, idempotentna)
vm --command '
  sudo chown -R root:root /opt/stock-dashboard
  sudo chmod 755 /opt/stock-dashboard
  sudo find /opt/stock-dashboard -type d -exec chmod 755 {} +
  sudo find /opt/stock-dashboard -type f -exec chmod 644 {} +
  sudo chown -R sdapp:sdapp /var/lib/stock-dashboard
  sudo chmod 700 /var/lib/stock-dashboard
  sudo systemctl restart stock-dashboard
  sleep 3 && sudo systemctl is-active stock-dashboard
'
```

Jeśli to nie pomogło — cofnij do poprzedniej wersji:

```bash
vm --command '
  sudo rsync -a --delete /opt/stock-dashboard.old/ /opt/stock-dashboard/
  sudo systemctl restart stock-dashboard
  sleep 3 && curl -s http://127.0.0.1:8787/stock-dashboard/api/v1/health
'
```

## Caddy nie wstaje

```bash
vm --command 'sudo journalctl -u caddy -n 40 --no-pager'
```

| W logu | Co zrobić |
|---|---|
| `open /var/log/caddy/access.log: permission denied` | `sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy` — albo przełącz log na `output stderr` |
| `could not get certificate` | sprawdź, czy port 80 jest otwarty w firewallu i czy nazwa hosta wskazuje na aktualne IP |
| `address already in use` | `sudo ss -ltnp \| grep :443` |

Certyfikat po zmianie IP maszyny:

```bash
# IP jest efemeryczne - po stop/start zmienia się nazwa sslip.io
gcloud compute instances describe stock-dashboard --zone us-central1-a \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)'
# potem uruchom ponownie deploy.sh, który podmieni nazwę hosta w Caddyfile
```

## Wdrożenie odrzucone

`release.sh` cofa się sam, gdy health check nie przejdzie. W logu Actions zobaczysz `Health check NIE PRZESZEDL`.

Serwis wtedy **działa na poprzedniej wersji** — nie ma pożaru, jest tylko niewdrożona zmiana.

```bash
# Co konkretnie nie wstało
vm --command 'sudo journalctl -u stock-dashboard -n 60 --no-pager'

# Która wersja stoi teraz
vm --command 'curl -s http://127.0.0.1:8787/stock-dashboard/api/v1/health'
```

Napraw przyczynę, dopisz test, który by ją złapał, i wypchnij ponownie.

## Przywrócenie bazy

Kopie: `/var/lib/stock-dashboard/backups/`, 14 ostatnich. Jedna powstaje przed każdym wdrożeniem, jedna codziennie o 21:30.

```bash
# Co jest dostępne
vm --command 'sudo ls -lht /var/lib/stock-dashboard/backups/ | head'

# Przywrócenie
vm --command '
  sudo systemctl stop stock-dashboard
  sudo -u sdapp cp /var/lib/stock-dashboard/backups/dashboard-ZMIEN-MNIE.db \
                   /var/lib/stock-dashboard/dashboard.db
  sudo rm -f /var/lib/stock-dashboard/dashboard.db-wal /var/lib/stock-dashboard/dashboard.db-shm
  sudo systemctl start stock-dashboard
  sleep 3 && curl -s http://127.0.0.1:8787/stock-dashboard/api/v1/health
'
```

**Przywrócenie cofa też dane wpisane po wykonaniu kopii.** Zanim to zrobisz, upewnij się, że problemem naprawdę są dane, a nie kod.

Kopia na własny komputer, zanim zaczniesz cokolwiek naprawiać:

```bash
bash deploy/gcp/backup-pull.sh ~/kopie-portfela
```

## Dysk pełny

```bash
vm --command '
  df -h /
  sudo du -sh /var/lib/stock-dashboard/backups /var/log/journal 2>/dev/null
'
# Journal do 200 MB
vm --command 'sudo journalctl --vacuum-size=200M'
# Kompaktowanie bazy
vm --command 'sudo -u sdapp env SD_DATA_DIR=/var/lib/stock-dashboard SD_DB_PATH=/var/lib/stock-dashboard/dashboard.db node /opt/stock-dashboard/scripts/admin.mjs vacuum'
```

## CI: `iam.serviceAccounts.actAs permission` przy `gcloud compute scp/ssh`

Maszyna działa na własnym koncie usługowym. Konto wdrożeniowe musi mieć prawo `actAs` na koncie maszyny:

```bash
VM_SA=$(gcloud compute instances describe stock-dashboard --zone us-central1-a \
  --format='get(serviceAccounts[0].email)')
gcloud iam service-accounts add-iam-policy-binding "$VM_SA" \
  --member="serviceAccount:github-deployer@$(gcloud config get-value project).iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"
```

Od wersji z sierpnia 2026 `setup-cicd.sh` nadaje to sam.

## CI: krok „Wysłanie na maszynę" wisi i kończy się kodem 124

Kod 124 to `timeout`, który ubił zawieszone polecenie — nie błąd uprawnień.

Przyczyna: **`gcloud compute scp` przez tunel IAP**. Od OpenSSH 9.0 `scp` przesyła dane podsystemem SFTP, a ten w połączeniu z tunelem IAP potrafi zawisnąć bez żadnego komunikatu. Runner GitHuba (`ubuntu-latest`) ma OpenSSH 9.6, więc trafia dokładnie w ten przypadek.

Rozpoznanie po objawach: krok **„Sprawdzenie połączenia z maszyną" przechodzi**, a wysyłka wisi. Znaczy to, że SSH, IAP, firewall i uprawnienia są sprawne — problem dotyczy wyłącznie ścieżki scp.

Rozwiązanie zastosowane od sierpnia 2026: pliku nie przesyłamy przez `scp`, tylko strumieniem przez to samo `ssh`, które działa:

```bash
gcloud compute ssh VM --zone ZONE --tunnel-through-iap --quiet \
  --ssh-flag=-T --command='cat > ~/release.tar.gz' < paczka.tar.gz
```

Flaga `-T` jest obowiązkowa — bez niej pseudoterminal przerobi końce linii i paczka dotrze uszkodzona. Krok weryfikuje `sha256sum` po obu stronach, więc uszkodzenie zatrzyma wdrożenie, zanim ktokolwiek zatrzyma usługę.

Gdyby mimo to wisiało: sprawdź, czy wisi też zwykłe `vm --command 'echo test'`. Jeśli tak, problem jest w IAP albo OS Login, nie w przesyle — patrz sekcja o `actAs` powyżej.

## CI: krok „Wydanie na staging" pada od razu

Objaw: `EACCES: permission denied` w logu kroku, wydanie kończy się po kilku sekundach.

`sanitize-db.mjs` biegnie jako `sdapp`, a nie jako root. Ma więc dwa miejsca, w których może się o coś potknąć — i oba były zepsute do sierpnia 2026:

| Komunikat | Przyczyna | Poprawka |
|---|---|---|
| `permission denied, copyfile` | katalog `/var/lib/stock-dashboard-staging` należał jeszcze do roota | `chown` **przed** sanityzacją, nie po |
| `permission denied, mkdir '.../stock-dashboard-staging/data'` | `config.mjs` przy imporcie zakłada katalog `data` obok kodu, a kod należy do roota | jawny `SD_DATA_DIR` w wywołaniu |

Sprawdzenie na maszynie, gdy wróci coś podobnego:

```bash
vm --command '
  ls -ld /var/lib/stock-dashboard-staging /opt/stock-dashboard-staging
  sudo -u sdapp env SD_OFFLINE=1 SD_DATA_DIR=/var/lib/stock-dashboard-staging \
    SD_DB_PATH=/var/lib/stock-dashboard-staging/dashboard.db \
    node /opt/stock-dashboard-staging/scripts/sanitize-db.mjs \
    /var/lib/stock-dashboard/dashboard.db /tmp/proba.db
'
```

Katalog danych ma być `drwx------ sdapp sdapp`, katalog kodu `drwxr-xr-x root root`.

**Reguła ogólna:** każde `sudo -u sdapp node ...` w skryptach wdrożeniowych musi dostać jawny `SD_DATA_DIR`. Pilnuje tego `tests/deploy-scripts.test.mjs`, więc CI zatrzyma taką zmianę, zanim dojedzie na maszynę.

## Utracone hasło właściciela

```bash
vm --command 'sudo -u sdapp env SD_DATA_DIR=/var/lib/stock-dashboard SD_DB_PATH=/var/lib/stock-dashboard/dashboard.db node /opt/stock-dashboard/scripts/admin.mjs users'
# potem interaktywnie:
vm
sudo -u sdapp env SD_DATA_DIR=/var/lib/stock-dashboard SD_DB_PATH=/var/lib/stock-dashboard/dashboard.db \
  node /opt/stock-dashboard/scripts/admin.mjs reset-password TWOJ@EMAIL
```

## Podejrzenie włamania

```bash
vm --command '
  sudo -u sdapp env SD_DATA_DIR=/var/lib/stock-dashboard SD_DB_PATH=/var/lib/stock-dashboard/dashboard.db \
    node -e "
      const {DatabaseSync}=require(\"node:sqlite\");
      const db=new DatabaseSync(process.env.SD_DB_PATH);
      console.log(db.prepare(\"SELECT at,action,ip,user_id FROM audit_log WHERE action LIKE \\\"auth%\\\" ORDER BY id DESC LIMIT 30\").all());
    "
'
```

Natychmiastowe działania: unieważnij wszystkie sesje (`DELETE FROM sessions`), zmień hasło, unieważnij linki publiczne i tokeny webhooków, sprawdź `audit_log` pod kątem `portfolio.deleted` i `transaction.deleted`.

W ostateczności odetnij ruch z internetu, zostawiając sobie dostęp przez IAP:

```bash
gcloud compute firewall-rules update stock-dashboard-web --source-ranges=127.0.0.1/32
```
