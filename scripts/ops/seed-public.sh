#!/usr/bin/env bash
# Seed PUBLIC vocabulary labels into R2 (all, or a chosen subset).
#
# No args = all bundled vocabularies (rdf, rdfs, owl, skos, dcterms, dcat,
# schema) - a few thousand terms total, small even with schema.org, so there's no
# harm seeding the lot. Or pass a comma list for only those. Additive to your own
# labels in R2 - run before or after ingest.
#
#   PROJECT=orders scripts/ops/seed-public.sh
#   PROJECT=orders scripts/ops/seed-public.sh skos,rdf,rdfs
set -euo pipefail
cd "$(dirname "$0")/../.."
. scripts/ops/lib.sh
require_project seed-public
[ -n "${SEED_BASE:-}" ] \
    || die "set SEED_BASE (your deployed Worker URL, for the embedded @context)"

NAMESPACES="${1:-}"
if [ -n "$NAMESPACES" ]; then
    node scripts/pipeline/ingest.mjs --only "$NAMESPACES"
else
    node scripts/pipeline/ingest.mjs
fi
R2_BUCKET="$BUCKET" node scripts/pipeline/upload-seed.mjs
