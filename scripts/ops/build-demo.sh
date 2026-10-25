#!/usr/bin/env bash
# Build self-hosted browser assets from the installed, lockfile-pinned dependencies.
set -euo pipefail
cd "$(dirname "$0")/../.."

./scripts/ops/vendor-n3.sh
./scripts/ops/vendor-label-client.sh
