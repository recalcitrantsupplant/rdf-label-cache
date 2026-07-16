# Recipes auto-load a `.env` file (copy .env.example → .env). Or export the
# same vars in your shell - either way these are what the deploy + seed need:
#   PROJECT               names your Worker + bucket, both label-cache-<PROJECT>
#   SEED_BASE             your deployed Worker URL (https://<worker>.workers.dev)
#   R2_ACCOUNT_ID         Cloudflare account id
#   R2_ACCESS_KEY_ID      R2 API token access key id
#   R2_SECRET_ACCESS_KEY  R2 API token secret
#   SPARQL_ENDPOINT       (optional) your triplestore, for `just bootstrap`
set dotenv-load := true

# One project = one Worker + one R2 bucket, both named `label-cache-<project>`,
# so two apps never share a bucket. Required by every Cloudflare recipe (bucket,
# deploy, upload, seed-remote, seed-public, bootstrap). Set it once in .env
# (PROJECT=orders) or per-run: `just project=orders deploy`.
project := env_var_or_default("PROJECT", "")

# Package manager. Examples use pnpm (recommended - the committed pnpm-lock.yaml
# gives reproducible, age-pinned installs), but npm and bun work too. Override for
# a whole run: `just pm=npm bootstrap`, `just pm=bun deploy`. `run` is the matching
# binary-runner for local tools like wrangler (pnpm exec / npx / bunx).
pm := "pnpm"
package := if pm == "pnpm" { "corepack pnpm" } else { pm }
run := if pm == "npm" { "npx" } else if pm == "bun" { "bunx" } else { "corepack pnpm exec" }

default: dev

# Fill in .env first (SPARQL_ENDPOINT + R2 creds), then: just bootstrap
# Pass an endpoint to override SPARQL_ENDPOINT: just bootstrap https://other/sparql
# Prefer to go step by step? Run them individually: install, extract-labels,
# bucket, deploy, ingest, upload.
# One-shot: install → extract labels → create bucket → deploy → seed R2.
bootstrap ENDPOINT="":
    #!/usr/bin/env bash
    set -euo pipefail
    P="{{project}}"; : "${P:?set project=<name> (e.g. just project=orders bootstrap) or PROJECT in .env}"
    EP="{{ENDPOINT}}"; EP="${EP:-${SPARQL_ENDPOINT:-}}"
    : "${EP:?pass an endpoint (just bootstrap <url>) or set SPARQL_ENDPOINT in .env}"
    just pm={{pm}} install
    just extract-labels "$EP"
    just pm={{pm}} project="$P" bucket
    just pm={{pm}} project="$P" deploy
    just ingest
    just pm={{pm}} project="$P" upload
    echo "✓ done - labels are live at ${SEED_BASE:-your Worker URL}"

# Install dependencies.
install:
    {{package}} install

# Local dev server. ENVIRONMENT override enables /dev/seed locally
# (the [vars] default is "production", which disables seeding).
dev:
    {{run}} wrangler dev --var ENVIRONMENT:development

# Run the demo UI locally, seed local R2, and keep the server attached. Stop with Ctrl-C.
demo-local:
    #!/usr/bin/env bash
    set -euo pipefail
    PORT="${PORT:-8787}"
    if curl -sf -o /dev/null "http://localhost:$PORT/namespaces"; then
        echo "ERROR: http://localhost:$PORT is already serving a Worker; choose another port (PORT=8790 just demo-local)." >&2
        exit 1
    fi
    {{run}} wrangler dev --config demo/wrangler.demo.toml --var ENVIRONMENT:development --port "$PORT" &
    PID=$!
    cleanup() { kill "$PID" 2>/dev/null || true; }
    trap cleanup EXIT INT TERM
    echo "waiting for local demo Worker on :$PORT..."
    for _ in $(seq 1 60); do
        if ! kill -0 "$PID" 2>/dev/null; then
            wait "$PID"
            exit $?
        fi
        if curl -sf -o /dev/null "http://localhost:$PORT/namespaces"; then break; fi
        sleep 1
    done
    if ! curl -sf -o /dev/null "http://localhost:$PORT/namespaces"; then
        echo "ERROR: local demo Worker did not become ready within 60 seconds." >&2
        exit 1
    fi
    curl -fsS "http://localhost:$PORT/dev/seed"
    echo
    sed "s|__LABEL_CACHE_ORIGIN__|http://localhost:$PORT|g" demo/seed/widget.ndjson \
        | curl -fsS -X POST --data-binary @- "http://localhost:$PORT/dev/load"
    echo
    echo "Demo ready: http://localhost:$PORT/ (playground: /demo)"
    wait "$PID"

# Build + serve YOUR labels locally - no Cloudflare account, no deploy. Point at a
# Turtle file (full instance data OR labels-only; non-label triples are ignored) or
# a SPARQL endpoint, and this wires up extraction, ingest, and an in-memory local R2
# so your app can hit http://localhost:$PORT/label?iri=... and get your labels back -
# the exact same Worker path production runs (edge -> R2 -> 404).
#   just dev-local                             # ingest ./data.ttl
#   INPUT=my.ttl just dev-local
#   ENDPOINT=https://my-endpoint/sparql just dev-local   # extract -> data.ttl first
#   PUBLIC=1 just dev-local                    # also load the bundled public vocab labels
# Stop with Ctrl-C. Override the port with PORT=8790.
dev-local:
    #!/usr/bin/env bash
    set -euo pipefail
    PORT="${PORT:-8787}"
    if curl -sf -o /dev/null "http://localhost:$PORT/namespaces"; then
        echo "ERROR: http://localhost:$PORT is already serving a Worker; choose another port (PORT=8790 just dev-local)." >&2
        exit 1
    fi
    BASE="http://localhost:$PORT"
    TTL="${INPUT:-data.ttl}"
    EP="${ENDPOINT:-}"
    # A SPARQL endpoint is extracted to the Turtle file first (scripts/extract-labels.rq).
    if [ -n "$EP" ]; then
        just pm={{pm}} extract-labels "$EP" "$TTL"
    fi
    if [ ! -f "$TTL" ]; then
        echo "ERROR: no '$TTL' - pass input=<file.ttl> or endpoint=<sparql-url>." >&2
        exit 1
    fi
    # Local dev Worker: in-memory Miniflare R2, /dev/load enabled by the development
    # ENVIRONMENT override. Same invocation as `just dev`.
    {{run}} wrangler dev --var ENVIRONMENT:development --port "$PORT" &
    PID=$!
    cleanup() { kill "$PID" 2>/dev/null || true; }
    trap cleanup EXIT INT TERM
    echo "waiting for local Worker on :$PORT..."
    for _ in $(seq 1 60); do
        if ! kill -0 "$PID" 2>/dev/null; then wait "$PID"; exit $?; fi
        if curl -sf -o /dev/null "http://localhost:$PORT/namespaces"; then break; fi
        sleep 1
    done
    if ! curl -sf -o /dev/null "http://localhost:$PORT/namespaces"; then
        echo "ERROR: local Worker did not become ready within 60 seconds." >&2
        exit 1
    fi
    # Optional: the bundled public vocabularies (rdfs/skos/owl/... your data may
    # reference but not label itself). Loaded FIRST so your own labels below win any
    # (IRI, language) overlap - /dev/load overwrites by key.
    if [ -n "${PUBLIC:-}" ]; then
        SEED_BASE="$BASE" node scripts/ingest.mjs
        curl -fsS -X POST --data-binary @dist/seed/manifest.ndjson "$BASE/dev/load" >/dev/null
        echo "loaded bundled public vocab"
    fi
    # Your labels: extract annotation triples from the dump into a manifest (each
    # object's @context baked to the local origin), then load into R2. The manifest
    # also carries context/labels-v1.json, so /context resolves locally too.
    SEED_BASE="$BASE" node scripts/ingest.mjs --input "$TTL"
    curl -fsS -X POST --data-binary @dist/seed/manifest.ndjson "$BASE/dev/load"
    echo
    echo "Ready: your labels are live at $BASE/label?iri=<encoded-iri>"
    wait "$PID"

typecheck:
    {{run}} tsc --noEmit

# Rebuild the self-hosted N3 browser bundle for the demo page (demo/public/vendor/n3.mjs).
# Run after bumping `n3` or `esbuild` in package.json; commit the regenerated file.
vendor-n3:
    ./scripts/vendor-n3.sh

# Seed the LOCAL (Miniflare) R2 bucket.
seed:
    curl -s http://localhost:8787/dev/seed | jq

# --- deploy ---

login:
    {{run}} wrangler login

# Create this project's R2 bucket (one-time). Requires project=<name>.
bucket:
    #!/usr/bin/env bash
    set -euo pipefail
    P="{{project}}"; : "${P:?set project=<name> (e.g. just project=orders bucket) or PROJECT in .env}"
    # `wrangler r2 bucket list` has no --json output, so parse the `name:` lines
    # and exact-match: a substring test would let e.g. label-cache-foo-staging
    # shadow label-cache-foo and silently skip creation.
    BUCKETS="$({{run}} wrangler r2 bucket list | awk '$1 == "name:" { print $2 }')"
    if grep -Fxq "label-cache-$P" <<<"$BUCKETS"; then
        echo "R2 bucket label-cache-$P already exists"
    else
        {{run}} wrangler r2 bucket create "label-cache-$P"
    fi

# Generate .wrangler.gen.toml for `project` from wrangler.toml, rewriting the
# Worker name + bound bucket to label-cache-<project>. The R2 binding can't read
# an env var, so real deploys go through this templated config. Private helper.
_gen:
    #!/usr/bin/env bash
    set -euo pipefail
    P="{{project}}"; : "${P:?set project=<name> (e.g. just project=orders deploy) or PROJECT in .env}"
    sed -E 's/^name = ".*"/name = "label-cache-'"$P"'"/; s/^bucket_name = ".*"/bucket_name = "label-cache-'"$P"'"/' \
        wrangler.toml > .wrangler.gen.toml

# Deploy this project's Worker (label-cache-<project>). Requires project=<name>.
deploy: _gen
    {{run}} wrangler deploy -c .wrangler.gen.toml

# Install the purge token as a Worker secret. Generate it first, for example:
#   export PURGE_TOKEN="$(openssl rand -base64 48)"
# Store the same token in the secret manager used by your seed job.
purge-token-set: _gen
    #!/usr/bin/env bash
    set -euo pipefail
    : "${PURGE_TOKEN:?set a random PURGE_TOKEN before running this recipe}"
    printf '%s' "$PURGE_TOKEN" | {{run}} wrangler secret put PURGE_TOKEN -c .wrangler.gen.toml

# Seed the REAL R2 bucket via a throwaway --remote dev server, so no
# seeding endpoint is exposed in production. Pass your deployed base URL, e.g.
#   just project=orders seed-remote https://label-cache-orders.<subdomain>.workers.dev
seed-remote BASE: _gen
    #!/usr/bin/env bash
    set -euo pipefail
    {{run}} wrangler dev --remote -c .wrangler.gen.toml --var ENVIRONMENT:development --port 8788 > /tmp/lc-remote.log 2>&1 &
    PID=$!
    trap "kill $PID 2>/dev/null || true" EXIT
    echo "waiting for remote dev server..."
    for i in $(seq 1 60); do curl -sf -o /dev/null "http://localhost:8788/namespaces" && break; sleep 1; done
    curl -s "http://localhost:8788/dev/seed?base={{BASE}}" | jq

# --- your own labels ---

# Extract label + description triples for every IRI your data uses from a SPARQL
# endpoint (runs scripts/extract-labels.rq), saving Turtle to data.ttl. e.g.
#   just extract-labels https://my-endpoint/sparql
extract-labels ENDPOINT OUT="data.ttl":
    #!/usr/bin/env bash
    set -euo pipefail
    curl -sf "{{ENDPOINT}}" \
        --data-urlencode query@scripts/extract-labels.rq \
        -H "Accept: text/turtle" \
        -o "{{OUT}}"
    echo "wrote {{OUT}} ($(wc -l < "{{OUT}}" | tr -d ' ') lines)"

# Build the R2 manifest from your dump → dist/seed/manifest.ndjson
ingest INPUT="data.ttl":
    node scripts/ingest.mjs --input {{INPUT}}

# Upload the manifest to R2 (needs project=<name> + R2_* env vars - see the guide).
upload:
    #!/usr/bin/env bash
    set -euo pipefail
    P="{{project}}"; : "${P:?set project=<name> (e.g. just project=orders upload) or PROJECT in .env}"
    R2_BUCKET="label-cache-$P" node scripts/upload-seed.mjs

# --- public ontology labels ---

# No args = all bundled vocabularies (rdf, rdfs, owl, skos, dcterms, dcat,
# schema) - a few thousand terms total, small even with schema.org, so there's
# no harm seeding the lot. Or pass a comma list for only those: seed-public
# skos,rdf,rdfs. Additive to your own labels in R2 - run before or after ingest.
# Seed PUBLIC vocabulary labels into R2 (all, or a chosen subset).
seed-public NAMESPACES="":
    #!/usr/bin/env bash
    set -euo pipefail
    P="{{project}}"; : "${P:?set project=<name> (e.g. just project=orders seed-public) or PROJECT in .env}"
    : "${SEED_BASE:?set SEED_BASE (your deployed Worker URL, for the embedded @context)}"
    if [ -n "{{NAMESPACES}}" ]; then
        node scripts/ingest.mjs --only "{{NAMESPACES}}"
    else
        node scripts/ingest.mjs
    fi
    R2_BUCKET="label-cache-$P" node scripts/upload-seed.mjs

# Runs scripts/coverage-report.rq; heed its warning about large datasets. Pass
# an endpoint or set SPARQL_ENDPOINT in .env.
# Report namespaces your data USES but doesn't LABEL - a shopping list for seed-public.
coverage-report ENDPOINT="":
    #!/usr/bin/env bash
    set -euo pipefail
    EP="{{ENDPOINT}}"; EP="${EP:-${SPARQL_ENDPOINT:-}}"
    : "${EP:?pass an endpoint (just coverage-report <url>) or set SPARQL_ENDPOINT in .env}"
    curl -sf "$EP" \
        --data-urlencode query@scripts/coverage-report.rq \
        -H "Accept: text/csv" | column -t -s,

# Smoke-test a deployed instance. Pass the base URL.
demo BASE:
    #!/usr/bin/env bash
    set -euo pipefail
    enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1"; }
    echo "# /namespaces";  curl -s "{{BASE}}/namespaces" | jq -c '.namespaces | length as $n | "\($n) namespaces"'
    # bundled public vocab is untagged, so no ?lang= -> resolves the `und` key
    echo "# skos:Concept"; curl -s "{{BASE}}/label?iri=$(enc 'http://www.w3.org/2004/02/skos/core#Concept')" | jq
    echo "# owl:Class";    curl -s "{{BASE}}/label?iri=$(enc 'http://www.w3.org/2002/07/owl#Class')" | jq
    echo "# context";      curl -s "{{BASE}}/context/labels-v1.json" | jq -c '.["@context"] | keys | "\(length) prefixes/terms"'
