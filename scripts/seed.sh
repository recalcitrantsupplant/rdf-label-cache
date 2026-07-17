#!/usr/bin/env bash
# Ingest common ontologies and upload them to a real R2 bucket.
#
# Run on ontology refresh (see .github/workflows/seed.yml), not on every deploy.
# Data (R2) and code (Worker) have independent lifecycles.
#
# Env (from GitHub Actions secrets, never inlined):
#   SEED_BASE             deployed origin, e.g. https://label-cache-demo.<sub>.workers.dev
#   CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
#   R2_BUCKET             bucket name (default: label-cache-demo, the demo instance)
#   PURGE_TOKEN           required to purge cached labels after upload
set -euo pipefail
cd "$(dirname "$0")/.."

# This script seeds the maintainer demo instance; its bucket defaults accordingly.
export R2_BUCKET="${R2_BUCKET:-label-cache-demo}"

# Fail fast: validate everything the run needs before the expensive ingest step,
# so a missing credential doesn't surface only after fetching ~3k terms.
: "${SEED_BASE:?set SEED_BASE (deployed origin, for the embedded @context URL)}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID (Cloudflare account id)}"
: "${R2_ACCESS_KEY_ID:?set R2_ACCESS_KEY_ID (from a Cloudflare R2 API token)}"
: "${R2_SECRET_ACCESS_KEY:?set R2_SECRET_ACCESS_KEY (from a Cloudflare R2 API token)}"
: "${PURGE_TOKEN:?set PURGE_TOKEN (required to invalidate cached data)}"

echo "==> Ingesting ontologies → dist/seed/manifest.ndjson"
SEED_BASE="$SEED_BASE" node scripts/ingest.mjs

echo "==> Uploading to R2 ($R2_BUCKET)"
node scripts/upload-seed.mjs

# Data changed → invalidate edge cache. Browsers refresh on their own within
# the hour (labels are served with a short browser max-age).
echo "==> Purging cache (tags: labels,context)"
PURGE_RESPONSE="$(curl -fsS -X POST -H "Authorization: Bearer $PURGE_TOKEN" \
  "${SEED_BASE%/}/admin/purge?tags=labels,context")"
echo "$PURGE_RESPONSE"
# The endpoint returns 200 even when no cache binding is present (`applied` is
# the signal the purge actually ran), so -f alone is not enough.
grep -q '"applied":true' <<<"$PURGE_RESPONSE" \
  || { echo "ERROR: purge was not applied - is the Worker's [cache] binding enabled?" >&2; exit 1; }

echo "==> Seed complete"
