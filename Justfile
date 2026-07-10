# Recipes auto-load a `.env` file (copy .env.example → .env). Or export the
# same vars in your shell — either way these are what the deploy + seed need:
#   SEED_BASE             your deployed Worker URL (https://<worker>.workers.dev)
#   R2_ACCOUNT_ID         Cloudflare account id
#   R2_ACCESS_KEY_ID      R2 API token access key id
#   R2_SECRET_ACCESS_KEY  R2 API token secret
#   SPARQL_ENDPOINT       (optional) your triplestore, for `just bootstrap`
set dotenv-load := true

default: dev

# Fill in .env first (SPARQL_ENDPOINT + R2 creds), then: just bootstrap
# Pass an endpoint to override SPARQL_ENDPOINT: just bootstrap https://other/sparql
# Prefer to go step by step? Run them individually: install, extract-labels,
# bucket, deploy, ingest, upload.
# One-shot: install → extract labels → create bucket → deploy → seed R2.
bootstrap ENDPOINT="":
    #!/usr/bin/env bash
    set -euo pipefail
    EP="{{ENDPOINT}}"; EP="${EP:-${SPARQL_ENDPOINT:-}}"
    : "${EP:?pass an endpoint (just bootstrap <url>) or set SPARQL_ENDPOINT in .env}"
    just install
    just extract-labels "$EP"
    just bucket || true          # ignore "bucket already exists"
    just deploy
    just ingest
    just upload
    echo "✓ done — labels are live at ${SEED_BASE:-your Worker URL}"

# Install dependencies.
install:
    pnpm install

# Local dev server. ENVIRONMENT override enables /dev/seed locally
# (the [vars] default is "production", which disables seeding).
dev:
    pnpm wrangler dev --var ENVIRONMENT:development

typecheck:
    pnpm tsc --noEmit

# Seed the LOCAL (Miniflare) R2 bucket.
seed:
    curl -s http://localhost:8787/dev/seed | jq

# --- deploy ---

login:
    pnpm wrangler login

# Create the production R2 bucket (one-time).
bucket:
    pnpm wrangler r2 bucket create rdf-public-labels

deploy:
    pnpm wrangler deploy

# Seed the REAL R2 bucket via a throwaway --remote dev server, so no
# seeding endpoint is exposed in production. Pass your deployed base URL, e.g.
#   just seed-remote https://rdf-label-resolver.<subdomain>.workers.dev
seed-remote BASE:
    #!/usr/bin/env bash
    set -euo pipefail
    pnpm wrangler dev --remote --var ENVIRONMENT:development --port 8788 > /tmp/lc-remote.log 2>&1 &
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

# Upload the manifest to R2 (needs SEED_BASE + R2_* env vars — see the guide).
upload:
    node scripts/upload-seed.mjs

# Smoke-test a deployed instance. Pass the base URL.
demo BASE:
    #!/usr/bin/env bash
    set -euo pipefail
    enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1"; }
    echo "# /namespaces";  curl -s "{{BASE}}/namespaces" | jq -c '.namespaces | length as $n | "\($n) namespaces"'
    echo "# skos:Concept"; curl -s "{{BASE}}/label?iri=$(enc 'http://www.w3.org/2004/02/skos/core#Concept')" | jq
    echo "# owl:Class";    curl -s "{{BASE}}/label?iri=$(enc 'http://www.w3.org/2002/07/owl#Class')" | jq
    echo "# context";      curl -s "{{BASE}}/context/labels-v1.json" | jq -c '.["@context"] | keys | "\(length) prefixes/terms"'
