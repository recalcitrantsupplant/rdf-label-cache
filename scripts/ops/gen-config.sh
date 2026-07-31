#!/usr/bin/env bash
# Generate .wrangler.gen.toml for PROJECT from wrangler.toml, rewriting the
# Worker name + bound bucket to label-cache-<project>. The R2 binding can't read
# an env var, so real deploys go through this templated config.
#
# Internal helper - `deploy` and `purge-token-set` run it for you.
set -euo pipefail
cd "$(dirname "$0")/../.."
. scripts/ops/lib.sh
require_project deploy

sed -E 's/^name = ".*"/name = "'"$BUCKET"'"/; s/^bucket_name = ".*"/bucket_name = "'"$BUCKET"'"/' \
    wrangler.toml > .wrangler.gen.toml
