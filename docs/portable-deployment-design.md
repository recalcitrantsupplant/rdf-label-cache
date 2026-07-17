# Portable Deployment & Dev Container — Design Document

**Version:** 0.1 (draft)
**Status:** Design / Pre-implementation
**Companion to:** `rdf-label-resolver-design (1).md` (the Cloudflare-native architecture)

---

## 1. Motivation

The production design (companion doc) is intentionally Cloudflare-native: one Worker,
one R2 bucket, edge cache. That is the right *target*, but it creates friction in two
situations:

1. **Local development.** App developers consuming the label service shouldn't have to
   stand up a CDN, deploy a Worker, or hold cloud credentials just to get labels back.
   They want to point at an address and get identical responses.

2. **Early/serious-but-not-yet-scaled deployments.** For a new project you often want to
   *just deploy a container* on whichever cloud the rest of the stack lives on, with no
   CDN, no functions, no edge config — and add the full CDN tier later (Terraform/Bicep)
   once it matters. The CDN should be an optimisation you layer on, not a prerequisite.

This document describes the **read/fallback path**, the **caching semantics**, and a
**portable container** that satisfies both — running identically in `docker compose`
locally and on Azure/AWS as a single container, before any CDN exists.

**Guiding principle:** the CDN is an *optimisation layer*, not part of the application.
The application is a small HTTP handler with two dependencies (a blob store and a label
source). Everything else — edge cache, multi-region, functions — is infrastructure that
wraps the same handler.

---

## 2. The read path (identical in every deployment)

```
GET /label?iri=…&lang=…
  1. edge cache    → hit? return                      (ephemeral, TTL ~24h)
  2. blob store    → hit? return + populate edge       (R2 / S3 / Azure Blob / filesystem)
  3. SPARQL origin → hit? return
                          + write-behind to blob
                          + populate edge
                     miss? 404 (short-TTL negative cache)
```

Three tiers, with the same ordering everywhere:

| Tier | Role | Cloudflare | AWS | Azure | Dev container |
|---|---|---|---|---|---|
| **Edge cache** | ephemeral, TTL'd | `caches.default` | CloudFront | Front Door / Azure CDN | in-process LRU (or none) |
| **Blob store** | durable cache + curated data | R2 | S3 | Azure Blob | filesystem / in-memory |
| **SPARQL origin** | source of truth | endpoint | endpoint | endpoint | endpoint |

The compute tier (Worker / Lambda / Azure Function / Node process) runs the **same
handler** in all cases — see §6.

### 2.1 Blob-first, not SPARQL-first

The fallback queries the **blob store before SPARQL**:

- Blob is fast, cheap, and holds the curated well-known namespaces (rdfs/owl/skos…) —
  the hot majority of traffic.
- SPARQL is authoritative but slow, and puts load/cost on the triplestore. It should
  serve only the cold long tail.
- Labels are near-static; combined with cache-tag purge on ontology refresh, the
  staleness risk of serving blob-first is low.

SPARQL-first would only make sense if freshness dominated cost (labels changing
constantly), which is not the case here.

---

## 3. Caching semantics

The taxonomy matters because it dictates invalidation and where writes happen.

- **Read-through (cache-aside).** On a miss, fetch from the next tier down, populate the
  cache, return. This is the core pattern for both edge→blob and blob→SPARQL.
- **Not write-through.** Write-through is for client-driven writes kept consistent across
  cache and store. Clients here only *read*; authoritative data lives upstream in the
  triplestore. So write-through does not apply.
- **Write-behind (on SPARQL hit).** When SPARQL answers a miss, asynchronously populate
  the blob store (and edge) so the same IRI isn't re-queried forever:

  ```ts
  ctx.waitUntil(Promise.all([
    blob.put(key, doc, { /* derived TTL/metadata */ }),
    cache.put(request, response.clone()),
  ]));
  ```

  Non-blocking; the client gets its response immediately.
- **Negative caching.** A SPARQL miss caches the 404 briefly (current code: `max-age=60`)
  so a flood of lookups for a non-existent IRI doesn't hammer the triplestore.

### 3.1 The blob store becomes a hybrid

Once SPARQL populates blob on miss, R2/S3/Azure Blob holds two kinds of entry:

- **Curated** — seeded from `/dev/seed` or a build pipeline. Long/immutable TTL.
- **Derived** — lazily populated from SPARQL. Shorter TTL, or tagged (metadata flag or a
  `derived/…` key prefix) so an ontology refresh can purge just these without nuking the
  curated set.

Keep the two distinguishable from day one — it's cheap now and painful to retrofit.

### 3.2 Thundering herd (deferred)

N cold requests for the same IRI can hit SPARQL simultaneously. Acceptable at low volume.
If it becomes a problem, a Durable Object (Cloudflare) or equivalent single-flight lock
per IRI solves it. Leave the seam; don't build it yet.

---

## 4. Store choice for the dev container

For a dev sidecar, **persistence is optional** — the goal is identical request/response
semantics, not durability. Ranked options:

1. **In-memory / filesystem-on-volume — preferred.** The filesystem mirrors the blob key
   layout (`labels/{ns}/{local}/{lang}`) exactly; in-memory is even simpler and resets on
   restart (fine for dev). Zero extra processes. This is the genuinely lightweight option.
2. **Redis — only if you want TTL/eviction for free or a cache shared across replicas.**
   Stores JSON-LD as plain string values (opaque to Redis; RedisJSON unnecessary).
   `redis:alpine` ~15 MB, built-in per-key TTL + LRU, optional persistence. Cost: a second
   process in the container.
3. **Memcached — skip.** Pure in-RAM LRU, no persistence, opaque blobs; gives nothing over
   Redis here except a cold cache on every restart.

**Do not use Apache/nginx as the application.** They'd serve static blob hits but you still
need an app process for the SPARQL-miss path, so a web server is just a second moving part.
A single small HTTP process (the portable handler, §6) is simpler.

---

## 5. Container strategy — two flavours

There are two distinct "just run a container" artifacts, for two purposes.

### 5.1 `wrangler dev` / Miniflare container — highest-fidelity Cloudflare dev

Miniflare (the simulator `wrangler dev` uses) emulates `caches.default`, R2 bindings, KV,
and env vars **in memory**. The **exact Worker code runs unchanged** — same runtime, same
semantics, not a lookalike. Best when you specifically want to reproduce Cloudflare
behaviour locally.

```dockerfile
FROM node:22-slim            # NOT alpine — workerd ships a glibc binary
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
ENV ENVIRONMENT=development
EXPOSE 8787
CMD ["pnpm", "wrangler", "dev", "--ip", "0.0.0.0", "--port", "8787"]
```

Notes:
- **Base image:** `workerd` is glibc-only; Alpine/musl needs `gcompat` hassle. Use
  `node:22-slim` (Debian).
- **Seed on boot:** in-memory R2 is empty every start. An entrypoint should start
  `wrangler dev`, wait for `:8787`, then `curl /dev/seed` (or seed lazily on first
  request). `/dev/seed` already guards on `ENVIRONMENT !== "production"`.
- **Bind `0.0.0.0`** so the container is reachable from the consuming app.
- **Caveat:** Miniflare/`wrangler dev` is a *development simulator* — single process,
  in-memory, not hardened or perf-tuned. Fine as a dev/staging sidecar (including on
  Azure/AWS for a test environment); **not** a production runtime.

### 5.2 Portable Node container — deploy-anywhere, the "just ship a container" path

The same handler (§6) wrapped in the Node adapter, run as an ordinary HTTP server. This is
the artifact you can run in `docker compose` locally **and** deploy as-is to any cloud's
container service, with **real** blob/SPARQL drivers selected by env var — no CDN required.
The container does cache-aside in-process; edge caching is added later as pure infra.

| Cloud | "Just a container" target |
|---|---|
| Local | `docker compose` |
| Azure | Container Apps / Container Instances / App Service for Containers |
| AWS | App Runner / ECS Fargate / Lightsail Containers |
| Cloudflare | (use the Worker directly — no container needed) |

This is the closest portable analog to "the wrangler dev container, but for Azure/AWS and
production-capable." Point it at filesystem+in-memory for dev, or at S3/Azure Blob + a
SPARQL endpoint for an early real deployment.

---

## 6. Portability architecture

Make "same pattern across clouds" *literal code reuse*, not aspiration.

**Use a portable HTTP framework.** [Hono](https://hono.dev) is a tiny router that runs
*natively* on Workers and ships first-party adapters for **AWS Lambda, Azure Functions,
and Node**. The same `app.get("/label", …)` handler runs everywhere; only the entry adapter
and injected drivers change.

**Abstract the two real dependencies behind interfaces:**

```ts
interface BlobStore  { get(key): …; put(key, body, opts): … }   // R2 | S3 | Azure Blob | fs
interface LabelSource { resolve(iri, lang): Doc | null }         // SPARQL client
```

**Project shape:**

```
core/      handleLabel, fallback chain, write-behind, negative cache   (cloud-agnostic, Hono)
drivers/   r2.ts | s3.ts | azure-blob.ts | fs.ts                       (BlobStore)
           sparql.ts                                                    (LabelSource)
entry/     worker.ts | lambda.ts | azure-func.ts | node.ts             (per-runtime adapter)
```

**The edge-cache tier is mostly config, not code.** CloudFront and Front Door cache off the
`Cache-Control` headers the handler already emits (`max-age=86400`, the `immutable` context
doc, the `60`s negative cache). So the application code needs only the **blob** and
**SPARQL** drivers plus the write-behind hook; the CDN is Terraform/Bicep that wraps the
same compute.

---

## 7. Single-stack, any-cloud

**Principle:** keep CDN + blob + compute in *one* cloud per deployment, but make *which*
cloud a deployment choice.

- For a serious project, all infra usually belongs in one place (ops, IAM, billing,
  networking). The driver/entry split lets you pick CloudFront+S3+Lambda *or*
  Front Door+Azure Blob+Functions *or* the Cloudflare-native stack — without touching
  `core/`.
- **Cross-cloud mixing is possible but discouraged.** E.g. CloudFront in front of Azure
  Blob works, but every blob miss crosses an AWS↔Azure boundary — inter-cloud egress cost
  plus latency. If your main app is in cloud X, deploying the label stack to cloud Y is not
  a big deal *for a small/early project*; for anything serious, co-locate.

---

## 8. Phased rollout

Smallest reviewable steps first; each step preserves current behaviour until the next opts
in.

1. **Refactor onto Hono + `BlobStore`/`LabelSource` interfaces.** R2 stays the only driver;
   behaviour identical to today's Worker. Verifiable against the existing deployment.
2. **Add the SPARQL fallback tier + write-behind + derived/curated distinction.**
3. **Add the Node entry + Dockerfile + `docker-compose.yml`** (portable container, §5.2),
   plus the `wrangler dev` container (§5.1) for Cloudflare-fidelity dev.
4. **Later:** S3 + Azure Blob drivers, Lambda + Azure Function entries, and Terraform/Bicep
   for the CDN tiers per cloud.

The CDN is always the last thing added — never something to worry about during dev.
