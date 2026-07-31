#!/usr/bin/env bash
# Install the purge token as a Worker secret. Generate it first, for example:
#   export PURGE_TOKEN="$(openssl rand -base64 48)"
# Store the same token in the secret manager used by your seed job.
#
# Usage: PROJECT=orders PURGE_TOKEN=... scripts/ops/purge-token-set.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
. scripts/ops/lib.sh
require_project purge-token-set
[ -n "${PURGE_TOKEN:-}" ] || die "set a random PURGE_TOKEN before running this."

scripts/ops/gen-config.sh
# shellcheck disable=SC2086  # $RUN is a command prefix
printf '%s' "$PURGE_TOKEN" | $RUN wrangler secret put PURGE_TOKEN -c .wrangler.gen.toml
