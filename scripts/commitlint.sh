#!/usr/bin/env bash
# Lint commit messages against Conventional Commits.
# In a PR (GITHUB_BASE_REF set) lints base..HEAD; otherwise lints the last commit.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${GITHUB_BASE_REF:-}"
if [ -n "$BASE" ]; then
  git fetch --depth=100 origin "$BASE" >/dev/null 2>&1 || true
  pnpm exec commitlint --from "origin/$BASE" --to HEAD --verbose
else
  pnpm exec commitlint --from HEAD~1 --to HEAD --verbose
fi
