# rdf-label-resolver

A globally distributed, low-latency HTTP service for resolving human-readable
**labels for RDF IRIs**. One Cloudflare Worker, one R2 bucket, edge-cached. No
database, no auth, no middleware — the Worker either finds a pre-materialized
label in R2 or returns 404.

Curated public namespaces (rdfs, owl, skos, dc/dcterms, schema.org, foaf, prov,
void, xsd, rdf, …) are served as JSON-LD. Self-host it with your own labels by
pointing it at your own R2 bucket.

## API

```
GET /label?iri={encoded_iri}          # all-languages bundle
GET /label?iri={encoded_iri}&lang=en  # single language
GET /namespaces                       # list known namespaces
GET /namespaces/{prefix}              # describe one namespace
GET /context/labels-v1.json           # shared JSON-LD context
```

Example:

```bash
curl "https://<host>/label?iri=http%3A%2F%2Fwww.w3.org%2F2004%2F02%2Fskos%2Fcore%23Concept"
# → { "@context": ".../context/labels-v1.json",
#     "@id": "http://www.w3.org/2004/02/skos/core#Concept",
#     "prefLabel": { "en": "Concept" }, "definition": { "en": "An idea …" } }
```

See [`docs/architecture.md`](docs/architecture.md) for the full design, and
[`docs/FAQ.md`](docs/FAQ.md) for design rationale (including why "one request per label"
is fine over HTTP/2/3).

## Develop

```bash
pnpm install
pnpm dev          # wrangler dev on :8787 (local emulated R2)
just seed         # or: curl -s localhost:8787/dev/seed   — load sample labels
pnpm test         # vitest suite (runs handlers on the real Workers runtime)
pnpm typecheck
```

`/dev/seed` is disabled when `ENVIRONMENT=production`; `pnpm dev` overrides it to
`development` so seeding works locally.

## Self-host

1. Create an R2 bucket and set its name in `wrangler.toml`.
2. Load your label objects using the key layout in `docs/architecture.md` §4.1
   (or the sample seeder in `src/routes/dev-seed.ts` as a starting point).
3. `pnpm wrangler deploy`.

Full runbook: [`docs/DEPLOY.md`](docs/DEPLOY.md).

## CI / releases

- **CI** (`.github/workflows/ci.yml`) runs typecheck + tests on every push and PR.
  All logic lives in `scripts/` (`ci.sh`, `deploy-demo.sh`, …); workflows only
  set up the toolchain and call the scripts.
- **Releases** use [release-please](https://github.com/googleapis/release-please):
  push [Conventional Commits](https://www.conventionalcommits.org/) to `main`; it
  maintains a release PR, and merging it tags `vX.Y.Z` + cuts a GitHub Release.
- **Supply-chain**: Dependabot with a 7-day `cooldown` (won't adopt a release
  until it's a week old); commit messages linted by commitlint (+ a local husky
  hook).

## Demo (maintainer-only)

The public demo at `rdf-label-cache.<subdomain>.workers.dev` is deployed
automatically on release from `demo/wrangler.demo.toml`, via
`.github/workflows/release.yml` / `deploy-demo.yml`. **You don't need any of
this to use or self-host the project** — the demo workflows are guarded to the
maintainer's account (`github.repository_owner`) and require Cloudflare secrets
forks don't have, so they're inert in clones.
