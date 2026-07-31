#!/usr/bin/env bash
# Run the demo UI locally, seed the in-memory (Miniflare) R2, and keep the
# server attached. Stop with Ctrl-C. Override the port with PORT=8790.
#
# Usage: scripts/ops/demo-local.sh      (or: just demo-local)
set -euo pipefail
cd "$(dirname "$0")/../.."
. scripts/ops/lib.sh

PORT="${PORT:-8787}"
BASE="http://localhost:$PORT"
require_free_port "$BASE" demo-local

start_worker "$BASE" --config demo/wrangler.demo.toml --var ENVIRONMENT:development --port "$PORT"

# Seed the real public vocabularies through the PRODUCTION ingest pipeline
# (scripts/pipeline/ingest.mjs), then load via /dev/load - the same faithful
# labels a real deployment serves (rdfs:label -> `label`, values verbatim,
# nothing coerced to prefLabel or humanized). The local demo shows exactly what
# production does; no curated fixtures to drift out of sync.
echo "ingesting public vocabularies (rdf, rdfs, owl, skos, dcterms, dcat, schema.org)..."
SEED_BASE="$BASE" node scripts/pipeline/ingest.mjs
scripts/ops/dev-load.sh "$BASE"
echo "seeded $(wc -l < dist/seed/manifest.ndjson) objects"
echo "Demo ready: $BASE/ (playground: /demo)"
wait "$WORKER_PID"
