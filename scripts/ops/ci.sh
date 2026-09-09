#!/usr/bin/env bash
# Install deps, typecheck, and run the full test suite.
# Called by .github/workflows/ci.yml and runnable locally from the repo root.
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "==> Installing dependencies (frozen lockfile)"
pnpm install --frozen-lockfile

echo "==> Typecheck"
pnpm typecheck

echo "==> Test"
pnpm test

# The client library (packages/label-cache-client) is a standalone, zero-dep
# package, not yet a pnpm workspace member, so it is built and tested explicitly
# here using the root-installed toolchain (TypeScript from the root lockfile,
# Node's built-in test runner). No extra install, so --frozen-lockfile holds.
echo "==> Client library: build & test (packages/label-cache-client)"
node_modules/.bin/tsc -p packages/label-cache-client/tsconfig.json
node --test packages/label-cache-client/test/*.test.mjs

# The demo serves self-hosted browser bundles; regenerate both and fail if a
# committed copy has drifted from its source or bundler version.
echo "==> Demo vendor bundles: verify in sync"
./scripts/ops/vendor-n3.sh
./scripts/ops/vendor-label-client.sh
if ! git diff --exit-code -- demo/public/vendor/n3.mjs demo/public/vendor/label-cache-client.mjs; then
  echo "ERROR: demo vendor bundles are out of date." >&2
  echo "Run ./scripts/ops/vendor-n3.sh and ./scripts/ops/vendor-label-client.sh, then commit the results." >&2
  exit 1
fi
