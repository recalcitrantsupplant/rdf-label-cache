#!/usr/bin/env bash
# Load the ingest manifest into a LOCAL wrangler R2 (miniflare) for demoing.
# For real R2 use scripts/upload-seed.mjs (S3 API) — this is the slow, dev-only
# path (one `wrangler r2 object put` per object).
#
# Usage: scripts/seed-local.sh [WRANGLER_CONFIG] [KEY_REGEX]
#   scripts/seed-local.sh demo/wrangler.demo.toml '^labels/(rdf|rdfs|owl|skos)/'
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG="${1:-demo/wrangler.demo.toml}"
FILTER="${2:-.}"
BUCKET="rdf-public-labels"
MANIFEST="dist/seed/manifest.ndjson"
WRANGLER="node_modules/.bin/wrangler"
[ -f "$MANIFEST" ] || { echo "no $MANIFEST — run: node scripts/ingest.mjs" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# One Python pass: write each matching body to a temp file, emit "key<TAB>file".
python3 - "$MANIFEST" "$FILTER" "$TMP" > "$TMP/index.tsv" <<'PY'
import sys, json, re
manifest, pattern, tmp = sys.argv[1], re.compile(sys.argv[2]), sys.argv[3]
i = 0
with open(manifest) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        if not pattern.search(rec["key"]):
            continue
        p = f"{tmp}/{i}.json"
        with open(p, "w") as o:
            o.write(rec["body"])
        print(f'{rec["key"]}\t{p}')
        i += 1
PY

n=$(wc -l < "$TMP/index.tsv" | tr -d ' ')
echo "==> loading $n objects into local R2 ($CONFIG)"
i=0
while IFS=$'\t' read -r key file; do
  "$WRANGLER" r2 object put "$BUCKET/$key" --file "$file" --local --config "$CONFIG" \
    --content-type application/ld+json >/dev/null 2>&1
  i=$((i + 1))
  [ $((i % 25)) -eq 0 ] && echo "    $i/$n"
done < "$TMP/index.tsv"
echo "==> loaded $i objects"
