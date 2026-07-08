# RDF Label Resolver — Architecture Design Document

**Version:** 0.4 (draft)  
**Status:** Design / Pre-implementation  
**Platform:** Cloudflare Workers (Workers Cache) + R2

> **Caching:** this document reflects the move to **Workers Cache** — a platform-managed,
> regionally tiered cache in front of the Worker. See
> [2026-07-06-workers-cache-migration.md](./2026-07-06-workers-cache-migration.md) for the
> rationale, before/after, and migration checklist.
>
> **FAQ:** design rationale for common objections — notably "it's one request per label,
> isn't that slow?" — lives in [`FAQ.md`](./FAQ.md).

---

## 1. Overview

A globally distributed, low-latency HTTP service for resolving human-readable labels for RDF IRIs.

Serves a curated set of well-known public namespaces from R2, fronted by Workers Cache. The stack is intentionally minimal: one Worker, one R2 bucket, platform-managed cache. No databases, no auth, no middleware.

**Supported namespaces:** rdfs, owl, skos, skos-xl, dc, dcterms, schema.org, foaf, prov, void, xsd, rdf

**Self-hosting:** the repo is designed to be cloned and deployed as-is. Private label deployments load their own labels into their own R2 bucket alongside (or instead of) the public ones. Public label data is available as a public R2 bucket or versioned tarballs for easy bootstrap — no ingestion pipeline required.

---

## 2. API

### 2.1 Label Resolution

```
GET /label?iri={encoded_iri}           — all languages bundle (if ingested; see §4.1)
GET /label?iri={encoded_iri}&lang=en   — single language
```

Language is a single value — one request, one language. Consumers requiring multiple languages make multiple parallel requests. The Worker does not merge responses.

**Response (200) — JSON-LD:**
```json
{
  "@context": "https://your-resolver/context/labels-v1.json",
  "@id": "https://www.w3.org/2004/02/skos/core#Concept",
  "prefLabel": "Concept",
  "definition": "An idea or notion; a unit of thought."
}
```

The `@context` URL is a stable, heavily-cached document (see §4.2) that defines all prefix mappings and property aliases. Individual label responses are small — context is a URL reference, not inline.

**Response (404):**
```json
{
  "error": "not_found",
  "iri": "https://example.org/myontology#Thing",
  "message": "IRI not found. Deploy your own instance to serve private labels."
}
```

**Language fallback:** if `?lang=fr` resolves to a 404, the client receives 404. No automatic language fallback — the caller decides.

### 2.2 Namespace Listing

```
GET /namespaces             — list all namespaces in the store
GET /namespaces/{prefix}    — describe a namespace (IRI base, ontology metadata)
```

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
│         (label-resolver Worker)         │    Sets Cache-Control + Cache-Tag.
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
   └── HIT  → return immediately (gzipped bytes, Worker NOT invoked, no CPU billed)
   └── MISS → Worker invoked

3. Worker: parse ?iri=, extract ?lang=
4. Construct R2 key: labels/{ns}/{local}/{lang}  (or labels/{ns}/{local} if no lang)
5. r2.get(key)
   └── HIT  → stream response with Cache-Control + Cache-Tag; platform caches it
   └── MISS → 404
```

No fallback chain, no proxy, no external calls. The Worker either finds the object in R2 or returns 404. Caching is driven entirely by the response `Cache-Control` header — the Worker no longer calls `cache.match`/`cache.put` itself (see the migration doc).

---

## 4. Storage

### 4.1 R2 — Label Store

**Bucket:** `rdf-labels`

#### Key structure

```
labels/{namespace}/{local_name}/en          ← English only
labels/{namespace}/{local_name}/fr          ← French only
labels/{namespace}/{local_name}/x-none      ← untagged literals (no lang tag)
labels/{namespace}/{local_name}             ← all-languages bundle (optional)

context/labels-v1.json                      ← shared JSON-LD context document
```

Language is encoded in the key — the Worker does no filtering or transformation. Untagged literals use `x-none` (BCP47 convention) to avoid a null key edge case.

**All-languages bundle** (`labels/{ns}/{local}`) is optional. Omit it if per-language objects already cover the use case. A no-`?lang=` request that hits a missing bundle returns 404.

**Namespace dumps** (`namespaces/{ns}/*.json`) are omitted. Schema.org has ~2,500 terms; a full dump would be tens of MB and has no clear use case for per-IRI resolution. Use the ingestion pipeline output directly if bulk access is needed.

#### Compression

All objects stored gzip-compressed with `Content-Encoding: gzip` in R2 object metadata. The Worker streams bytes directly to the client — no decompression at any point. Browsers decompress natively.

```javascript
// Ingestion script (not the Worker)
await r2.put("labels/rdfs/label/en", gzippedBytes, {
  httpMetadata: {
    contentType: "application/ld+json",
    contentEncoding: "gzip",
    cacheControl: "public, max-age=86400"
  }
});
```

#### Object format — JSON-LD

```json
{
  "@context": "https://your-resolver/context/labels-v1.json",
  "@id": "https://www.w3.org/2004/02/skos/core#Concept",
  "prefLabel": "Concept",
  "definition": "An idea or notion; a unit of thought."
}
```

With `@container: @language` declared in the context, single-language responses are plain strings — no array wrapping needed.

### 4.2 JSON-LD Context Document

Stored in R2 at `context/labels-v1.json`. Served with an immutable TTL. Version suffix (`-v1`) allows future breaking changes without invalidating existing objects — never mutate an existing versioned context URL, bump to `-v2` instead.

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

### 4.3 Cache — Workers Cache

The primary cache layer. **Workers Cache** is a platform-managed, regionally tiered cache that sits *in front of* the Worker: a lower regional tier near the requester and an upper network-wide tier. Hits are served **without invoking the Worker** (no CPU billed); cold PoPs are served from the upper tier instead of round-tripping to R2. Cache keys are the full request URL (IRI + lang param). Pre-gzipped objects are stored and served compressed — no recompression overhead.

Caching is enabled via config (`[cache] enabled = true`) and driven by the response `Cache-Control` header. The Worker does **not** call `caches.default` — no manual `match`/`put`/`waitUntil`.

| Response type | Cache-Control |
|---|---|
| Label (found) | `public, max-age=86400` |
| 404 | `public, max-age=60` |
| Context document | `public, max-age=31536000, immutable` |

Every cacheable response also carries a `Cache-Tag` header (`public-labels`, plus a per-namespace tag such as `ns:skos`). Purge on ontology refresh via `ctx.cache.purge({ tags: [...] })`.

See [2026-07-06-workers-cache-migration.md](./2026-07-06-workers-cache-migration.md) for migration detail and open caveats (404 cacheability, plan/GA status, `compatibility_date`).

---

## 5. Cost Model

### Storage (R2)

| Content | Estimated size | Monthly cost |
|---|---|---|
| All supported namespaces, per-language objects | ~50MB | ~$0.001 |

Storage is not a cost concern.

### Compute

| Monthly requests | Edge cache hits | Workers invocations | Approx. cost |
|---|---|---|---|
| <10M | most | few | **~$0** |
| 50M | most | ~5M | **~$1.50** |
| 500M | most | ~50M | **~$15** |

Edge cache hit rate on popular IRIs (rdfs:label, rdf:type, owl:Class, schema:name) will be very high in practice — the same IRIs appear in many graphs. Worker invocations are the cold-miss tail only.

---

## 6. Deployment

### 6.1 Worker Configuration (wrangler.toml)

```toml
name = "rdf-label-resolver"
main = "src/index.ts"
compatibility_date = "2025-04-19"

[cache]
enabled = true

[[r2_buckets]]
binding = "PUBLIC_LABELS"
bucket_name = "rdf-public-labels"

[vars]
ENVIRONMENT = "production"
```

No secrets, no KV, no D1. `[cache] enabled = true` turns on Workers Cache; confirm it is available on the account plan and stable on the pinned `compatibility_date` (see migration doc caveat 2).

### 6.2 Label Data Bootstrap

Public label data is available as:

- **Public R2 bucket** — sync directly into your own R2 using rclone or the S3-compatible API. Picks up the exact key structure the Worker expects.
- **Versioned tarballs** — GitHub releases. Download, extract, upload to your R2 or S3. Pick only the namespaces you need.

Self-hosters do not need to run the ingestion pipeline unless they are adding namespaces not covered by the public data.

### 6.3 Adding Private Labels

Deploy your own instance. Load your private label objects into your R2 bucket using the same key structure. The Worker is namespace-agnostic — it constructs an R2 key from the IRI and retrieves whatever is there. No config changes needed.

### 6.4 Protecting a Private Deployment (Auth)

The Worker itself has no auth logic. For access control, put an auth layer in front at the platform level — no code changes to the Worker needed.

**Cloudflare:** Cloudflare Access in front of the Worker. Configure with any IdP (Entra, Okta, Google, GitHub). Enforces JWT validity and group/role claims at the edge before the Worker is invoked. Free tier covers most private deployments.

**Azure:** Azure API Management or Azure Front Door with Entra ID. APIM can validate Entra JWTs and enforce role claims via policy — Worker equivalent is an Azure Function or Static Web App behind APIM. Same pattern, different runtime.

**AWS:** CloudFront + Lambda@Edge (or CloudFront Functions) for JWT validation, or API Gateway with a Cognito authorizer. S3 replaces R2 as the label store; CloudFront replaces the edge cache.

Templates for each platform are a natural companion to this repo — deferred post-MVP but the pattern is identical across all three: auth layer → edge cache → compute → blob store.

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
4. Group by IRI, then by language tag (x-none for untagged literals)
5. Serialise each group as JSON-LD referencing the context URL
6. Gzip each document
7. Write to R2: labels/{ns}/{local}/{lang}
8. Write context/labels-v1.json (only if not exists — never overwrite)
9. Publish tarball to GitHub releases
10. Purge Workers Cache by tag: ctx.cache.purge({ tags: ["public-labels"] })
    (or per-namespace tags, e.g. ["ns:skos"], to invalidate only refreshed namespaces)
```

---

## 7. Open Questions / Future Work

- **Bulk resolution** — `POST /labels` with an array of IRIs. Worker fetches each R2 key and concatenates pre-built objects into a JSON-LD array. No per-object processing needed. **Caveat:** an arbitrary batch is a near-unique cache key, so this bypasses per-IRI edge caching and moves work into Worker CPU — scope it to cold/bulk workloads; per-IRI `GET` over H2/H3 stays the hot path. See [`FAQ.md`](./FAQ.md) for the full rationale on the "one request per label" concern.
- **Label search** — full-text search across all stored labels (IRI → label and label → IRI). Requires an index; out of scope for the initial Worker but a natural companion service.
- **`/.well-known/prefixes`** — canonical prefix map endpoint for tooling.
- **Context versioning** — when a v2 context is needed, determine migration path (rewrite all R2 keys vs dual-serve both versions during transition).
