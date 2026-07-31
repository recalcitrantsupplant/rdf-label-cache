#!/usr/bin/env bash
# Report namespaces your data USES but doesn't LABEL - a shopping list for
# seed-public. Runs scripts/pipeline/coverage-report.rq; heed its warning about
# large datasets.
#
# Usage: scripts/ops/coverage-report.sh [ENDPOINT]   (else SPARQL_ENDPOINT)
set -euo pipefail
cd "$(dirname "$0")/../.."
. scripts/ops/lib.sh

ENDPOINT="${1:-${SPARQL_ENDPOINT:-}}"
[ -n "$ENDPOINT" ] \
    || die "pass an endpoint (just coverage-report <url>) or set SPARQL_ENDPOINT in .env"

curl -sf "$ENDPOINT" \
    --data-urlencode query@scripts/pipeline/coverage-report.rq \
    -H "Accept: text/csv" | column -t -s,
