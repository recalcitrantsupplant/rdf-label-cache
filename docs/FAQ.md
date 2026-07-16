# FAQ / Design Rationale

**Status:** Design / Pre-implementation
**Companion to:** [`architecture.md`](./architecture.md)

Anticipated questions about the design. Where this doc cites performance
characteristics, they are **reasoned from the platform's transport model, not yet
measured** - see [Benchmarks (TODO)](#benchmarks-todo).

---

## "It's one HTTP request per label. Isn't that slow / an N+1 problem?"

Short answer: the objection is an **HTTP/1.1 intuition**, and it's largely defused by
the transport the service already runs on. The cost model behind "N requests is slow" -
a TCP connection per request, serial round trips, connection-pool exhaustion - is an
HTTP/1.1 artifact. Cloudflare serves **HTTP/2 and HTTP/3 (QUIC) by default**, and this
design is close to ideal for them.

### Why the transport already handles it

- **Multiplexing.** N IRI lookups ride a single connection as concurrent streams. No
  per-request handshake, no pool exhaustion. A client that fires them in parallel has
  them all in flight within ~1 RTT - not serialized.
- **Header compression (HPACK / QPACK).** This is the decisive factor for *this*
  workload. Responses are tiny JSON-LD documents; without header compression the
  repeated request/response headers would dominate the bytes on the wire. H2/H3 collapse
  them to near-nothing after the first request on the connection.
- **HTTP/3 removes TCP head-of-line blocking.** A lost packet stalls only its own stream,
  not all N. This is exactly the failure mode that makes "many small requests" painful on
  H1 (and on H2 over a lossy link).
- **Per-URL edge caching compounds it.** Cache keys are the full request URL (IRI +
  `lang`), so most of those N streams are regional-cache hits that never invoke the
  Worker (see `architecture.md` §4.3). The realistic shape is "N multiplexed streams,
  mostly cache hits, a few hundred bytes each after HPACK." That is not a slow pattern.

### What N requests *does* cost

Being honest about the limits of the transport argument: bytes-on-the-wire and connection
cost are solved by H2/H3 + edge cache. What N requests genuinely costs is **N cache
lookups and N client-side response parses** - not N round trips. For the interactive hot
path (a viewer resolving the IRIs visible on screen) that cost is negligible. It only
becomes interesting for cold bulk workloads, addressed below.

### What a client should do to get the win

The transport advantage evaporates if the caller defeats it:

- **Reuse one connection.** Most HTTP clients pool by default; some naive server-side
  `fetch` loops do not. One warm connection to one origin is the whole point.
- **Bound in-flight requests** to ~100 (Cloudflare's `SETTINGS_MAX_CONCURRENT_STREAMS`).
  Firing thousands unbounded queues them anyway and can trip flow control.
- **Warm the connection early.** Browser callers can `<link rel="preconnect">` the
  RDF Label Cache origin so the first label request doesn't pay the TLS/QUIC handshake; QUIC
  0-RTT resumption helps repeat clients.

---

## "Should there be a batch endpoint, then?"

A generic `POST /labels` (array of IRIs → JSON-LD array) is listed as future work in
`architecture.md` §7. It fights the architecture's core strength and is **not** the answer
for the hot path:

- The entire cache model is "key = full URL, per-IRI edge hit." An arbitrary batch of N
  IRIs is a **near-unique cache key that rarely repeats**, so CDN hit rate collapses.
- Work that the edge cache did for free moves into **Worker CPU** - fan out to R2,
  assemble the array, billed per invocation.

If it is ever added, scope it explicitly to **cold, server-to-server bulk jobs** where
cache locality is already poor (e.g. one-shot ingestion of an external dataset), and keep
per-IRI `GET` - riding H2/H3 multiplexing over one connection - as the documented,
cache-optimized hot path.

| Approach | Requests | Cache behaviour | Best for |
|---|---|---|---|
| Per-IRI `GET` (today) | N, multiplexed | Ideal - per-IRI edge hits | Interactive hot path |
| Generic `POST /labels` | 1 | Poor - unique keys, Worker CPU | Cold bulk, poor locality |

---

## "Why one language per request instead of merging them?"

Each `(IRI, lang)` pair is a distinct key and a distinct cache entry, and single-language
responses are the common case. The key is **lang-first** - `labels/{lang}/{iri}` - so
`?lang=en` reads `labels/en/{iri}`, and a request with **no** `?lang=` reads
`labels/und/{iri}` (the untagged literal). One request, one key, one lookup; the Worker
never assembles or filters anything.

There is deliberately **no all-languages bundle and no cross-language fallback in the
Worker**. If you want "try the untagged label, then English," that's a client decision made
with a second call - cheap over HTTP/2/3, and it keeps the Worker a dumb key-value read.
Because keys are lang-first, "give me every French label" is just a bulk **prefix list** of
`labels/fr/` - no per-request merging needed. Language tags are stored faithfully: if your
source data tags a label `@en`, it lives under `en`; if it's untagged, it lives under `und`.
Normalizing (e.g. forcing everything to one language) is a data-prep choice you make before
ingest, not something the service does for you.

---

## Benchmarks (TODO)

The transport argument above is reasoned from the platform model; it should be backed by
numbers. Planned figures:

- Resolve **N ≈ 200 IRIs** over a single warm HTTP/3 connection: wall-clock and total
  bytes transferred (cold cache vs. warm edge cache).
- Same, over HTTP/1.1 with capped connections, as the contrast that the criticism assumes.

Until these land, treat the performance claims here as **design intent, not measured
results.**
