#!/usr/bin/env bash
# Driftwood — one-time GCP bootstrap.
#
# Creates: API enablement, Cloud SQL (Postgres 16 + pgvector), a GCS bucket,
# a service account, and Secret Manager entries.
#
# This script CREATES BILLABLE RESOURCES. It prints a plan and waits for
# confirmation before touching anything. Re-running is safe: every step is
# idempotent and skips resources that already exist.
#
#   ./infra/bootstrap-gcp.sh                    # defaults to halflife-506215
#   PROJECT_ID=other ./infra/bootstrap-gcp.sh

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-halflife-506215}"
REGION="${REGION:-us-central1}"
SQL_INSTANCE="${SQL_INSTANCE:-driftwood-pg}"
SQL_TIER="${SQL_TIER:-db-g1-small}"
DB_NAME="${DB_NAME:-driftwood}"
DB_USER="${DB_USER:-driftwood}"
BUCKET="${BUCKET:-${PROJECT_ID}-driftwood-raw}"
SA_NAME="${SA_NAME:-driftwood-worker}"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

cat <<PLAN
Driftwood GCP bootstrap
  project        ${PROJECT_ID}
  region         ${REGION}
  Cloud SQL      ${SQL_INSTANCE} (${SQL_TIER}, POSTGRES_16, zonal, no HA)
  database       ${DB_NAME} (user: ${DB_USER})
  GCS bucket     gs://${BUCKET}
  service acct   ${SA_EMAIL}

Rough standing cost: ~\$15-30/month for Cloud SQL + GCS. Vertex is usage-billed
on top of that.
PLAN

read -r -p "Proceed? [y/N] " reply
[[ "${reply}" == "y" || "${reply}" == "Y" ]] || { echo "aborted"; exit 1; }

gcloud config set project "${PROJECT_ID}" >/dev/null

echo "==> enabling APIs"
gcloud services enable \
  aiplatform.googleapis.com \
  sqladmin.googleapis.com \
  storage.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com

echo "==> Cloud SQL instance"
if gcloud sql instances describe "${SQL_INSTANCE}" >/dev/null 2>&1; then
  echo "    ${SQL_INSTANCE} already exists, skipping"
else
  # Zonal, no HA, no read replicas. This is a benchmark, not a service --
  # the data is re-derivable from the GCS JSONL archive.
  gcloud sql instances create "${SQL_INSTANCE}" \
    --database-version=POSTGRES_16 \
    --tier="${SQL_TIER}" \
    --region="${REGION}" \
    --storage-auto-increase \
    --backup-start-time=07:00 \
    --database-flags=cloudsql.enable_pgvector=on
fi

echo "==> database + user"
gcloud sql databases describe "${DB_NAME}" --instance="${SQL_INSTANCE}" >/dev/null 2>&1 \
  || gcloud sql databases create "${DB_NAME}" --instance="${SQL_INSTANCE}"

if gcloud sql users list --instance="${SQL_INSTANCE}" --format='value(name)' | grep -qx "${DB_USER}"; then
  echo "    user ${DB_USER} already exists, leaving password untouched"
else
  DB_PASS="$(openssl rand -base64 32)"
  gcloud sql users create "${DB_USER}" --instance="${SQL_INSTANCE}" --password="${DB_PASS}"
  printf '%s' "${DB_PASS}" | gcloud secrets create driftwood-db-password --data-file=- 2>/dev/null \
    || printf '%s' "${DB_PASS}" | gcloud secrets versions add driftwood-db-password --data-file=-
  unset DB_PASS
  echo "    password stored in Secret Manager as driftwood-db-password"
fi

echo "==> GCS bucket"
if gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  echo "    gs://${BUCKET} already exists, skipping"
else
  gcloud storage buckets create "gs://${BUCKET}" \
    --location="${REGION}" \
    --uniform-bucket-level-access
fi

echo "==> service account"
gcloud iam service-accounts describe "${SA_EMAIL}" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "${SA_NAME}" --display-name="Driftwood worker"

for role in roles/aiplatform.user roles/cloudsql.client roles/storage.objectAdmin roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" --role="${role}" \
    --condition=None >/dev/null
done
echo "    granted aiplatform.user, cloudsql.client, storage.objectAdmin, secretmanager.secretAccessor"

CONNECTION_NAME="$(gcloud sql instances describe "${SQL_INSTANCE}" --format='value(connectionName)')"

cat <<DONE

Bootstrap complete.

Next, on the Mac:

  1. Application Default Credentials for Vertex:
       gcloud auth application-default login

  2. Start the Cloud SQL Auth Proxy (see infra/README.md for the launchd agent):
       cloud-sql-proxy ${CONNECTION_NAME} --port 5432

  3. Write .env:
       DATABASE_URL=postgresql://${DB_USER}:\$(gcloud secrets versions access latest --secret=driftwood-db-password)@127.0.0.1:5432/${DB_NAME}
       GCP_PROJECT_ID=${PROJECT_ID}
       GCP_REGION=${REGION}
       GCS_RAW_BUCKET=${BUCKET}

  4. Enable each Model Garden model in the console before its first call:
       https://console.cloud.google.com/vertex-ai/model-garden?project=${PROJECT_ID}
     Partner models (Claude, Llama, Mistral, Qwen, DeepSeek) each need explicit
     enablement, and several need a quota increase request. Do this before
     week 1 smoke tests, not during the first sweep.
DONE
