default: dev

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

# Smoke-test a deployed instance. Pass the base URL.
demo BASE:
    #!/usr/bin/env bash
    set -euo pipefail
    enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1"; }
    echo "# /namespaces";  curl -s "{{BASE}}/namespaces" | jq -c '.namespaces | length as $n | "\($n) namespaces"'
    echo "# skos:Concept"; curl -s "{{BASE}}/label?iri=$(enc 'http://www.w3.org/2004/02/skos/core#Concept')" | jq
    echo "# owl:Class";    curl -s "{{BASE}}/label?iri=$(enc 'http://www.w3.org/2002/07/owl#Class')" | jq
    echo "# context";      curl -s "{{BASE}}/context/labels-v1.json" | jq -c '.["@context"] | keys | "\(length) prefixes/terms"'
