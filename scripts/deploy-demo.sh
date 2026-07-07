#!/usr/bin/env bash
# Deploy the maintainer demo to Cloudflare Workers.
# Called by .github/workflows/deploy-demo.yml on a release tag, and runnable
# locally. Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the env
# (set as GitHub Actions secrets for CI).
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"

# Ensure the R2 bucket bound in demo/wrangler.demo.toml exists (idempotent),
# so a first-time deploy doesn't 500 at runtime on a missing bucket.
BUCKET="rdf-public-labels"
echo "==> Ensuring R2 bucket '$BUCKET' exists"
if ! pnpm wrangler r2 bucket list 2>/dev/null | grep -qw "$BUCKET"; then
  pnpm wrangler r2 bucket create "$BUCKET"
fi

echo "==> Deploying demo worker"
pnpm wrangler deploy --config demo/wrangler.demo.toml

echo "==> Deployed. Seed data is managed separately via scripts/seed-remote.sh"
