#!/usr/bin/env bash
# Driftwood — GCP bootstrap.
#
# Deliberately small. Compute is local, Postgres is local (docker-compose.yml).
# The only cloud resources are the Vertex API (usage-billed, nothing to create)
# and one GCS bucket holding ~110 MB of sweep backups for about $0.002/month.
#
#   ./infra/bootstrap-gcp.sh

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-halflife-506215}"
REGION="${REGION:-us-central1}"
BUCKET="${BUCKET:-${PROJECT_ID}-driftwood}"

echo "project ${PROJECT_ID}, region ${REGION}"
echo "  - enable aiplatform.googleapis.com + storage.googleapis.com"
echo "  - create gs://${BUCKET} (sweep backups, ~\$0.002/mo)"
echo "No Cloud SQL, no service accounts, no Secret Manager. See infra/README.md."
read -r -p "Proceed? [y/N] " reply
[[ "${reply}" == "y" || "${reply}" == "Y" ]] || { echo "aborted"; exit 1; }

gcloud config set project "${PROJECT_ID}" >/dev/null
gcloud services enable aiplatform.googleapis.com storage.googleapis.com

if gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  echo "gs://${BUCKET} already exists"
else
  gcloud storage buckets create "gs://${BUCKET}" \
    --location="${REGION}" --uniform-bucket-level-access
  # Sweeps are the irreplaceable artifact: re-running costs money AND returns
  # different data, because the models underneath have moved.
  gcloud storage buckets update "gs://${BUCKET}" --versioning
fi

cat <<DONE

Done. Now:

  gcloud auth application-default login    # how Vertex authenticates
  docker compose up -d                     # Postgres 16 + pgvector, local
  pnpm db:migrate

  .env:
    DATABASE_URL=postgresql://driftwood:driftwood@127.0.0.1:5432/driftwood
    GCP_PROJECT_ID=${PROJECT_ID}
    GCP_REGION=${REGION}
    GCS_BACKUP_BUCKET=${BUCKET}

Back up after each sweep (not nightly — a sweep is one afternoon's work):
    pnpm backup     # pg_dump | gzip | gcloud storage cp
DONE
