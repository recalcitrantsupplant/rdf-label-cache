# @rdf-label-cache/client

A **really thin** (one file, zero dependencies), isomorphic client for the
[RDF Label Cache](https://github.com/recalcitrantsupplant/rdf-label-cache). It is
the canonical example of *how* to consume the service well — it encodes, in code,
the guidance from
[`consuming.md`](https://github.com/recalcitrantsupplant/rdf-label-cache/blob/main/docs/consuming.md)
and [`FAQ.md`](https://github.com/recalcitrantsupplant/rdf-label-cache/blob/main/docs/FAQ.md):

- **Parallel by default, bounded to 100 in flight.** Independent, edge-cached
  GETs are issued concurrently without an unbounded request burst.
- **Prefers the browser cache.** It never busts it (no `cache: "no-store"`), so
  a returning view can be served from the browser's own HTTP cache without a
  network transfer. In the browser it adds only an in-flight de-dupe; outside the browser
  (Node/Workers/Deno — no shared HTTP cache) it keeps a small memo LRU.
- **Client-side language fallback.** There is no server-side fallback; the
  client can try another language after a miss.
- **Warms the connection** with `preconnect()` (browsers).

## Install

```bash
pnpm add @rdf-label-cache/client
```

## Use

```ts
import { createLabelClient } from "@rdf-label-cache/client";

const labels = createLabelClient({
  base: "https://label-cache-orders.<subdomain>.workers.dev",
});

// Browser: warm the TLS/QUIC handshake as the page loads.
labels.preconnect();

// One label (untagged). Applies predicate order + language fallback.
await labels.resolve("https://schema.org/name");            // → "name"

// A specific language, falling back to the untagged label on a miss.
await labels.resolve("https://schema.org/name", { lang: "en" });

// Many at once — deduped, parallel, bounded. This is the hot path.
await labels.resolveMany([
  "https://schema.org/Person",
  "https://schema.org/jobTitle",
  "http://www.w3.org/2004/02/skos/core#Concept",
]);
// → { "https://schema.org/Person": "Person", … }
```

Need the raw JSON-LD instead of a single string? Use `document(iri, lang?)` /
`documentMany(iris, lang?)` and pick with the exported `pickLabel`.

## Getting real RDF out (still zero-dep)

The raw response is **JSON-LD** — as delivered it is only valid *JSON*; it
becomes valid *RDF* once interpreted against the context (so `prefLabel` →
`skos:prefLabel`, the `"en"` key → a language tag). You don't need a JSON-LD
processor for that: the service's context is a trivial subset (prefix maps +
`@container: @language`), so `toQuads` expands faithfully, driven by the
service's own fetched context — correct even for self-hosters with custom
predicates.

```ts
// Zero-dep: plain RDF/JS-shaped { subject, predicate, object, graph } objects.
const triples = await labels.toQuads(await labels.document("http://…/Concept", "en"));

// Already using n3? Hand it the DataFactory to get n3's native quads, straight
// into a Store — no jsonld dependency, no reinvention:
import { DataFactory, Store } from "n3";
const store = new Store();
store.addQuads(await labels.toQuads(doc, { factory: DataFactory }));
```

`@none` expands to an `xsd:string` literal, a real tag to an `rdf:langString`.
`toQuadsMany(docs, opts?)` concatenates across documents.

### Prefer a full JSON-LD processor?

This library intentionally **does not depend on `jsonld` or `n3`** — most label
cache consumers already have them, and dependency injection beats a bundled (or
even optional) dependency. Two supported routes:

1. **`toQuads({ factory })`** as above — enough for this service's data, zero-dep.
2. **Bring your own parser** for full JSON-LD 1.1 / streaming. Feed the raw
   response to `jsonld-streaming-parser` (the n3 companion) or `jsonld`, with the
   context served from memory via `getContext()` (it's versioned and immutable —
   cache it once, per `consuming.md §3`), so no per-document context round trip.

## API

| Member | Purpose |
|---|---|
| `createLabelClient(opts)` / `new LabelClient(opts)` | Construct once and reuse it for in-flight de-duplication and server-side memoization. |
| `.resolve(iri, { lang?, fallback? })` | IRI → label string (or `null`). |
| `.resolveMany(iris, opts?)` | IRIs → `{ [iri]: label \| null }`, concurrent & deduped. |
| `.document(iri, lang?)` / `.documentMany(iris, lang?)` | Raw JSON-LD (or `null` on a miss). |
| `.toQuads(doc, { factory? })` / `.toQuadsMany(docs, …)` | Expand JSON-LD → RDF triples (zero-dep, or your RDF/JS `DataFactory`). |
| `.getContext()` | The versioned, immutable context document (cached) — for a BYO JSON-LD parser's `documentLoader`. |
| `.url(iri, lang?)` | The request URL for a pair (for `<link rel=preload>`, debugging). |
| `.preconnect()` | Browser: preconnect to the origin. No-op elsewhere. |
| `pickLabel(doc, order?, lang?)` / `pickFromMap(map, lang)` | Pure pickers, usable without a client. |
| `lruStore(max?, ttlMs?)` | The default one-hour memo store; pass your own via `cache`. |

### Options

```ts
createLabelClient({
  base,                 // required: your deployed Worker origin
  order,                // preference by term ALIAS (doc keys, not IRIs); default ["prefLabel","label","title","name"]
  concurrency,          // max in-flight; default 100
  cache,                // "auto" (default) | true | false | your own LabelStore
  fetch,                // injectable fetch; default globalThis.fetch
});
```

`cache: "auto"` is the recommended default. It turns the memo LRU **off in browsers** (the HTTP cache already
does this job and a hand-rolled map mostly duplicates it) and **on everywhere
else** with a one-hour TTL (server callers have no shared HTTP cache). Use
`cache: false` when the host already provides caching or every request must
revalidate; pass a custom `LabelStore` (a synchronous, in-process store) to
share entries between clients in the same process or tune sizing/TTL beyond
`lruStore(max, ttlMs)`. Only successful documents are memoized, so a label
seeded shortly after a 404 can appear on the next call.

`order` is matched against the **term aliases** in the response (the object's
keys, e.g. `prefLabel`), not IRIs. The default matches the aliases this
service's context emits. Because a term keeps its alias even if a deployment
maps it to a different IRI, remapping (say `name` → foaf:name) needs no change;
only a context that **renames** the aliases does — then pass your own `order`.

## Why so thin?

The service exposes ordinary cacheable HTTP resources. The client only needs to
issue bounded parallel requests, avoid bypassing HTTP caches, apply language
fallback, and pick a label. See [the FAQ](https://github.com/recalcitrantsupplant/rdf-label-cache/blob/main/docs/FAQ.md)
for the per-IRI request rationale.
