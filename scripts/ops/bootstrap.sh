#!/usr/bin/env bash
# One-shot: install → extract labels → create bucket → deploy → ingest → seed R2.
#
# Fill in .env first (SPARQL_ENDPOINT + R2 creds), then: just bootstrap
# Prefer to go step by step? Run the pieces individually - each is its own
# script here (or Justfile recipe): install, extract-labels, bucket, deploy,
# ingest, upload.
#
# Usage: PROJECT=orders scripts/ops/bootstrap.sh [ENDPOINT]
set -euo pipefail
cd "$(dirname "$0")/../.."
. scripts/ops/lib.sh
require_project bootstrap

ENDPOINT="${1:-${SPARQL_ENDPOINT:-}}"
[ -n "$ENDPOINT" ] \
    || die "pass an endpoint (just bootstrap <url>) or set SPARQL_ENDPOINT in .env"

# shellcheck disable=SC2086  # $PKG is a command prefix ("corepack pnpm")
$PKG install
scripts/ops/extract-labels.sh "$ENDPOINT"
scripts/ops/bucket.sh
scripts/ops/deploy.sh
node scripts/pipeline/ingest.mjs --input data.ttl
scripts/ops/upload.sh
echo "✓ done - labels are live at ${SEED_BASE:-your Worker URL}"
