#!/usr/bin/env bash
# Purge the demo's edge cache (labels,context) WITHOUT re-seeding - e.g. after an
# out-of-band upload. Browsers still refresh on their own within their short
# max-age. Needs SEED_BASE + PURGE_TOKEN.
#
# Usage: scripts/ops/demo-purge.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
. scripts/ops/lib.sh

[ -n "${SEED_BASE:-}" ] || die "set SEED_BASE (deployed demo origin) in .env or the shell"
[ -n "${PURGE_TOKEN:-}" ] || die "set PURGE_TOKEN (required to invalidate cached data)"

B="${SEED_BASE%/}"
RESP="$(curl -fsS -X POST -H "Authorization: Bearer $PURGE_TOKEN" "$B/admin/purge?tags=labels,context")"
echo "$RESP"
grep -q '"applied":true' <<<"$RESP" \
    || die "purge was not applied - is the Worker's [cache] binding enabled?"
