#!/usr/bin/env bash
# Seed the REAL R2 bucket of a deployed instance, without exposing a seeding
# endpoint in production. Spins up a throwaway `wrangler dev --remote` server
# (which binds the real R2), calls /dev/seed with the target base URL so seeded
# objects embed the correct @context, then tears the server down.
#
# Usage: scripts/seed-remote.sh <BASE_URL> [WRANGLER_CONFIG]
#   scripts/seed-remote.sh https://rdf-label-cache.<sub>.workers.dev demo/wrangler.demo.toml
#
# Requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID when run non-interactively.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${1:?usage: seed-remote.sh <BASE_URL> [WRANGLER_CONFIG]}"
CONFIG="${2:-demo/wrangler.demo.toml}"
PORT="${PORT:-8799}"
LOG="$(mktemp)"

pnpm wrangler dev --remote --config "$CONFIG" --var ENVIRONMENT:development \
  --port "$PORT" >"$LOG" 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null || true; }
trap cleanup EXIT

echo "==> Waiting for remote dev server on :$PORT"
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "http://localhost:$PORT/namespaces"; then break; fi
  sleep 1
done

echo "==> Seeding via ?base=$BASE"
curl -fsS "http://localhost:$PORT/dev/seed?base=$BASE"
echo
echo "==> Seed complete"
