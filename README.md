# rdf-label-cache

A globally distributed, low-latency HTTP service for resolving human-readable
**labels for RDF IRIs**. One Cloudflare Worker, one R2 bucket, edge-cached. No
database, no auth, no middleware - the Worker either finds a pre-materialized
label in R2 or returns 404.

Curated public namespaces (rdfs, owl, skos, dc/dcterms, schema.org, foaf, prov,
void, xsd, rdf, …) are served as JSON-LD. Self-host it with your own labels by
pointing it at your own R2 bucket.

## API

```
GET /label?iri={encoded_iri}          # untagged label (labels/und/{iri})
GET /label?iri={encoded_iri}&lang=en  # a specific language (labels/en/{iri})
GET /namespaces                       # static known-prefix registry
GET /context/labels-v1.json           # shared JSON-LD context
```

Public read routes support CORS (`GET`, `HEAD`, and `OPTIONS`). The registry is
not an inventory of labels present in a particular R2 bucket.

Example:

```bash
curl "https://<host>/label?iri=http%3A%2F%2Fwww.w3.org%2F2004%2F02%2Fskos%2Fcore%23Concept"
# → { "@context": ".../context/labels-v1.json",
#     "@id": "http://www.w3.org/2004/02/skos/core#Concept",
#     "prefLabel": { "@none": "Concept" }, "definition": { "@none": "An idea …" } }
```

See [`docs/architecture.md`](docs/architecture.md) for the full design, and
[`docs/FAQ.md`](docs/FAQ.md) for design rationale (including why "one request per label"
is fine over HTTP/2/3).

## Develop

> Requires **Node 22+**, **pnpm** (or npm/bun), and **just** for the recipe-based
> deployment path. Examples use **pnpm** - recommended, since the committed `pnpm-lock.yaml` gives
> reproducible, age-pinned installs - but **npm** and **bun** work too. Swap
> `pnpm install` → `npm install` / `bun install` and `pnpm wrangler …` →
> `npx wrangler …` / `bunx wrangler …`; the `node scripts/…` commands are identical on
> all three. For the `just` recipes, name your manager once and it threads through:
> `just pm=npm bootstrap`.

```bash
pnpm install
pnpm dev          # wrangler dev on :8787 (local emulated R2)
just seed         # or: curl -s localhost:8787/dev/seed   - load sample labels
pnpm test         # vitest suite (runs handlers on the real Workers runtime)
pnpm typecheck
```

`/dev/seed` is disabled when `ENVIRONMENT=production`; `pnpm dev` overrides it to
`development` so seeding works locally.

To run the landing page and playground with seeded local R2 in one command:

```bash
just demo-local
```

It starts the demo asset configuration, waits for the Worker, seeds it plus the
committed widget-label fixture, and serves the landing page at
`http://localhost:8787/` (`/demo` is the playground).
If that port is occupied, use `PORT=8790 just demo-local`.

### Try it with your own data — no deploy

Point the service at your own RDF and hit it locally, running the *same* Worker
path production does (edge → R2 → 404) — no Cloudflare account, no deploy:

```bash
just dev-local                                     # ingests ./data.ttl
INPUT=my.ttl just dev-local                         # a different Turtle file
ENDPOINT=https://my-endpoint/sparql just dev-local  # extract from SPARQL first
PUBLIC=1 just dev-local                             # also load bundled public vocab
```

The input can be a **full instance-data dump or a labels-only file** — non-label
triples are ignored. Extraction keeps only the label/description predicates
(`skos:prefLabel`, `rdfs:label`, `dcterms:title`, `schema:name`; `skos:definition`,
`rdfs:comment`, `dcterms:description`, `schema:description` by default). Override per
run with `ingest.mjs --label-preds`/`--desc-preds` (comma-separated IRIs; list order
sets precedence when a subject carries several). Your app then resolves labels at
`http://localhost:8787/label?iri=…`, and a genuine miss is a 404 — exactly as in
production. Local R2 persists between runs (`.wrangler/state`); re-running overwrites
by key, so changed labels update in place. Override the port with `PORT=8790`.

## Getting started

Cache the labels your app needs - your own IRIs plus the public-vocabulary terms
your data uses - in five steps. Nothing ships pre-loaded; you populate R2 once.

**1. Clone & install**

```bash
git clone https://github.com/recalcitrantsupplant/rdf-label-cache && cd rdf-label-cache
pnpm install
```

**2. Dump the annotation properties you want cached**

From your triplestore, `CONSTRUCT` the labels/descriptions for every IRI your data
uses, and save the result as `data.ttl`:

```sparql
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX schema: <https://schema.org/>
CONSTRUCT { ?iri rdfs:label ?l ; rdfs:comment ?c ; skos:prefLabel ?p ; skos:definition ?d ;
            dcterms:title ?t ; dcterms:description ?desc ; schema:name ?n }
WHERE {
  { SELECT DISTINCT ?iri WHERE {
      { ?iri ?px ?ox } UNION { ?sx ?iri ?ox } UNION { ?sx ?px ?iri FILTER(isIRI(?iri)) } } }
  OPTIONAL { ?iri rdfs:label ?l }     OPTIONAL { ?iri rdfs:comment ?c }
  OPTIONAL { ?iri skos:prefLabel ?p } OPTIONAL { ?iri skos:definition ?d }
  OPTIONAL { ?iri dcterms:title ?t }  OPTIONAL { ?iri dcterms:description ?desc }
  OPTIONAL { ?iri schema:name ?n }
  FILTER(BOUND(?l)||BOUND(?c)||BOUND(?p)||BOUND(?d)||BOUND(?t)||BOUND(?desc)||BOUND(?n))
}
```

This grabs both your own entities' labels and any public-vocabulary terms your data
references. Any RDF file works - no triplestore required for small data. Prefer whole
public vocabularies instead? Run `pnpm seed:ingest` with no `--input`.

**3. Set up Cloudflare**

Pick a **project name** — your Worker and bucket are both named
`label-cache-<project>`, so each app gets its own isolated instance. With `just`
it threads through everything (`project=orders`, or `PROJECT=orders` in `.env`):

```bash
just project=orders bucket                    # create bucket label-cache-orders
just project=orders deploy                    # prints your Worker URL
export PURGE_TOKEN="$(openssl rand -base64 48)"
just project=orders purge-token-set           # required before a data refresh
```

Raw shell instead? Set the same name as `name` and `bucket_name` in
`wrangler.toml`, then `pnpm wrangler r2 bucket create label-cache-orders` and
`pnpm wrangler deploy`.

No namespace registration needed - the Worker keys R2 by the full IRI, so **any**
namespace resolves once its labels are uploaded. Then create an **R2 API token**
(dashboard → R2 → Manage API Tokens) for the next step.

**4. Generate & upload your label objects**

```bash
export SEED_BASE=https://label-cache-orders.<subdomain>.workers.dev
export R2_BUCKET=label-cache-orders
export R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
node scripts/ingest.mjs --input data.ttl     # → dist/seed/manifest.ndjson
node scripts/upload-seed.mjs                  # → R2, over the S3 API
```

(With `just`: `just project=orders ingest upload` sets `R2_BUCKET` for you.)

Objects are keyed lang-first by the full IRI (`labels/und/https://schema.org/name`,
`labels/en/http://purl.org/dc/terms/title`) - browsable in R2, each language a listable
prefix, and any namespace resolves without configuration.

**5. Consume from your app**

Resolve any cached IRI over plain HTTP. Request all the labels a view needs **in
parallel** - they're independent, edge-cached `GET`s that multiplex over HTTP/2/3
(see [`docs/FAQ.md`](docs/FAQ.md)):

```js
const labels = Object.fromEntries(await Promise.all(
  iris.map(async (iri) => {
    // no ?lang= -> the untagged label; add &lang=xx for a specific language
    const res = await fetch(`${BASE}/label?iri=${encodeURIComponent(iri)}`);
    const m = res.ok ? (await res.json()).prefLabel : null;
    return [iri, m ? (m["@none"] ?? Object.values(m)[0]) : null];
  }),
));
```

`?lang=` maps straight to a key (`labels/en/{iri}`); no `?lang=` returns the untagged label
(`labels/und/{iri}`). There's no server-side language fallback — if your data mixes tagged and
untagged labels, try one then the other client-side (a second cheap, cached call).

How to call the service well — parallel requests, client vs. edge caching, running one
instance for many apps: [`docs/consuming.md`](docs/consuming.md). Full runbook:
[`docs/DEPLOY.md`](docs/DEPLOY.md). Rationale &amp; the alternatives this replaces: the
demo's **Why RDF Label Cache?** page.

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

## Contributing

Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). In short: fork, branch,
open a PR, and use [Conventional Commits](https://www.conventionalcommits.org/) (enforced
by commitlint on every PR and by a local husky hook). CI must be green — run
`./scripts/ci.sh` (typecheck + tests) before pushing.

## License

Licensed under the [Apache License 2.0](LICENSE). Security reports follow the
private process in [SECURITY.md](SECURITY.md).

## Roadmap

Tracked in [`docs/architecture.md` §7](docs/architecture.md#7-open-questions--future-work).
Headline items:

- **One-click onboarding** — a *Deploy to Cloudflare* button (+ template repo / C3) to stand
  up the Worker and bucket from a CF account alone, then a guided two-path seed (drop RDF in a
  folder, or point at a SPARQL endpoint), each with an optional public-ontology top-up.
- **Native authentication for private deployments** — built-in access control so a private
  label set can protect itself without a platform auth layer in front (today auth is
  delegated to the edge; see [`docs/architecture.md` §6.4](docs/architecture.md#64-protecting-a-private-deployment-auth)).
- **Bulk resolution** (`POST /labels`) scoped to cold server-to-server jobs — per-IRI
  `GET` stays the cache-optimized hot path.
- **Label search**, a canonical **`/.well-known/prefixes`** endpoint, and **context
  versioning** for a future v2 context.

## Demo (maintainer-only)

The public demo at `label-cache-demo.<subdomain>.workers.dev` is deployed
automatically on release from `demo/wrangler.demo.toml`, via
`.github/workflows/release.yml` / `deploy-demo.yml`. **You don't need any of
this to use or self-host the project** - the demo workflows are guarded to the
maintainer's account (`github.repository_owner`) and require Cloudflare secrets
forks don't have, so they're inert in clones.
