# rdf-label-cache

A globally distributed, low-latency HTTP service for resolving human-readable
**labels for RDF IRIs**. One Cloudflare Worker, one R2 bucket, edge-cached. The
public read path has no database or middleware: the Worker either finds a
pre-materialized label in R2 or returns 404. Private data requires an auth layer;
see [`docs/architecture.md` section 6.4](docs/architecture.md#64-protecting-a-private-deployment-auth).

The maintained public seed covers RDF, RDFS, OWL, SKOS, DCTERMS, DCAT, and
Schema.org. Self-host it with your own labels by pointing it at your own R2
bucket.

**▶ Live demo: https://label-cache-demo.dhabgood.workers.dev/**

**Deploy your own** (Worker + R2 bucket, from a Cloudflare account alone), then
seed your labels from a GitHub Action — no clone, no local tooling. Steps:
[Get started fast](#get-started-fast).

## API

```
GET /label?iri={encoded_iri}          # untagged label (labels/und/{iri})
GET /label?iri={encoded_iri}&lang=en  # a specific language (labels/en/{iri})
GET /context/labels-v1.json           # shared JSON-LD context
```

Public read routes support CORS (`GET`, `HEAD`, and `OPTIONS`).

Example:

```bash
curl "https://<host>/label?iri=http%3A%2F%2Fwww.w3.org%2F2004%2F02%2Fskos%2Fcore%23Concept"
# → { "@context": ".../context/labels-v1.json",
#     "@id": "http://www.w3.org/2004/02/skos/core#Concept",
#     "label": { "@none": "Concept" }, "definition": { "@none": "An idea …" } }
# Each source predicate is kept under its own term (label/prefLabel/title/name/…),
# never coerced to prefLabel; the consumer picks a preference order.
```

See [`docs/architecture.md`](docs/architecture.md) for the current architecture
and [`docs/FAQ.md`](docs/FAQ.md) for design rationale.

## Run your own

Two ways to stand up your own instance — pick by data size and how much local
tooling you want. Both end the same way: your labels in your own R2 bucket, served
edge-cached. Nothing ships pre-loaded; you populate R2 once.

| | Get started fast | Larger datasets |
|---|---|---|
| **Seeding runs in** | GitHub Actions (browser only) | Your machine or your own CI |
| **Local tooling** | None¹ | Node 22+, pnpm, `just` |
| **Add your labels** | Drop RDF into the `labels/` folder, run the **seed-labels** workflow | `just` pipeline from a file or SPARQL endpoint |
| **Best for** | Vocabularies, small/modest label sets, trying it out | Large label sets, frequent refreshes, robust sync | 
| **Projects** | One label cache per repo | Many, via `just project=<name>` |
| **Full steps** | [below](#get-started-fast) | [below](#larger-datasets) · [DEPLOY.md](docs/DEPLOY.md) |

### Get started fast

No clone, no local Node — deploy from the browser, then seed from a GitHub Action.

[![Deploy to Cloudflare](docs/deploy-to-cloudflare.svg)](https://deploy.workers.cloudflare.com/?url=https://github.com/recalcitrantsupplant/rdf-label-cache)

**1. Deploy the Worker + R2 bucket.** Click the button. Cloudflare provisions the
Worker and its R2 bucket from `wrangler.toml` and **clones this repo into your own
GitHub** — that clone is where you do the rest. It comes up **empty**: every
`/label` 404s until you seed (steps 3–4). *(No button? A one-time
`just project=<you> deploy` from a local clone stands up the same thing.)*

**2. Add your Cloudflare credentials to the repo** — **Settings → Secrets and
variables → Actions**:

| Kind | Name | Value |
|---|---|---|
| Variable | `SEED_BASE` | your deployed Worker URL (`https://…workers.dev`) |
| Variable | `R2_BUCKET` | the bucket the button created |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account id (`wrangler whoami`, or the dashboard) |
| Secret | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | an R2 API token (dashboard → R2 → Manage API Tokens) |
| Secret | `PURGE_TOKEN` | a random value — **also** add it as a *Worker* secret (dashboard → your Worker → Settings → Variables) so purges are accepted |

**3. Add your labels.** Drop RDF files (Turtle/N-Triples/…) into the
[`labels/`](labels/) folder and commit. A full instance-data dump is fine — only
label/description triples are extracted. See [`labels/README.md`](labels/README.md).

**4. Run the seed.** **Actions → seed-labels → Run workflow.** It ingests `labels/`,
uploads to R2, and purges the edge. Tick **include common ontology labels** to also
seed the bundled vocabularies (rdf, rdfs, owl, skos, dcterms, dcat, schema.org).
Re-run any time you change `labels/`.

Then [consume from your app](#consume-from-your-app) — the same for both paths.

**Limitations of the fast path** — uploads run through GitHub Actions, so it's for
**small/modest RDF** (vocabs, a few thousand terms), not large or high-frequency
loads. Runners have no VPN (a private SPARQL endpoint isn't reachable), and labels
you commit live in git history. Re-running is an **upsert, not a mirror**: new and
changed labels are written in place, but a label you remove from source is *not*
deleted from R2. For large label sets, or more robust synchronisation than a GitHub
Action, use the clone + pipeline path.

¹ The Worker itself is deployed by the button (or one `deploy` command); "no local
tooling" refers to the seeding, which runs entirely in GitHub Actions thereafter.

### Larger datasets

The **clone + pipeline path**: cache the labels your app needs - your own IRIs plus
the public-vocabulary terms your data uses - in four steps, with full control over
concurrency, credentials, and multiple projects (`just project=<name>`).

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
references. Any RDF file works - no triplestore required for small data. Want to
include common ontology labels (DCAT, SKOS etc.) as well? Run `just seed-public`.

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
# SEED_BASE + R2_* from your .env (copy env.example); project sets R2_BUCKET
just ingest                    # data.ttl → dist/seed/manifest.ndjson
just project=orders upload     # → R2, over the S3 API
```

Raw shell instead? `SEED_BASE=… R2_BUCKET=… CLOUDFLARE_ACCOUNT_ID=… R2_ACCESS_KEY_ID=…
R2_SECRET_ACCESS_KEY=… node scripts/ingest.mjs --input data.ttl && node
scripts/upload-seed.mjs`.

Objects are keyed lang-first by the full IRI (`labels/und/https://schema.org/name`,
`labels/en/http://purl.org/dc/terms/title`) - browsable in R2, each language a listable
prefix, and any namespace resolves without configuration.

### Consume from your app

Once seeded (either path), use the zero-dependency client. It resolves in
parallel, de-duplicates in-flight lookups, lets the browser use its HTTP cache,
and uses a bounded memo cache for server-side callers:

```bash
pnpm add @rdf-label-cache/client
```

```js
import { createLabelClient } from "@rdf-label-cache/client";

const labelClient = createLabelClient({ base: BASE });
labelClient.preconnect(); // browser only; safe to omit elsewhere
const labels = await labelClient.resolveMany(iris);
```

The service still uses plain HTTP: use `fetch` directly if you do not want a
dependency. `?lang=en` maps to `labels/en/{iri}`; omitting `?lang` returns the
untagged label at `labels/und/{iri}`. Language fallback is a client concern.

How to call the service well — parallel requests, client vs. edge caching, running one
instance for many apps: [`docs/consuming.md`](docs/consuming.md). Full runbook:
[`docs/DEPLOY.md`](docs/DEPLOY.md). Rationale &amp; the alternatives this replaces: the
demo's **Why RDF Label Cache?** page.

## Develop

> Requires **Node 22+**, **pnpm**, and **just** for the recipe-based deployment
> path. Examples and CI use **pnpm**, and the committed `pnpm-lock.yaml` gives
> reproducible installs. The underlying Node and Wrangler commands can also be
> adapted to npm or Bun. Swap
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
(`skos:prefLabel`, `rdfs:label`, `dcterms:title`, `schema:name`, `skos:altLabel`;
`skos:definition`, `rdfs:comment`, `dcterms:description`, `schema:description` by
default), **each stored under its own JSON-LD term** — nothing is coerced to
prefLabel, and a subject keeps every value it carries (your app applies its own
preference order). Override the harvested set per run with `ingest.mjs
--label-preds`/`--desc-preds` (comma-separated IRIs). Your app then resolves labels at
`http://localhost:8787/label?iri=…`, and a genuine miss is a 404 — exactly as in
production. Local R2 persists between runs (`.wrangler/state`); re-running overwrites
by key, so changed labels update in place. Override the port with `PORT=8790`.

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

- **One-click onboarding** — the *Deploy to Cloudflare* button and file-folder
  [seed Action](#get-started-fast) ship today. A hosted SPARQL-endpoint seed mode
  and template/C3 entries remain future work.
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
