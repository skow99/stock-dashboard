#!/usr/bin/env bash
# deploy/gcp/setup-cicd.sh - jednorazowa konfiguracja polaczenia GitHub Actions <-> Google Cloud.
#
# Uzywa Workload Identity Federation: GitHub przedstawia krotkozyjacy token OIDC,
# GCP wymienia go na tozsamosc konta uslugowego. Nigdzie nie powstaje trwaly klucz,
# wiec nie ma czego rotowac ani co wykrasc z repozytorium.
#
#   bash deploy/gcp/setup-cicd.sh skow99/stock-dashboard
set -euo pipefail

REPO="${1:?Uzycie: setup-cicd.sh <uzytkownik>/<repozytorium>}"
[[ "$REPO" == */* ]] || { echo "Format: uzytkownik/repozytorium"; exit 1; }

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
[[ -n "$PROJECT_ID" && "$PROJECT_ID" != "(unset)" ]] || { echo "Ustaw projekt: gcloud config set project ..."; exit 1; }
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

POOL="github-pool"
PROVIDER="github-provider"
SA_NAME="github-deployer"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

info() { printf '\033[32m==>\033[0m %s\n' "$1"; }

info "Projekt: $PROJECT_ID (numer $PROJECT_NUMBER)"
info "Repozytorium: $REPO"

info "Wlaczam wymagane API"
gcloud services enable \
  iamcredentials.googleapis.com sts.googleapis.com \
  compute.googleapis.com iap.googleapis.com \
  --project "$PROJECT_ID" --quiet

# ---------------------------------------------------------------- konto uslugowe
if ! gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
  info "Tworze konto uslugowe $SA_NAME"
  gcloud iam service-accounts create "$SA_NAME" \
    --project "$PROJECT_ID" \
    --display-name="GitHub Actions - wdrozenia dashboardu" --quiet
fi

# Minimalny zestaw uprawnien potrzebny do: odczytania danych maszyny, zestawienia
# tunelu IAP i zalogowania sie przez SSH z prawem sudo (bootstrap wymaga roota).
info "Nadaje minimalne role"
for ROLE in roles/compute.viewer roles/iap.tunnelResourceAccessor roles/compute.osAdminLogin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" --role="$ROLE" \
    --condition=None --quiet >/dev/null
  echo "    $ROLE"
done

# Maszyna dziala na wlasnym koncie uslugowym (domyslnie tym z Compute Engine).
# Zeby 'gcloud compute ssh/scp' moglo sie do niej podlaczyc, konto wdrozeniowe musi miec
# prawo "actAs" na koncie maszyny - inaczej dostaniemy:
#   PERMISSION_DENIED: User does not have iam.serviceAccounts.actAs permission
#     on the instance's service account.
VM_NAME_PROBE="${VM_NAME:-stock-dashboard}"
ZONE_PROBE="${ZONE:-us-central1-a}"
VM_SA="$(gcloud compute instances describe "$VM_NAME_PROBE" --zone "$ZONE_PROBE" \
  --project "$PROJECT_ID" --format='get(serviceAccounts[0].email)' 2>/dev/null || true)"

if [[ -n "$VM_SA" ]]; then
  info "Nadaje prawo actAs na koncie maszyny ($VM_SA)"
  gcloud iam service-accounts add-iam-policy-binding "$VM_SA" \
    --project "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/iam.serviceAccountUser" --quiet >/dev/null
else
  echo "    UWAGA: nie odczytalem konta uslugowego maszyny $VM_NAME_PROBE ($ZONE_PROBE)."
  echo "    Jesli maszyna jeszcze nie istnieje, uruchom ten skrypt ponownie po jej utworzeniu."
fi

# ---------------------------------------------------------------- pula tozsamosci
if ! gcloud iam workload-identity-pools describe "$POOL" \
     --project "$PROJECT_ID" --location=global >/dev/null 2>&1; then
  info "Tworze pule tozsamosci"
  gcloud iam workload-identity-pools create "$POOL" \
    --project "$PROJECT_ID" --location=global \
    --display-name="GitHub Actions" --quiet
fi

if ! gcloud iam workload-identity-pools providers describe "$PROVIDER" \
     --project "$PROJECT_ID" --location=global --workload-identity-pool="$POOL" >/dev/null 2>&1; then
  info "Tworze dostawce OIDC dla GitHuba"
  # Warunek attribute-condition ogranicza wymiane tokenu WYLACZNIE do Twojego repozytorium.
  # Bez niego dowolne repozytorium na GitHubie moglo by sie podszyc pod te tozsamosc.
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --project "$PROJECT_ID" --location=global \
    --workload-identity-pool="$POOL" \
    --display-name="GitHub OIDC" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
    --attribute-condition="assertion.repository=='${REPO}'" \
    --issuer-uri="https://token.actions.githubusercontent.com" --quiet
fi

info "Wiaze repozytorium z kontem uslugowym"
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project "$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}" \
  --quiet >/dev/null

PROVIDER_PATH="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"
VM_NAME="${VM_NAME:-stock-dashboard}"
ZONE="${ZONE:-us-central1-a}"
PUBLIC_HOST="$(gcloud compute instances describe "$VM_NAME" --zone "$ZONE" --project "$PROJECT_ID" \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null || true)"
[[ -n "$PUBLIC_HOST" ]] && PUBLIC_HOST="${PUBLIC_HOST//./-}.sslip.io"

echo
echo "════════════════════════════════════════════════════════════════════"
echo " Gotowe. Ustaw teraz zmienne w repozytorium na GitHubie."
echo "════════════════════════════════════════════════════════════════════"
echo
echo " Settings -> Secrets and variables -> Actions -> zakladka Variables"
echo " (to nie sa sekrety - same identyfikatory, moga byc jawne)"
echo
echo "   GCP_WIF_PROVIDER    $PROVIDER_PATH"
echo "   GCP_SERVICE_ACCOUNT $SA_EMAIL"
echo "   GCP_PROJECT_ID      $PROJECT_ID"
echo "   GCP_ZONE            $ZONE"
echo "   GCP_VM_NAME         $VM_NAME"
echo "   PUBLIC_HOST         ${PUBLIC_HOST:-<uzupelnij po wdrozeniu>}"
echo
echo " Jesli masz zainstalowane 'gh', wystarczy wkleic to:"
echo
cat <<EOF
   gh variable set GCP_WIF_PROVIDER    --repo "$REPO" --body "$PROVIDER_PATH"
   gh variable set GCP_SERVICE_ACCOUNT --repo "$REPO" --body "$SA_EMAIL"
   gh variable set GCP_PROJECT_ID      --repo "$REPO" --body "$PROJECT_ID"
   gh variable set GCP_ZONE            --repo "$REPO" --body "$ZONE"
   gh variable set GCP_VM_NAME         --repo "$REPO" --body "$VM_NAME"
   gh variable set PUBLIC_HOST         --repo "$REPO" --body "${PUBLIC_HOST:-ZMIEN_MNIE}"
EOF
echo
echo " Weryfikacja uprawnien konta uslugowego:"
echo "   gcloud projects get-iam-policy $PROJECT_ID --flatten='bindings[].members' \\"
echo "     --filter='bindings.members:${SA_EMAIL}' --format='table(bindings.role)'"
echo
