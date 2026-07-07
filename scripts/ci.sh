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
