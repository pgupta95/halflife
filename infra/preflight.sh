#!/usr/bin/env bash
# Driftwood preflight — READ-ONLY. Creates nothing, changes nothing, costs nothing.
#
# Confirms the three inputs the cost model is guessing at: which Vertex models
# actually exist in the region, whether Cloud SQL offers pgvector on PG16 there,
# and what the project's current state is.
#
#   ./infra/preflight.sh 2>&1 | tee preflight.txt
#
# Paste preflight.txt back and the roster + estimates get pinned to reality.

set -uo pipefail

PROJECT_ID="${PROJECT_ID:-halflife-506215}"
REGION="${REGION:-us-central1}"

echo "=== Driftwood preflight ==="
echo "project ${PROJECT_ID}   region ${REGION}"
echo "date    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo

echo "--- account + project ---"
gcloud config get-value account 2>/dev/null
gcloud projects describe "${PROJECT_ID}" --format='value(projectId,lifecycleState)' 2>&1
echo "billing:"
gcloud billing projects describe "${PROJECT_ID}" --format='value(billingEnabled,billingAccountName)' 2>&1 \
  || echo "  (needs the billing API or roles/billing.viewer — not fatal, check in console)"
echo

echo "--- enabled APIs (of the ones we need) ---"
enabled="$(gcloud services list --enabled --project="${PROJECT_ID}" --format='value(config.name)' 2>/dev/null)"
for api in aiplatform sqladmin storage secretmanager iam; do
  if grep -q "^${api}\.googleapis\.com$" <<<"${enabled}"; then
    echo "  ON   ${api}.googleapis.com"
  else
    echo "  off  ${api}.googleapis.com   <- bootstrap-gcp.sh will enable"
  fi
done
echo

echo "--- Vertex: Gemini + embedding models in ${REGION} ---"
# The publisher model list is the authoritative roster; gcloud surface varies by
# SDK version, so fall back to the REST endpoint.
TOKEN="$(gcloud auth print-access-token 2>/dev/null)"
if [[ -n "${TOKEN}" ]]; then
  curl -sS -H "Authorization: Bearer ${TOKEN}" \
    "https://${REGION}-aiplatform.googleapis.com/v1beta1/publishers/google/models" \
    | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('  (could not parse response)'); sys.exit()
ms=d.get('publisherModels',d.get('models',[]))
if not ms: print('  (empty — check the aiplatform API is enabled)')
for m in ms:
    n=m.get('name','').split('/')[-1]
    if any(k in n for k in ('gemini','embedding')): print('  ',n)
" 2>&1
else
  echo "  (no access token — run: gcloud auth login)"
fi
echo

echo "--- Vertex: Model Garden partner models (Claude / Llama / Mistral / Qwen / DeepSeek) ---"
gcloud ai model-garden models list --project="${PROJECT_ID}" 2>&1 \
  | grep -iE 'claude|llama|mistral|qwen|deepseek|MODEL_ID' | head -40 \
  || echo "  (gcloud ai model-garden unavailable in this SDK version)"
echo "  NOTE: listed != enabled. Each partner model needs explicit enablement at"
echo "        https://console.cloud.google.com/vertex-ai/model-garden?project=${PROJECT_ID}"
echo

echo "--- Cloud SQL: Postgres 16 + pgvector availability in ${REGION} ---"
gcloud sql tiers list --project="${PROJECT_ID}" --filter="region:${REGION}" \
  --format='table(tier,RAM,Disk)' 2>&1 | head -12
echo "  (pgvector ships as a Cloud SQL extension on PG16; bootstrap sets"
echo "   cloudsql.enable_pgvector=on and CREATE EXTENSION runs in migration 0001)"
echo

echo "--- existing Driftwood resources (expect none on a fresh project) ---"
gcloud sql instances list --project="${PROJECT_ID}" 2>&1 | head -5
gcloud storage ls --project="${PROJECT_ID}" 2>&1 | head -5
echo
echo "=== end preflight ==="
