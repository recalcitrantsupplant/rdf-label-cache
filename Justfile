# Recipes auto-load a `.env` file (copy env.example → .env). Or export the
# same vars in your shell - either way these are what the deploy + seed need:
#   PROJECT               names your Worker + bucket, both label-cache-<PROJECT>
#   SEED_BASE             your deployed Worker URL (https://<worker>.workers.dev)
#   CLOUDFLARE_ACCOUNT_ID Cloudflare account id (also the R2 S3 endpoint host)
#   R2_ACCESS_KEY_ID      R2 API token access key id
#   R2_SECRET_ACCESS_KEY  R2 API token secret
#   SPARQL_ENDPOINT       (optional) your triplestore, for `just bootstrap`
#
# Recipes are thin: each one exports its settings and calls a script in
# scripts/ops/, which is where the actual logic lives (and stays runnable
# without `just`). scripts/pipeline/ holds the label pipeline itself - ingest,
# upload, and the SPARQL queries.
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

# Passed to every script; scripts/ops/lib.sh turns PM back into a runner and
# PROJECT into the label-cache-<project> bucket name.
env := "PM=" + pm + " PROJECT=" + quote(project)

default: dev

# Fill in .env first (SPARQL_ENDPOINT + R2 creds), then: just bootstrap
# Pass an endpoint to override SPARQL_ENDPOINT: just bootstrap https://other/sparql
# Prefer to go step by step? Run them individually: install, extract-labels,
# bucket, deploy, ingest, upload.
# One-shot: install → extract labels → create bucket → deploy → seed R2.
bootstrap ENDPOINT="":
    {{env}} scripts/ops/bootstrap.sh {{quote(ENDPOINT)}}

# Install dependencies.
install:
    {{package}} install

# Local dev server. ENVIRONMENT override enables /dev/seed locally
# (the [vars] default is "production", which disables seeding).
dev:
    {{run}} wrangler dev --var ENVIRONMENT:development

# Run the demo UI locally, seed local R2, and keep the server attached. Stop with
# Ctrl-C. Override the port with PORT=8790.
demo-local:
    {{env}} scripts/ops/demo-local.sh

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
    {{env}} scripts/ops/dev-local.sh

typecheck:
    {{run}} tsc --noEmit

# Rebuild the self-hosted N3 browser bundle for the demo page (demo/public/vendor/n3.mjs).
# Run after bumping `n3` or `esbuild` in package.json; commit the regenerated file.
vendor-n3:
    ./scripts/ops/vendor-n3.sh

# Rebuild the self-hosted client bundle for the demo page
# (demo/public/vendor/label-cache-client.mjs). Run after changing the client;
# commit the regenerated file.
vendor-label-client:
    ./scripts/ops/vendor-label-client.sh

# Publish the client library (@rdf-label-cache/client) to npm. Dry-run by default:
#   just publish-client            # build, test, show the tarball - publishes/bumps NOTHING
#   just publish-client live       # bump patch + publish  (0.1.0 -> 0.1.1)
#   just publish-client live minor # bump minor + publish  (0.1.0 -> 0.2.0)
# NORMAL FLOW is CI (.github/workflows/publish-client.yml on merge to main) - use
# this only for a preview or an emergency publish. See the script for the details.
publish-client MODE="dry" BUMP="patch":
    scripts/ops/publish-client.sh {{MODE}} {{BUMP}}

# Seed the LOCAL (Miniflare) R2 bucket.
seed:
    curl -s http://localhost:8787/dev/seed | jq

# --- deploy ---

login:
    {{run}} wrangler login

# Create this project's R2 bucket (one-time). Requires project=<name>.
bucket:
    {{env}} scripts/ops/bucket.sh

# Deploy this project's Worker (label-cache-<project>). Requires project=<name>.
# Generates .wrangler.gen.toml first (the R2 binding can't read an env var).
deploy:
    {{env}} scripts/ops/deploy.sh

# Install the purge token as a Worker secret. Generate it first, for example:
#   export PURGE_TOKEN="$(openssl rand -base64 48)"
# Store the same token in the secret manager used by your seed job.
purge-token-set:
    {{env}} scripts/ops/purge-token-set.sh

# Seed a deployed instance's REAL R2 with the public vocabularies via the
# production pipeline (ingest -> S3 upload -> purge). project=<name> sets the
# target bucket (label-cache-<project>); R2_* + PURGE_TOKEN come from .env. Pass
# your deployed base URL (drives the embedded @context), e.g.
#   just project=orders seed-remote https://label-cache-orders.<subdomain>.workers.dev
seed-remote BASE:
    {{env}} scripts/ops/seed-remote.sh {{quote(BASE)}}

# --- your own labels ---

# Extract label + description triples for every IRI your data uses from a SPARQL
# endpoint (runs scripts/pipeline/extract-labels.rq), saving Turtle to data.ttl. e.g.
#   just extract-labels https://my-endpoint/sparql
extract-labels ENDPOINT="" OUT="data.ttl":
    scripts/ops/extract-labels.sh {{quote(ENDPOINT)}} {{quote(OUT)}}

# Build the R2 manifest from your dump → dist/seed/manifest.ndjson
ingest INPUT="data.ttl":
    node scripts/pipeline/ingest.mjs --input {{INPUT}}

# Upload the manifest to R2 (needs project=<name> + R2_* env vars - see the guide).
upload:
    {{env}} scripts/ops/upload.sh

# --- public ontology labels ---

# No args = all bundled vocabularies (rdf, rdfs, owl, skos, dcterms, dcat,
# schema) - a few thousand terms total, small even with schema.org, so there's
# no harm seeding the lot. Or pass a comma list for only those: seed-public
# skos,rdf,rdfs. Additive to your own labels in R2 - run before or after ingest.
# Seed PUBLIC vocabulary labels into R2 (all, or a chosen subset).
seed-public NAMESPACES="":
    {{env}} scripts/ops/seed-public.sh {{quote(NAMESPACES)}}

# Runs scripts/pipeline/coverage-report.rq; heed its warning about large datasets.
# Pass an endpoint or set SPARQL_ENDPOINT in .env.
# Report namespaces your data USES but doesn't LABEL - a shopping list for seed-public.
coverage-report ENDPOINT="":
    scripts/ops/coverage-report.sh {{quote(ENDPOINT)}}

# Smoke-test a deployed instance. Pass the base URL.
demo BASE:
    scripts/ops/smoke-test.sh {{quote(BASE)}}
