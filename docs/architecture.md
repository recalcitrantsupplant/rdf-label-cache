# RDF Label Cache - Architecture Design Document

**Version:** 0.4 (draft)  
**Status:** Design / Pre-implementation  
**Platform:** Cloudflare Workers (Workers Cache) + R2

> **Caching:** this document reflects the move to **Workers Cache** - a platform-managed,
> regionally tiered cache in front of the Worker. See
> [2026-07-06-workers-cache-migration.md](./2026-07-06-workers-cache-migration.md) for the
> rationale, before/after, and migration checklist.
>
> **FAQ:** design rationale for common objections - notably "it's one request per label,
> isn't that slow?" - lives in [`FAQ.md`](./FAQ.md).

---

## 1. Overview

A globally distributed, low-latency HTTP service for resolving human-readable labels for RDF IRIs.

Serves a curated set of well-known public namespaces from R2, fronted by Workers Cache. The stack is intentionally minimal: one Worker, one R2 bucket, platform-managed cache. No databases, no auth, no middleware.

**Supported namespaces:** rdfs, owl, skos, skos-xl, dc, dcterms, schema.org, foaf, prov, void, xsd, rdf

**Self-hosting:** the repo is designed to be cloned and deployed as-is. Private label deployments load their own labels into their own R2 bucket alongside (or instead of) the public ones. There is no published R2 bootstrap bucket or release tarball; use the included ingestion and upload pipeline.

---

## 2. API

### 2.1 Label Resolution

```
GET /label?iri={encoded_iri}           - untagged label (the labels/und/{iri} key)
GET /label?iri={encoded_iri}&lang=en   - the en-tagged label (labels/en/{iri})
```

Language is a single value - one request, one language. Consumers requiring multiple languages make multiple parallel requests. The Worker does not merge responses.

**Response (200) - JSON-LD:**
```json
{
  "@context": "https://your-label-cache/context/labels-v1.json",
  "@id": "https://www.w3.org/2004/02/skos/core#Concept",
  "prefLabel": "Concept",
  "definition": "An idea or notion; a unit of thought."
}
```

The `@context` URL is a stable, heavily-cached document (see §4.2) that defines all prefix mappings and property aliases. Individual label responses are small - context is a URL reference, not inline.

**Response (404):**
```json
{
  "error": "not_found",
  "iri": "https://example.org/myontology#Thing",
  "message": "IRI not found. Deploy your own instance to serve private labels."
}
```

**Language fallback:** if `?lang=fr` resolves to a 404, the client receives 404. No automatic language fallback - the caller decides.

**Prefixes / CURIEs:** the service speaks only absolute `http(s)` IRIs. Prefix
expansion (`skos:Concept` → the full IRI) is a client-side concern; callers
resolve CURIEs before calling `/label`. The service exposes no prefix registry.

---

## 3. Architecture

### 3.1 Component Overview

```
Client
  │
  │ HTTPS
  ▼
┌─────────────────────────────────────────┐
│              Workers Cache              │  ← Platform-managed, tiered.
│  regional (near PoP) → upper (network)  │    Hits served WITHOUT invoking
│         keyed on full request URL       │    the Worker (no CPU billed).
└────────────────┬────────────────────────┘
                 │ miss
                 ▼
┌─────────────────────────────────────────┐
│           Cloudflare Worker             │  ← Routing only; no auth, no proxy.
│          (RDF Label Cache Worker)       │    Sets Cache-Control + Cache-Tag.
└──────────────────┬──────────────────────┘
                   │
                   ▼
             ┌──────────┐
             │    R2    │
             │  (blob)  │
             └──────────┘
```

### 3.2 Request Flow

```
1. Request arrives at Cloudflare edge
2. Workers Cache check (regional tier → upper tier), keyed on full request URL
   └── HIT  → return immediately (Worker not invoked)
   └── MISS → Worker invoked

3. Worker: parse ?iri=, extract ?lang=
4. Construct R2 key: labels/{lang}/{iri}  (lang defaults to `und` when no ?lang=)
5. r2.get(key)
   └── HIT  → stream response with Cache-Control + Cache-Tag; platform caches it
   └── MISS → 404
```

No fallback chain, no proxy, no external calls. The Worker either finds the object in R2 or returns 404. Caching is driven entirely by the response `Cache-Control` header - the Worker no longer calls `cache.match`/`cache.put` itself (see the migration doc).

---

## 4. Storage

### 4.1 R2 - Label Store

**Bucket:** per project, `label-cache-<project>` (the demo uses `label-cache-demo`).

#### Key structure

Keyed **lang-first** by the full IRI: `labels/{lang}/{iri}`. Namespace-agnostic, so any
namespace resolves without registration.

```
labels/en/{iri}          ← English            e.g. labels/en/http://purl.org/dc/terms/title
labels/fr/{iri}          ← French
labels/und/{iri}         ← untagged literal   e.g. labels/und/https://schema.org/name

context/labels-v1.json   ← shared JSON-LD context document
```

The Worker builds the key directly from `?iri=` + `?lang=` with no namespace lookup:
`labels/${lang || "und"}/${iri}`. **Lang-first is deliberate:** the lang segment is a
fixed, slash-free token, so it can never collide with the slashed IRI - an IRI ending
`/en` (untagged) and a base IRI requested with `?lang=en` stay distinct keys. It also makes
each language a **listable prefix**: `labels/fr/` is every French label, downloadable in bulk.

Language tags are stored **faithfully** - untagged literals stay untagged (`und`), tags are
preserved, nothing is coerced to a default. `?lang=en` reads `labels/en/{iri}`; **no** `?lang=`
reads `labels/und/{iri}`. There is **no cross-language fallback in the Worker** - one key, one
lookup, 404 if absent. Any fallback (try `und`, then `en`, …) is the client's choice, made
with extra calls - see the demo playground, which prefers the untagged label then falls back
to English.

> **Note:** the `wrangler r2 object put` CLI can't write these keys (it truncates `#` as a
> URL fragment and percent-decodes `%`). Seed via the R2 binding (`/dev/load` locally) or
> the S3 API (`scripts/upload-seed.mjs`), both of which store keys verbatim.

**Namespace dumps** (`namespaces/{ns}/*.json`) are omitted. Schema.org has ~2,500 terms; a full dump would be tens of MB and has no clear use case for per-IRI resolution. Use the ingestion pipeline output directly if bulk access is needed.

#### Object metadata

The current uploader writes JSON-LD bytes without compression and sets
`Content-Type: application/ld+json`. The Worker passes through R2 content
encoding metadata if a future uploader supplies it; compression is not a
current storage contract.

#### Object format - JSON-LD

```json
{
  "@context": "https://your-label-cache/context/labels-v1.json",
  "@id": "https://www.w3.org/2004/02/skos/core#Concept",
  "prefLabel": "Concept",
  "definition": "An idea or notion; a unit of thought."
}
```

With `@container: @language` declared in the context, single-language responses are plain strings - no array wrapping needed.

### 4.2 JSON-LD Context Document

Stored in R2 at `context/labels-v1.json`. Served with an immutable TTL. Version suffix (`-v1`) allows future breaking changes without invalidating existing objects - never mutate an existing versioned context URL, bump to `-v2` instead.

```json
{
  "@context": {
    "rdf":      "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "rdfs":     "http://www.w3.org/2000/01/rdf-schema#",
    "owl":      "http://www.w3.org/2002/07/owl#",
    "skos":     "http://www.w3.org/2004/02/skos/core#",
    "skosxl":   "http://www.w3.org/2008/05/skos-xl#",
    "dc":       "http://purl.org/dc/elements/1.1/",
    "dcterms":  "http://purl.org/dc/terms/",
    "schema":   "https://schema.org/",
    "xsd":      "http://www.w3.org/2001/XMLSchema#",
    "prov":     "http://www.w3.org/ns/prov#",
    "foaf":     "http://xmlns.com/foaf/0.1/",
    "void":     "http://rdfs.org/ns/void#",

    "label":      { "@id": "rdfs:label",      "@container": "@language" },
    "prefLabel":  { "@id": "skos:prefLabel",  "@container": "@language" },
    "altLabel":   { "@id": "skos:altLabel",   "@container": "@language" },
    "definition": { "@id": "skos:definition", "@container": "@language" },
    "comment":    { "@id": "rdfs:comment",    "@container": "@language" },
    "title":      { "@id": "dcterms:title",   "@container": "@language" },
    "name":       { "@id": "schema:name",     "@container": "@language" }
  }
}
```

### 4.3 Cache - Workers Cache

The primary cache layer. **Workers Cache** is a platform-managed, regionally tiered cache that sits *in front of* the Worker: a lower regional tier near the requester and an upper network-wide tier. Hits are served **without invoking the Worker**; cold PoPs are served from the upper tier instead of round-tripping to R2. Cache keys are the full request URL (IRI + lang param). Query validation rejects unknown and duplicate parameters; parameter ordering remains part of the key until a later canonical-URL design is adopted.

Caching is enabled via config (`[cache] enabled = true`) and driven by the response `Cache-Control` header. The Worker does **not** call `caches.default` - no manual `match`/`put`/`waitUntil`.

| Response type | Cache-Control |
|---|---|
| Label (found) | `public, max-age=3600, s-maxage=31536000` |
| 404 | `public, max-age=60` |
| Context document | `public, max-age=31536000, immutable` (versioned URL, content never changes) |

Every cacheable response also carries a scoped `Cache-Tag` header (`labels` for
label responses, `context` for the JSON-LD context).
Purge data tags on ontology refresh via `ctx.cache.purge({ tags: [...] })`. This
invalidates the Cloudflare edge only: the one-year browser cache is an accepted
static-RDF policy, so exceptional typo corrections require a new resource URL.

See [2026-07-06-workers-cache-migration.md](./2026-07-06-workers-cache-migration.md) for migration detail and open caveats (404 cacheability, plan/GA status, `compatibility_date`).

---

## 5. Cost Model

### Storage (R2)

| Content | Estimated size | Monthly cost |
|---|---|---|
| All supported namespaces, per-language objects | ~50MB | ~$0.001 |

Storage is not a cost concern.

### Requests and reads

Pricing below is a formula, not a traffic forecast, and was checked on
2026-07-16 against [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
and [R2 pricing](https://developers.cloudflare.com/r2/pricing/). Workers Cache
hits avoid Worker CPU and R2 reads, but they are still Worker requests.

| Plan / example | Workers request charge | R2 read charge at 10% cache miss | Total before CPU |
|---|---:|---:|---:|
| Free, at or below 100k requests/day | $0 | Usually within R2's 10M monthly free reads | $0 |
| Paid, 50M requests/month | $5 base + 40M × $0.30 = $17.00 | 5M reads, within free tier = $0 | $17.00 |
| Paid, 500M requests/month | $5 base + 490M × $0.30 = $152.00 | (50M - 10M) × $0.36 = $14.40 | $166.40 |

The Free plan has no base account charge, but enforces a 100k-request daily
limit. Paid-plan CPU is omitted because it depends on measured miss-path CPU;
R2 storage is normally inside its 10 GB free tier for this use case. Internet
egress is free for R2 Standard storage. Recalculate with the current prices
before relying on these examples.

---

## 6. Deployment

### 6.1 Worker Configuration (wrangler.toml)

```toml
# name + bucket_name are per-project: `just project=<name> deploy` rewrites both
# to label-cache-<name> via a generated .wrangler.gen.toml. Below are the defaults.
name = "label-cache-dev"
main = "src/index.ts"
compatibility_date = "2025-04-19"

[cache]
enabled = true

[[r2_buckets]]
binding = "PUBLIC_LABELS"
bucket_name = "label-cache-dev"

[vars]
ENVIRONMENT = "production"
```

No secrets, no KV, no D1. `[cache] enabled = true` turns on Workers Cache; confirm it is available on the account plan and stable on the pinned `compatibility_date` (see migration doc caveat 2).

### 6.2 Label Data Bootstrap

Run the included ingestion and upload pipeline. It produces the context and
label objects for the R2 bucket bound to the Worker; no public bucket or
release-tarball distribution channel exists today.

### 6.3 Adding Private Labels

Deploy your own instance. Load your private label objects into your R2 bucket using the same key structure. The Worker is namespace-agnostic - it constructs an R2 key from the IRI and retrieves whatever is there. No config changes needed.

### 6.4 Protecting a Private Deployment (Auth)

The Worker itself has no auth logic. For access control, put an auth layer in front at the platform level - no code changes to the Worker needed.

**Cloudflare:** Cloudflare Access in front of the Worker. Configure with any IdP (Entra, Okta, Google, GitHub). Enforces JWT validity and group/role claims at the edge before the Worker is invoked. Free tier covers most private deployments.

Other-cloud deployment support is parked. The service currently targets
Cloudflare because Workers Cache and R2 are material parts of its behavior and
cost model; do not treat the private-auth design as a portable implementation.

Per-namespace access control (user A can read namespace X but not Y) is deliberately out of scope. It requires Worker-level logic and a policy store, which reintroduces the complexity this design avoids. Deployers needing it should fork and extend.

### 6.5 Environments

| Environment | Purpose |
|---|---|
| `dev` (workers.dev) | Local development via `wrangler dev` |
| `staging` | Pre-production, separate R2 bucket |
| `production` | Custom domain, full caching |

### 6.6 Ontology Ingestion Pipeline

A GitHub Action runs on a schedule (or on demand) to refresh public namespace data:

```
1. Fetch authoritative ontology files (rdfs, owl, skos, dc, schema.org, foaf, prov, void)
2. Parse RDF (N-Triples or Turtle)
3. Extract label triples (rdfs:label, skos:prefLabel, skos:altLabel, dcterms:title,
   rdfs:comment, skos:definition, schema:name)
4. Group by IRI and language tag, preserving tags faithfully (untagged literals under `und`)
5. Serialise each group as JSON-LD referencing the context URL
6. Write label objects to R2 using the manifest keys
7. Verify `context/labels-v1.json` is byte-identical if it already exists;
   otherwise publish it. A changed context must use a new versioned path.
8. Purge `labels,context` through the authenticated Worker endpoint. The seed
   command fails when this purge fails.
```

---

## 7. Open Questions / Future Work

- **Bulk resolution** - `POST /labels` with an array of IRIs. Worker fetches each R2 key and concatenates pre-built objects into a JSON-LD array. No per-object processing needed. **Caveat:** an arbitrary batch is a near-unique cache key, so this bypasses per-IRI edge caching and moves work into Worker CPU - scope it to cold/bulk workloads; per-IRI `GET` over H2/H3 stays the hot path. See [`FAQ.md`](./FAQ.md) for the full rationale on the "one request per label" concern.
- **Native authentication for private deployments** - built-in access control so a private label set can be served without standing up a platform auth layer in front. Today auth is delegated entirely to the edge (Cloudflare Access, APIM, Lambda@Edge — see §6.4); a first-class option (e.g. a shared-secret / bearer-token check in the Worker, or signed URLs) would let a private deployment protect itself out of the box. Per-namespace access control stays out of scope (§6.4).
- **One-click onboarding (deploy, then seed).** Collapse "clone the repo and run five commands" into two clear phases:
  - **Phase 1 - deploy the service.** A *Deploy to Cloudflare* button in the README (alongside enabling **Use this template** and a C3 `npm create cloudflare -- --template …` entry) stands up the Worker and provisions the bound R2 bucket in the user's own account - from a Cloudflare account alone, no terminal. **Limitation to design around:** the button deploys *code + resources*, not *data*, so R2 comes up **empty** and every `/label` 404s until Phase 2. The button flow also creates a repo in the user's GitHub, which doubles as their clone for Phase 2. The README must make the seed step loud so nobody expects labels to appear by magic (we ship nothing pre-loaded by design).
  - **Phase 2 - seed the data.** Two first-class input paths, each ending in the existing `ingest` + `upload` sync to R2, and each with an **optional** public-ontology top-up (`seed-public`):
    - **Local RDF** - drop files in a `labels/` folder (labels-only, *or* full RDF we strip the label/description triples out of) → one recipe ingests the folder and uploads.
    - **SPARQL endpoint** - point us at an endpoint; `extract-labels` pulls the annotation triples, then the same ingest + upload path runs.
  - **Build vs. buy:** most of the pipeline already exists (`ingest.mjs --input` already strips labels from arbitrary RDF; `extract-labels.rq`; `upload-seed.mjs`; `seed-public`). The new work is the button/template/C3 wiring, a folder-based (multi-file) ingest convention, and a single guided `just` entry point per path.
- **Label search** - full-text search across all stored labels (IRI → label and label → IRI). Requires an index; out of scope for the initial Worker but a natural companion service.
- **`/.well-known/prefixes`** - canonical prefix map endpoint for tooling.
- **Context versioning** - when a v2 context is needed, determine migration path (rewrite all R2 keys vs dual-serve both versions during transition).
