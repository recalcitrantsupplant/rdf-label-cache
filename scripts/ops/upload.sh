#!/usr/bin/env bash
# Upload dist/seed/manifest.ndjson to this project's R2 bucket. Requires PROJECT
# plus the R2_* credentials (see the guide).
#
# Usage: PROJECT=orders scripts/ops/upload.sh   (or: just project=orders upload)
set -euo pipefail
cd "$(dirname "$0")/../.."
. scripts/ops/lib.sh
require_project upload

R2_BUCKET="$BUCKET" node scripts/pipeline/upload-seed.mjs
