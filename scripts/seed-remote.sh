#!/usr/bin/env bash
# Seed a deployed instance's REAL R2 bucket with the full public vocabularies -
# a thin wrapper over scripts/seed.sh (the single ingest -> S3 upload -> purge
# seeder) that takes the deployed base URL as a positional argument instead of
# the SEED_BASE env var. All the real work, and the R2_* / PURGE_TOKEN it needs,
# live in seed.sh; R2_BUCKET defaults there to label-cache-demo.
#
# This replaces the old curated path (a throwaway --remote dev server calling
# /dev/seed), which only wrote the 12-term sample. For that smoke sample now, hit
# the Worker's dev-only /dev/seed endpoint directly (src/routes/dev-seed.ts;
# `just seed` against a local dev server).
#
# Usage: scripts/seed-remote.sh <BASE_URL>
#   scripts/seed-remote.sh https://label-cache-demo.<sub>.workers.dev
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${1:?usage: seed-remote.sh <BASE_URL>}"
SEED_BASE="$BASE" exec ./scripts/seed.sh
