#!/usr/bin/env bash
# Build + serve YOUR labels locally - no Cloudflare account, no deploy. Point at
# a Turtle file (full instance data OR labels-only; non-label triples are
# ignored) or a SPARQL endpoint, and this wires up extraction, ingest, and an
# in-memory local R2 so your app can hit http://localhost:$PORT/label?iri=... and
# get your labels back - the exact same Worker path production runs
# (edge -> R2 -> 404).
#
#   scripts/ops/dev-local.sh                    # ingest ./data.ttl
#   INPUT=my.ttl scripts/ops/dev-local.sh
#   ENDPOINT=https://my-endpoint/sparql scripts/ops/dev-local.sh  # extract first
#   PUBLIC=1 scripts/ops/dev-local.sh           # also load bundled public vocab
#
# Stop with Ctrl-C. Override the port with PORT=8790.
set -euo pipefail
cd "$(dirname "$0")/../.."
. scripts/ops/lib.sh

PORT="${PORT:-8787}"
BASE="http://localhost:$PORT"
TTL="${INPUT:-data.ttl}"
require_free_port "$BASE" dev-local

# A SPARQL endpoint is extracted to the Turtle file first.
if [ -n "${ENDPOINT:-}" ]; then
    scripts/ops/extract-labels.sh "$ENDPOINT" "$TTL"
fi
[ -f "$TTL" ] || die "no '$TTL' - pass INPUT=<file.ttl> or ENDPOINT=<sparql-url>."

# Local dev Worker: in-memory Miniflare R2, /dev/load enabled by the development
# ENVIRONMENT override. Same invocation as `just dev`.
start_worker "$BASE" --var ENVIRONMENT:development --port "$PORT"

# Optional: the bundled public vocabularies (rdfs/skos/owl/... your data may
# reference but not label itself). Loaded FIRST so your own labels below win any
# (IRI, language) overlap - /dev/load overwrites by key.
if [ -n "${PUBLIC:-}" ]; then
    SEED_BASE="$BASE" node scripts/pipeline/ingest.mjs
    scripts/ops/dev-load.sh "$BASE"
    echo "loaded bundled public vocab"
fi

# Your labels: extract annotation triples from the dump into a manifest (each
# object's @context baked to the local origin), then load into R2. The manifest
# also carries context/labels-v1.json, so /context resolves locally too.
SEED_BASE="$BASE" node scripts/pipeline/ingest.mjs --input "$TTL"
scripts/ops/dev-load.sh "$BASE"
echo
echo "Ready: your labels are live at $BASE/label?iri=<encoded-iri>"
wait "$WORKER_PID"
