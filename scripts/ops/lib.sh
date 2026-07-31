#!/usr/bin/env bash
# Shared helpers for scripts/ops/*.sh. Sourced, never executed.
#
# Every ops script cd's to the repo root first, so all paths below (and in the
# callers) are root-relative regardless of where you invoke them from.
#
# The Justfile passes its settings through the environment - PM (package
# manager) and PROJECT - so the scripts stay runnable on their own:
#   PROJECT=orders scripts/ops/bucket.sh
#   PM=npm scripts/ops/demo-local.sh

die() { echo "ERROR: $*" >&2; exit 1; }

# Package manager + its binary-runner for local tools like wrangler. Mirrors the
# Justfile's pm/package/run variables. $RUN is intentionally word-split at use.
PM="${PM:-pnpm}"
case "$PM" in
    npm) RUN="npx";              PKG="npm" ;;
    bun) RUN="bunx";             PKG="bun" ;;
    *)   RUN="corepack pnpm exec"; PKG="corepack pnpm" ;;
esac

# One project = one Worker + one R2 bucket, both named label-cache-<project>, so
# two apps never share a bucket. Sets $PROJECT and $BUCKET, or exits.
# Usage: require_project <recipe-name-for-the-error-message>
require_project() {
    [ -n "${PROJECT:-}" ] \
        || die "set project=<name> (e.g. just project=orders ${1:-<recipe>}) or PROJECT in .env"
    BUCKET="label-cache-$PROJECT"
}

# A Worker answers OPTIONS /label as soon as it is serving. During a `wrangler
# dev` reload it 503s instead, which is why callers re-check rather than assume.
worker_ready() { curl -sf -o /dev/null -X OPTIONS "${1%/}/label"; }

# Two dev Workers on one port silently shadow each other - refuse up front.
# Usage: require_free_port <base-url> <recipe-name>
require_free_port() {
    if worker_ready "$1"; then
        die "$1 is already serving a Worker; choose another port (PORT=8790 just ${2:-dev-local})."
    fi
}

# Start `wrangler dev` in the background with the given args, kill it when we
# exit, and block until it serves. Sets $WORKER_PID for the caller to `wait` on.
# Usage: start_worker <base-url> [wrangler args...]
start_worker() {
    local base="$1"; shift
    # shellcheck disable=SC2086  # $RUN is a command prefix ("corepack pnpm exec")
    $RUN wrangler dev "$@" &
    WORKER_PID=$!
    # shellcheck disable=SC2317  # invoked via trap
    cleanup() { kill "$WORKER_PID" 2>/dev/null || true; }
    trap cleanup EXIT INT TERM
    echo "waiting for local Worker on $base..."
    for _ in $(seq 1 60); do
        # If wrangler died (bad config, port grab), surface ITS exit code.
        if ! kill -0 "$WORKER_PID" 2>/dev/null; then
            wait "$WORKER_PID"
            exit $?
        fi
        worker_ready "$base" && return 0
        sleep 1
    done
    die "local Worker did not become ready within 60 seconds."
}

# URL-encode a single argument (for IRIs in query strings).
enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1"; }
