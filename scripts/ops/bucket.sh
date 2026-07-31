#!/usr/bin/env bash
# Create this project's R2 bucket (one-time). Requires PROJECT.
#
# Usage: PROJECT=orders scripts/ops/bucket.sh   (or: just project=orders bucket)
set -euo pipefail
cd "$(dirname "$0")/../.."
. scripts/ops/lib.sh
require_project bucket

# `wrangler r2 bucket list` has no --json output, so parse the `name:` lines and
# exact-match: a substring test would let e.g. label-cache-foo-staging shadow
# label-cache-foo and silently skip creation.
# shellcheck disable=SC2086  # $RUN is a command prefix
BUCKETS="$($RUN wrangler r2 bucket list | awk '$1 == "name:" { print $2 }')"
if grep -Fxq "$BUCKET" <<<"$BUCKETS"; then
    echo "R2 bucket $BUCKET already exists"
else
    # shellcheck disable=SC2086
    $RUN wrangler r2 bucket create "$BUCKET"
fi
