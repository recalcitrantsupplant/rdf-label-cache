#!/usr/bin/env bash
# Extract label + description triples for every IRI your data uses from a SPARQL
# endpoint (runs scripts/pipeline/extract-labels.rq), saving Turtle to data.ttl.
#
# Usage: scripts/ops/extract-labels.sh <ENDPOINT> [OUT]
#   scripts/ops/extract-labels.sh https://my-endpoint/sparql
set -euo pipefail
cd "$(dirname "$0")/../.."
. scripts/ops/lib.sh

ENDPOINT="${1:-${SPARQL_ENDPOINT:-}}"
OUT="${2:-data.ttl}"
[ -n "$ENDPOINT" ] \
    || die "pass an endpoint (just extract-labels <url>) or set SPARQL_ENDPOINT in .env"

curl -sf "$ENDPOINT" \
    --data-urlencode query@scripts/pipeline/extract-labels.rq \
    -H "Accept: text/turtle" \
    -o "$OUT"
echo "wrote $OUT ($(wc -l < "$OUT" | tr -d ' ') lines)"
