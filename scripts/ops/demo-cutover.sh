#!/usr/bin/env bash
# Maintainer-only cutover of the DEPLOYED demo instance (label-cache-demo):
# redeploy (ships the widget asset) -> re-seed R2 (new object shape) -> verify.
# Self-hosters never need this; deploy the root wrangler.toml with your own bucket.
#
# Usage: scripts/ops/demo-cutover.sh
#   Each step is also runnable on its own: deploy-demo.sh, demo-seed.sh,
#   demo-purge.sh, verify-shape.sh.
#
# WHY THIS EXISTS
# The faithful-ingestion change alters two things the live demo serves:
#   1. the object SHAPE in R2 - each predicate now under its own JSON-LD term
#      (no coercion to prefLabel; multi-valued terms are arrays), and
#   2. the demo WIDGET JS - a static asset the demo Worker ships.
# Cutting the live demo over therefore needs a Worker redeploy (ships the asset),
# an R2 re-seed (rewrites every object), AND a cache purge. This does all three
# in order, then verifies the deployed instance is serving the new shape.
#
# WHY NO DELETE STEP
# Re-seed is a safe upsert: keys are unchanged (labels/{lang}/{iri}), so new
# bodies overwrite old ones in place, and the new predicate set is a SUPERSET of
# the old (adds altLabel + standalone descriptions), so nothing is orphaned. A
# plain re-seed + purge is a COMPLETE cutover for this change - no mirror needed.
#
# ENV (from .env at the repo root, or exported - the same vars the Justfile and
# scripts/ops/seed.sh already use, nothing demo-specific):
#   SEED_BASE              deployed demo origin (baked into each object's @context),
#                          e.g. https://label-cache-demo.<subdomain>.workers.dev
#   CLOUDFLARE_API_TOKEN   API token for wrangler, used by scripts/ops/deploy-demo.sh
#   CLOUDFLARE_ACCOUNT_ID  your account id - used for BOTH deploy and the R2 S3
#                          endpoint host (R2's account id IS the Cloudflare one)
#   R2_ACCESS_KEY_ID       \  an R2 API token's S3 key + secret - NOT the API token
#   R2_SECRET_ACCESS_KEY   /  above; create under R2 -> Manage R2 API Tokens
#   PURGE_TOKEN            required to invalidate cached labels/context after seed
#
# Requires `pnpm` on PATH for the deploy step (`corepack enable` provides it) and
# `jq` + `python3` for verify. deploy-demo.sh publishes the CURRENT checkout, so
# run this from the branch/commit whose behaviour you want the demo to match.
set -euo pipefail
cd "$(dirname "$0")/../.."
. scripts/ops/lib.sh

[ -n "${SEED_BASE:-}" ] || die "set SEED_BASE (deployed demo origin) in .env or the shell"

scripts/ops/deploy-demo.sh
scripts/ops/demo-seed.sh
scripts/ops/verify-shape.sh "$SEED_BASE"
echo "✓ demo cut over to the faithful-ingestion shape"
