#!/usr/bin/env bash
# deploy/gcp/deploy.sh - jednokomendowe wdrozenie na Google Cloud free tier (e2-micro).
#
# Uruchamiasz U SIEBIE (albo w Google Cloud Shell), nie na maszynie docelowej.
#
#   bash deploy/gcp/deploy.sh
#
# Zmienne opcjonalne:
#   PROJECT_ID   projekt GCP (domyslnie: aktualny z gcloud config)
#   ZONE         strefa (domyslnie us-central1-a; free tier tylko us-west1 / us-central1 / us-east1)
#   VM_NAME      nazwa maszyny (domyslnie stock-dashboard)
#   PUBLIC_HOST  wlasna nazwa hosta; jesli pusta, uzywamy <IP>.sslip.io
#   ADMIN_EMAIL  e-mail konta wlasciciela (domyslnie pyta)
#
set -euo pipefail

# ---------------------------------------------------------------- ustawienia
VM_NAME="${VM_NAME:-stock-dashboard}"
ZONE="${ZONE:-us-central1-a}"
MACHINE_TYPE="e2-micro"
DISK_SIZE="30GB"
DISK_TYPE="pd-standard"                       # UWAGA: pd-balanced i pd-ssd NIE sa w free tier
IMAGE_FAMILY="debian-12"
IMAGE_PROJECT="debian-cloud"
TAG="stock-dashboard"
IAP_RANGE="35.235.240.0/20"                   # zakres, z ktorego IAP tuneluje SSH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/deploy/gcp"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; BLD=$'\033[1m'; RST=$'\033[0m'
info() { printf '%s==>%s %s\n' "$GRN" "$RST" "$1"; }
warn() { printf '%s[!]%s %s\n' "$YEL" "$RST" "$1"; }
die()  { printf '%s[x]%s %s\n' "$RED" "$RST" "$1" >&2; exit 1; }

# ---------------------------------------------------------------- kontrole wstepne
command -v gcloud >/dev/null || die "Brak gcloud. Zainstaluj Google Cloud CLI albo uruchom ten skrypt w Cloud Shell."
[[ -f "$ROOT/server.mjs" ]] || die "Nie znajduje server.mjs. Uruchom skrypt z katalogu projektu."

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
[[ -n "$PROJECT_ID" && "$PROJECT_ID" != "(unset)" ]] || die "Nie ustawiono projektu. Uzyj: gcloud config set project TWOJ_PROJEKT"

REGION="${ZONE%-*}"
case "$REGION" in
  us-west1|us-central1|us-east1) ;;
  *) warn "Region $REGION jest POZA darmowym poziomem. Free tier obejmuje wylacznie us-west1, us-central1, us-east1."
     read -r -p "    Kontynuowac mimo to (maszyna bedzie platna)? [t/N] " a
     [[ "$a" =~ ^[TtYy]$ ]] || exit 1 ;;
esac

info "Projekt:  $PROJECT_ID"
info "Strefa:   $ZONE ($MACHINE_TYPE, $DISK_SIZE $DISK_TYPE)"

# Konto wlasciciela zakladamy JESZCZE PRZED wystawieniem serwisu (patrz README, sekcja o bezpieczenstwie).
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
if [[ -z "$ADMIN_EMAIL" ]]; then
  read -r -p "Adres e-mail konta wlasciciela dashboardu: " ADMIN_EMAIL
fi
[[ "$ADMIN_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "Niepoprawny adres e-mail."

# ---------------------------------------------------------------- API i firewall
info "Wlaczam wymagane API (moze potrwac przy pierwszym uruchomieniu)..."
gcloud services enable compute.googleapis.com iap.googleapis.com --project "$PROJECT_ID" --quiet

info "Konfiguruje firewall..."
# Ruch HTTP/HTTPS z internetu - potrzebny do Let's Encrypt i do samego dashboardu.
gcloud compute firewall-rules describe "${TAG}-web" --project "$PROJECT_ID" >/dev/null 2>&1 || \
gcloud compute firewall-rules create "${TAG}-web" \
  --project "$PROJECT_ID" --direction=INGRESS --action=ALLOW \
  --rules=tcp:80,tcp:443 --source-ranges=0.0.0.0/0 --target-tags="$TAG" \
  --description="Dashboard: HTTP (ACME) i HTTPS" --quiet

# SSH WYLACZNIE przez IAP - port 22 nie jest wystawiony na internet.
gcloud compute firewall-rules describe "${TAG}-ssh-iap" --project "$PROJECT_ID" >/dev/null 2>&1 || \
gcloud compute firewall-rules create "${TAG}-ssh-iap" \
  --project "$PROJECT_ID" --direction=INGRESS --action=ALLOW \
  --rules=tcp:22 --source-ranges="$IAP_RANGE" --target-tags="$TAG" \
  --description="Dashboard: SSH tylko przez Identity-Aware Proxy" --quiet

# ---------------------------------------------------------------- maszyna
if gcloud compute instances describe "$VM_NAME" --zone "$ZONE" --project "$PROJECT_ID" >/dev/null 2>&1; then
  info "Maszyna $VM_NAME juz istnieje - pomijam tworzenie."
else
  info "Tworze maszyne $VM_NAME..."
  gcloud compute instances create "$VM_NAME" \
    --project "$PROJECT_ID" --zone "$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --image-family="$IMAGE_FAMILY" --image-project="$IMAGE_PROJECT" \
    --boot-disk-size="$DISK_SIZE" --boot-disk-type="$DISK_TYPE" \
    --tags="$TAG" \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --metadata=enable-oslogin=TRUE \
    --scopes=logging-write,monitoring-write \
    --labels=app=stock-dashboard \
    --quiet
fi

info "Czekam, az maszyna przyjmie polaczenia SSH..."
for _ in $(seq 1 30); do
  gcloud compute ssh "$VM_NAME" --zone "$ZONE" --project "$PROJECT_ID" --tunnel-through-iap \
    --command="true" --quiet >/dev/null 2>&1 && break
  sleep 10
done

EXTERNAL_IP="$(gcloud compute instances describe "$VM_NAME" --zone "$ZONE" --project "$PROJECT_ID" \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"
[[ -n "$EXTERNAL_IP" ]] || die "Maszyna nie ma zewnetrznego adresu IP."

# Bez wlasnej domeny uzywamy sslip.io: <ip-z-myslnikami>.sslip.io rozwiazuje sie na ten adres,
# a domena jest na Public Suffix List, wiec Let's Encrypt wystawi normalny certyfikat.
PUBLIC_HOST="${PUBLIC_HOST:-${EXTERNAL_IP//./-}.sslip.io}"

info "Adres IP:  $EXTERNAL_IP"
info "Nazwa hosta: $PUBLIC_HOST"

# ---------------------------------------------------------------- przeslanie kodu
info "Pakuje i wysylam aplikacje..."
PKG="$(mktemp -d)/stock-dashboard.tar.gz"
# Pakujemy zawartosc projektu pod stala nazwa katalogu, niezaleznie od tego,
# jak nazywa sie katalog u Ciebie na dysku.
# --mode wyrownuje prawa w archiwum: katalogi i pliki czytelne dla wszystkich,
# zapis tylko dla wlasciciela. Bez tego katalog projektu z prawami 700 blokuje usluge na serwerze.
tar -czf "$PKG" -C "$ROOT" \
  --exclude='./.git' --exclude='./data' --exclude='./.env' --exclude='./node_modules' \
  --mode='u+rwX,go=rX' \
  --transform='s,^\.,stock-dashboard,' .

gcloud compute scp "$PKG" "$HERE/bootstrap.sh" "$HERE/Caddyfile.tmpl" \
  "$VM_NAME":~/ --zone "$ZONE" --project "$PROJECT_ID" --tunnel-through-iap --quiet

# ---------------------------------------------------------------- instalacja
info "Instaluje na maszynie (Node.js, Caddy, systemd, HTTPS)..."
gcloud compute ssh "$VM_NAME" --zone "$ZONE" --project "$PROJECT_ID" --tunnel-through-iap --quiet \
  --command="sudo PUBLIC_HOST='$PUBLIC_HOST' ADMIN_EMAIL='$ADMIN_EMAIL' bash ~/bootstrap.sh"

# ---------------------------------------------------------------- weryfikacja
info "Sprawdzam, czy serwis odpowiada publicznie..."
OK=""
for _ in $(seq 1 20); do
  if curl -fsS --max-time 10 "https://$PUBLIC_HOST/stock-dashboard/api/v1/health" >/dev/null 2>&1; then OK=1; break; fi
  sleep 6
done

echo
if [[ -n "$OK" ]]; then
  printf '%s╔══════════════════════════════════════════════════════════════════╗%s\n' "$BLD" "$RST"
  printf '%s║  Dashboard dziala                                                ║%s\n' "$BLD" "$RST"
  printf '%s╚══════════════════════════════════════════════════════════════════╝%s\n' "$BLD" "$RST"
  echo
  echo "  Adres:  https://$PUBLIC_HOST/stock-dashboard/"
  echo "  Login:  $ADMIN_EMAIL"
  echo "  Haslo:  wypisane powyzej przez bootstrap (pokazane TYLKO RAZ)"
  echo
  echo "  Zdrowie:  curl -s https://$PUBLIC_HOST/stock-dashboard/api/v1/health | jq"
  echo "  Logi:     gcloud compute ssh $VM_NAME --zone $ZONE --tunnel-through-iap --command 'sudo journalctl -u stock-dashboard -f'"
  echo "  Wylacz:   gcloud compute instances stop $VM_NAME --zone $ZONE"
  echo "  Usun:     bash deploy/gcp/destroy.sh"
else
  warn "Serwis nie odpowiedzial jeszcze publicznie."
  warn "Najczestsza przyczyna: Let's Encrypt potrzebuje chwili na wystawienie certyfikatu."
  echo "  Sprawdz:  gcloud compute ssh $VM_NAME --zone $ZONE --tunnel-through-iap --command 'sudo journalctl -u caddy -n 50 --no-pager'"
  echo "  Adres docelowy: https://$PUBLIC_HOST/stock-dashboard/"
fi
