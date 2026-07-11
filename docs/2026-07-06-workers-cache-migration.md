# Migration: adopt Workers Cache

**Date:** 2026-07-06 (implemented 2026-07-08)
**Status:** Implemented
**Type:** Architecture decision / migration plan
**Affects:** `wrangler.toml`, `demo/wrangler.demo.toml`, `src/index.ts`, `src/routes/{label,context,namespaces,purge}.ts`, `src/lib/cache.ts`, `scripts/{deploy-demo,seed-remote}.sh`, ingestion pipeline (§6.6 of [architecture.md](./architecture.md))

---

## 0. Implementation (2026-07-08)

Availability confirmed against Cloudflare docs: Workers Cache is on **every plan**
(no separate SKU), tag purge is **not** Enterprise-gated, and it **works on
`workers.dev`**. So we went with the "cache forever, invalidate on change" model:

- **`[cache] enabled = true`** in both wrangler configs (needs Wrangler ≥ 4.69; we're on 4.107).
- **Dropped all `caches.default`** match/put - the platform now caches in front of
  the Worker off the response `Cache-Control`.
- **Immutable TTL** (`public, max-age=31536000, immutable`) on every success, since
  these responses only change on deploy or data refresh. Errors keep a short
  `max-age=60` so a label seeded just after a 404 appears without a purge.
- **`Cache-Tag`** on every success: `all` (full purge on deploy) + finer tags
  (`labels`, `labels:{ns}`, `namespaces`, `context`) for targeted purges. See
  `src/lib/cache.ts`.
- **Invalidation is worker-internal only** - Cloudflare documents no external
  REST/CLI purge for Workers Cache. So `POST /admin/purge?tags=…` (Bearer
  `PURGE_TOKEN`) calls `ctx.cache.purge({ tags })` (`src/routes/purge.ts`).
  - `scripts/deploy-demo.sh` purges `all` after each deploy.
  - `scripts/seed-remote.sh` purges `labels,context` after a reseed.
  - Both are **best-effort** (skipped until `PURGE_TOKEN` is set), so deploys never
    break on a missing token.

**Required secret - `PURGE_TOKEN`** (until set, cache still works but auto-purge is
skipped and immutable entries only clear when their TTL is bumped/on reseed-with-token):
1. On the Worker: `wrangler secret put PURGE_TOKEN --config demo/wrangler.demo.toml`.
2. In GitHub: add repo secret `PURGE_TOKEN` (wired into `release.yml` / `deploy-demo.yml`).

---

## 1. Context

Cloudflare shipped **Workers Cache** ([blog](https://blog.cloudflare.com/workers-cache/)) - a platform-managed, regionally tiered cache that sits *in front of* the Worker rather than being called from inside it.

Every route handler in this repo currently implements the same manual pattern against `caches.default`:

```ts
const cache = caches.default;
const cached = await cache.match(request);
if (cached) return cached;
// ... R2 lookup ...
ctx.waitUntil(cache.put(request, response.clone()));
```

This works, but has two structural limits Workers Cache removes:

1. **The Worker runs (and bills CPU) on every request - even cache hits.** With `caches.default`, the request still enters the Worker just to call `cache.match`. Workers Cache serves hits *before* the Worker is invoked, so hits cost no CPU.
2. **`caches.default` is per-PoP only.** A cold PoP always misses and reads R2. Workers Cache adds a regional/upper tier, so a cold PoP is served from a nearby cache tier instead of round-tripping to R2 - fewer R2 `GET`s (which are billed) and lower tail latency.

Our responses are an ideal fit: `GET`-only, keyed entirely by URL, immutable-ish content, already carrying explicit `Cache-Control`.

## 2. What changes

### 2.1 Enable the cache in config

`wrangler.toml`:

```toml
[cache]
enabled = true
```

(One flag. The platform caches responses off the `Cache-Control` header the Worker already sets.)

### 2.2 Delete the manual cache dance

All three handlers drop the `caches.default` match/put/clone/waitUntil boilerplate. The handler body reduces to: parse → R2 `get` → return `Response` with the right headers. The platform does the caching.

**Before** (`label.ts`):

```ts
const cache = caches.default;
const cached = await cache.match(request);
if (cached) return cached;
// ...
const response = new Response(object.body, { status: 200, headers });
ctx.waitUntil(cache.put(request, response.clone()));
return response;
```

**After**:

```ts
// no cache.match - a hit never reaches here
const response = new Response(object.body, { status: 200, headers });
return response; // platform caches per Cache-Control
```

Same for `context.ts` and `namespaces.ts`. `ctx.waitUntil` is no longer needed for caching in any handler.

### 2.3 Switch to the `Cache-Tag` header

`label.ts` currently sets `CF-Cache-Tag: public-labels`. Workers Cache reads the `Cache-Tag` response header and exposes tag purging via `ctx.cache.purge({ tags: [...] })`. Emit `Cache-Tag: public-labels` on all cacheable responses (labels, context, namespaces) so the whole surface can be invalidated together - and consider finer tags (e.g. `Cache-Tag: public-labels,ns:skos`) so a single namespace refresh can purge just its objects.

### 2.4 Wire purge-by-tag into the ingestion pipeline

Today the pipeline (architecture §6.6, step 10) purges "by tag" abstractly. With Workers Cache this becomes a concrete call after new objects land in R2:

```ts
await ctx.cache.purge({ tags: ["public-labels"] }); // or ["ns:skos", ...] per refreshed namespace
```

This replaces any zone-level cache-tag purge previously assumed.

## 3. What stays the same

- R2 key structure, gzip-in-R2 + `Content-Encoding` passthrough, JSON-LD object format, the `@context` document - all unchanged.
- `Cache-Control` values (labels `max-age=86400`, context `immutable`, 404 `max-age=60`) - unchanged; they now drive the platform cache instead of our `cache.put`.
- Cache key remains the full request URL, so `?lang=` variants stay distinct objects with no extra config.

## 4. Caveats to confirm before merging

1. **404 caching.** 400/404 responses carry `public, max-age=60`. They will be cached in the tiered layer just as they are today at the PoP. That's the current intent (protects R2/Worker from repeated bad IRIs), but the blast radius is slightly wider with an upper tier - confirm 60s is still right, or drop `Cache-Control` on errors to make them uncacheable.
2. **Plan / GA status.** Verify Workers Cache is enabled for our account/plan and whether `[cache]` config is stable on our `compatibility_date` (`2025-04-19`) or needs a bump.
3. **`Vary` / lang.** We rely on the URL (including `?lang=`) as the cache key, not `Vary`. Confirm Workers Cache keys on the full URL as expected so `en` and `fr` don't collide.
4. **`ctx.cache` availability.** `purge` lives on the execution context under Workers Cache - confirm the binding name/shape against current docs before wiring the pipeline.

## 5. Migration checklist

- [ ] Confirm feature availability + `compatibility_date` (caveat 2)
- [ ] Add `[cache] enabled = true` to `wrangler.toml`
- [ ] Strip manual `caches.default` code from `label.ts`, `context.ts`, `namespaces.ts`
- [ ] Rename `CF-Cache-Tag` → `Cache-Tag`; add it to context + namespaces responses; add per-namespace tags
- [ ] Decide 404 cacheability (caveat 1)
- [ ] Replace ingestion step 10 with `ctx.cache.purge({ tags })`
- [ ] Validate: cache hit does not invoke the Worker (check CPU/invocation metrics); lang variants stay distinct; purge invalidates
- [ ] Update [architecture.md](./architecture.md) §3.1/§3.2/§4.3/§6.1/§6.6 to match (done alongside this doc)

## 6. Expected impact

- Worker invocations (and CPU billing) drop to the cold-miss tail only - the cost table in architecture §5 becomes conservative.
- Fewer R2 `GET`s on cold PoPs due to the regional/upper tier.
- Less code: three handlers lose their cache boilerplate.
