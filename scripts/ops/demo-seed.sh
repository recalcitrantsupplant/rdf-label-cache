#!/usr/bin/env bash
# Re-ingest the public vocab, upload to the DEMO bucket, and purge. Thin wrapper
# over scripts/ops/seed.sh; every object at labels/{lang}/{iri} is overwritten.
# R2_BUCKET is pinned so a stray R2_BUCKET in .env can't misdirect the seed.
#
# Usage: scripts/ops/demo-seed.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
. scripts/ops/lib.sh

[ -n "${SEED_BASE:-}" ] || die "set SEED_BASE (deployed demo origin) in .env or the shell"
R2_BUCKET="label-cache-demo" exec ./scripts/ops/seed.sh
