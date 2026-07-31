#!/usr/bin/env bash
# Assert a DEPLOYED base URL is serving the new faithful shape, so you can tell a
# cutover actually landed. Two probes:
#   1. context/labels-v1.json defines the `description` term (context re-seeded), and
#   2. skos:Concept is kept under its real predicate `label` (rdfs:label), NOT
#      coerced to `prefLabel` (data re-seeded).
#
# Usage: scripts/ops/verify-shape.sh <BASE_URL>
set -euo pipefail
cd "$(dirname "$0")/../.."
. scripts/ops/lib.sh

B="${1:?usage: verify-shape.sh <base-url>}"; B="${B%/}"
fail=0

echo "==> context/labels-v1.json defines the 'description' term"
CTX="$(curl -fsS "$B/context/labels-v1.json")"
if jq -e '.["@context"].description["@id"] == "dcterms:description"' >/dev/null <<<"$CTX"; then
    echo "   PASS"
else
    echo "   FAIL - context not re-seeded (no 'description' term). Run demo-seed." >&2; fail=1
fi

echo "==> skos:Concept kept under rdfs:label (not coerced to prefLabel)"
DOC="$(curl -fsS "$B/label?iri=$(enc 'http://www.w3.org/2004/02/skos/core#Concept')")"
if jq -e 'has("label")' >/dev/null <<<"$DOC"; then
    echo "   PASS ($(jq -c '{label: .label, prefLabel: .prefLabel}' <<<"$DOC"))"
else
    echo "   FAIL - data still coerced (no 'label' term). Got keys: $(jq -c 'keys' <<<"$DOC")" >&2; fail=1
fi

if [ "$fail" = 0 ]; then
    echo "✓ $B is serving the faithful shape"
else
    die "cutover incomplete - see FAILs above"
fi
