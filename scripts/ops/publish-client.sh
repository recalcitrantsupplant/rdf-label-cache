#!/usr/bin/env bash
# Publish the client library (@rdf-label-cache/client) to npm.
#
# NORMAL FLOW is CI: bump the version in a PR, and .github/workflows/publish-client.yml
# publishes on merge to main. Use this for a DRY RUN (default) to preview the
# tarball, or `live` only for a local/emergency publish - don't race CI on versions.
#
# Reads NPM_TOKEN from .env - a granular or automation token with 2FA bypass (a plain
# token 403s on npm's publish 2FA gate). `npm test` builds + runs the suite first;
# prepack rebuilds dist; publishConfig makes it public. On `live` it auto-bumps the
# version (npm rejects republishing an existing one) - default patch, or pass
# minor/major/<version>. --no-git-tag-version means it only edits package.json;
# commit that yourself afterwards (the printed command).
#
#   scripts/ops/publish-client.sh            # build, test, show the tarball - publishes NOTHING
#   scripts/ops/publish-client.sh live       # bump patch + publish  (0.1.0 -> 0.1.1)
#   scripts/ops/publish-client.sh live minor # bump minor + publish  (0.1.0 -> 0.2.0)
set -euo pipefail
cd "$(dirname "$0")/../.."
. scripts/ops/lib.sh

MODE="${1:-dry}"
BUMP="${2:-patch}"
[ -n "${NPM_TOKEN:-}" ] \
    || die "set NPM_TOKEN in .env (npm granular/automation token with 2FA bypass)"

cd packages/label-cache-client
npm test
AUTH="--//registry.npmjs.org/:_authToken=${NPM_TOKEN}"

if [ "$MODE" = "live" ]; then
    npm version "$BUMP" --no-git-tag-version >/dev/null
    NAME="$(node -p "require('./package.json').name")"
    VERSION="$(node -p "require('./package.json').version")"
    npm publish "$AUTH"
    echo "✓ published ${NAME}@${VERSION}"
    echo "  → commit the bump: git commit -am 'chore(client): release ${NAME}@${VERSION}'"
else
    echo "== DRY RUN — nothing published or bumped. 'just publish-client live' bumps ($BUMP) + publishes. =="
    npm publish --dry-run "$AUTH"
fi
