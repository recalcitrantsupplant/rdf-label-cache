#!/usr/bin/env bash
# Deploy this project's Worker (label-cache-<project>). Requires PROJECT.
#
# Usage: PROJECT=orders scripts/ops/deploy.sh   (or: just project=orders deploy)
set -euo pipefail
cd "$(dirname "$0")/../.."
. scripts/ops/lib.sh
require_project deploy

scripts/ops/gen-config.sh
# shellcheck disable=SC2086  # $RUN is a command prefix
$RUN wrangler deploy -c .wrangler.gen.toml
