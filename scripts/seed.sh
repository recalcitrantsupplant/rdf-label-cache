#!/usr/bin/env bash
# Ingest common ontologies and upload them to a real R2 bucket.
#
# Run on ontology refresh (see .github/workflows/seed.yml), not on every deploy.
# Data (R2) and code (Worker) have independent lifecycles.
#
# Env (from GitHub Actions secrets, never inlined):
#   SEED_BASE             deployed origin, e.g. https://rdf-label-cache.<sub>.workers.dev
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, [R2_BUCKET]
#   [PURGE_TOKEN]         if set, purge cached labels after upload
set -euo pipefail
cd "$(dirname "$0")/.."

: "${SEED_BASE:?set SEED_BASE (deployed origin, for the embedded @context URL)}"

echo "==> Ingesting ontologies → dist/seed/manifest.ndjson"
SEED_BASE="$SEED_BASE" node scripts/ingest.mjs

echo "==> Uploading to R2 (${R2_BUCKET:-rdf-public-labels})"
node scripts/upload-seed.mjs

# Data changed → invalidate cached labels + context (best-effort; needs PURGE_TOKEN).
if [ -n "${PURGE_TOKEN:-}" ]; then
  echo "==> Purging cache (tags: labels,context)"
  curl -fsS -X POST -H "Authorization: Bearer $PURGE_TOKEN" \
    "${SEED_BASE%/}/admin/purge?tags=labels,context" && echo || echo "WARN: purge failed (non-fatal)"
else
  echo "==> PURGE_TOKEN unset — skipping purge; cached labels self-expire per TTL"
fi

echo "==> Seed complete"
