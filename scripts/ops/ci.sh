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

# The demo serves a self-hosted bundle of the client; regenerate it and fail if
# the committed copy has drifted from the client source (it has before: the
# bundle sat at 0.1.0 while the package was 0.1.1).
echo "==> Demo vendor bundle: verify in sync"
./scripts/ops/vendor-label-client.sh
if ! git diff --exit-code -- demo/public/vendor/label-cache-client.mjs; then
  echo "ERROR: demo/public/vendor/label-cache-client.mjs is out of date." >&2
  echo "Run ./scripts/ops/vendor-label-client.sh and commit the result." >&2
  exit 1
fi
