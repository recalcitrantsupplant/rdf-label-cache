#!/usr/bin/env bash
# Install deps, typecheck, and run the full test suite.
# Called by .github/workflows/ci.yml and runnable locally from the repo root.
set -euo pipefail
cd "$(dirname "$0")/.."

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
