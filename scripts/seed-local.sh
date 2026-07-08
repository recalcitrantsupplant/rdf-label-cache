#!/usr/bin/env bash
# Load the ingest manifest into a running dev server's R2 via POST /dev/load,
# which writes through the R2 binding. This is the dev-only local path — the
# `wrangler r2 object put` CLI mangles keys containing "#" or "%", but the
# binding stores them verbatim. For real R2 use scripts/upload-seed.mjs (S3).
#
# Usage: scripts/seed-local.sh [DEV_URL] [KEY_REGEX]
#   scripts/seed-local.sh http://localhost:8801 '^labels/http://www.w3.org'
set -euo pipefail
cd "$(dirname "$0")/.."

URL="${1:-http://localhost:8801}"
FILTER="${2:-.}"
MANIFEST="dist/seed/manifest.ndjson"
[ -f "$MANIFEST" ] || { echo "no $MANIFEST — run: node scripts/ingest.mjs" >&2; exit 1; }

# Filter the manifest by key regex, then POST the NDJSON to /dev/load in one shot.
python3 - "$MANIFEST" "$FILTER" <<'PY' | curl -sS -X POST --data-binary @- "${URL%/}/dev/load"
import sys, json, re
manifest, pattern = sys.argv[1], re.compile(sys.argv[2])
with open(manifest) as f:
    for line in f:
        line = line.strip()
        if line and pattern.search(json.loads(line)["key"]):
            print(line)
PY
echo
