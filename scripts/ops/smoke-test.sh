#!/usr/bin/env bash
# Smoke-test a deployed instance. Pass the base URL.
#
# Usage: scripts/ops/smoke-test.sh https://label-cache-orders.<sub>.workers.dev
set -euo pipefail
cd "$(dirname "$0")/../.."
. scripts/ops/lib.sh

BASE="${1:?usage: smoke-test.sh <BASE_URL>}"; BASE="${BASE%/}"

# bundled public vocab is untagged, so no ?lang= -> resolves the `und` key
echo "# skos:Concept"; curl -s "$BASE/label?iri=$(enc 'http://www.w3.org/2004/02/skos/core#Concept')" | jq
echo "# owl:Class";    curl -s "$BASE/label?iri=$(enc 'http://www.w3.org/2002/07/owl#Class')" | jq
echo "# context";      curl -s "$BASE/context/labels-v1.json" \
    | jq -c '.["@context"] | keys | "\(length) prefixes/terms"'
