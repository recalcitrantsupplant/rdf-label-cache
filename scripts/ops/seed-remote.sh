#!/usr/bin/env bash
# Seed a deployed instance's REAL R2 bucket with the full public vocabularies -
# a thin wrapper over scripts/ops/seed.sh (the single ingest -> S3 upload -> purge
# seeder) that takes the deployed base URL as a positional argument instead of
# the SEED_BASE env var. All the real work, and the R2_* / PURGE_TOKEN it needs,
# live in seed.sh; R2_BUCKET defaults there to label-cache-demo.
#
# This replaces the old curated path (a throwaway --remote dev server calling
# /dev/seed), which only wrote the 12-term sample. For that smoke sample now, hit
# the Worker's dev-only /dev/seed endpoint directly (src/routes/dev-seed.ts;
# `just seed` against a local dev server).
#
# Usage: scripts/ops/seed-remote.sh <BASE_URL>
#   scripts/ops/seed-remote.sh https://label-cache-demo.<sub>.workers.dev
set -euo pipefail
cd "$(dirname "$0")/../.."

. scripts/ops/lib.sh

BASE="${1:?usage: seed-remote.sh <BASE_URL>}"
# R2_BUCKET is normally derived from PROJECT (label-cache-<project>); an explicit
# R2_BUCKET still wins, and seed.sh falls back to label-cache-demo without either.
if [ -z "${R2_BUCKET:-}" ] && [ -n "${PROJECT:-}" ]; then
    require_project seed-remote
    R2_BUCKET="$BUCKET"
    export R2_BUCKET
fi
SEED_BASE="$BASE" exec ./scripts/ops/seed.sh
