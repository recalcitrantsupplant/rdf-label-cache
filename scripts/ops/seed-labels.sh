#!/usr/bin/env bash
# Ingest YOUR label files from a folder and upload them to your R2 bucket - the
# fork/self-host Phase-2 seed path (file mode). Runs in any fork from the
# `seed-labels` GitHub Action once Cloudflare secrets are set, or locally.
# See "Get started fast" in README.md.
#
# Data (R2) and code (Worker) have independent lifecycles: this runs on demand,
# not on every deploy.
#
# Env:
#   SEED_BASE             deployed origin, e.g. https://label-cache-<you>.<sub>.workers.dev
#                         (baked into each object's @context URL)
#   R2_BUCKET             your bucket name, e.g. label-cache-<you> (no default -
#                         always target your own bucket explicitly)
#   CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY   R2 API token
#   PURGE_TOKEN           required to invalidate cached labels after upload
#   LABELS_DIR            folder of RDF files to ingest (default: labels)
#   INCLUDE_PUBLIC        non-empty = also seed the bundled public vocabularies
set -euo pipefail
cd "$(dirname "$0")/../.."

LABELS_DIR="${LABELS_DIR:-labels}"

# Fail fast: validate everything before the expensive ingest, so a missing
# credential doesn't surface only after parsing.
: "${SEED_BASE:?set SEED_BASE (deployed origin, for the embedded @context URL)}"
: "${R2_BUCKET:?set R2_BUCKET (your bucket name, e.g. label-cache-<you>)}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID (Cloudflare account id)}"
: "${R2_ACCESS_KEY_ID:?set R2_ACCESS_KEY_ID (from a Cloudflare R2 API token)}"
: "${R2_SECRET_ACCESS_KEY:?set R2_SECRET_ACCESS_KEY (from a Cloudflare R2 API token)}"
: "${PURGE_TOKEN:?set PURGE_TOKEN (required to invalidate cached data)}"
export R2_BUCKET

if [ ! -d "$LABELS_DIR" ]; then
  echo "ERROR: no '$LABELS_DIR/' folder - add RDF label files there (see labels/README.md)." >&2
  exit 1
fi

# Optional public-vocabulary top-up FIRST, so your own labels win any overlapping
# (IRI, language) key - upload overwrites by key, so the later pass takes effect.
if [ -n "${INCLUDE_PUBLIC:-}" ]; then
  echo "==> Ingesting bundled public vocabularies → dist/seed/manifest.ndjson"
  SEED_BASE="$SEED_BASE" node scripts/pipeline/ingest.mjs
  echo "==> Uploading public vocab to R2 ($R2_BUCKET)"
  node scripts/pipeline/upload-seed.mjs
fi

echo "==> Ingesting $LABELS_DIR/ → dist/seed/manifest.ndjson"
SEED_BASE="$SEED_BASE" node scripts/pipeline/ingest.mjs --input "$LABELS_DIR"

echo "==> Uploading to R2 ($R2_BUCKET)"
node scripts/pipeline/upload-seed.mjs

# Data changed → invalidate edge cache. Browsers refresh on their own within the
# hour (labels are served with a short browser max-age).
echo "==> Purging cache (tags: labels,context)"
PURGE_RESPONSE="$(curl -fsS -X POST -H "Authorization: Bearer $PURGE_TOKEN" \
  "${SEED_BASE%/}/admin/purge?tags=labels,context")"
echo "$PURGE_RESPONSE"
# The endpoint returns 200 even when no cache binding is present (`applied` is
# the signal the purge actually ran), so -f alone is not enough.
grep -q '"applied":true' <<<"$PURGE_RESPONSE" \
  || { echo "ERROR: purge was not applied - is the Worker's [cache] binding enabled?" >&2; exit 1; }

echo "==> Seed complete"
