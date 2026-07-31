#!/usr/bin/env bash
# POST a seed manifest to a local Worker's /dev/load, tolerating a restart.
#
#   scripts/ops/dev-load.sh <base-url> [manifest]
#
# `wrangler dev` reloads on its own (config/asset/source changes, and after the
# long ingest step there is plenty of time for one), and during a reload it
# answers every request with 503. A bare `curl -fsS` there kills the recipe with
# exit 22 even though nothing is actually wrong. So: wait for the Worker to
# answer again, then load; retry the whole thing a few times. /dev/load
# overwrites by key, so a repeated POST is idempotent.
set -euo pipefail
cd "$(dirname "$0")/../.."
. scripts/ops/lib.sh

BASE="${1:?usage: dev-load.sh <base-url> [manifest]}"
MANIFEST="${2:-dist/seed/manifest.ndjson}"

for attempt in 1 2 3; do
    for _ in $(seq 1 20); do
        worker_ready "$BASE" && break
        sleep 1
    done
    if curl -fsS -X POST --data-binary "@$MANIFEST" "$BASE/dev/load" >/dev/null; then
        exit 0
    fi
    echo "load attempt $attempt failed (Worker reloading?) - retrying..." >&2
    sleep 2
done

die "could not load $MANIFEST into $BASE/dev/load."
