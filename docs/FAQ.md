# FAQ and Design Rationale

## Why one request per label?

Each `(IRI, language)` pair is an independent HTTP resource and cache entry.
That gives the edge cache high reuse: an application requesting one familiar
term can reuse an entry warmed by earlier callers without fetching an arbitrary
batch containing it.

Consumers should request the labels needed for a view concurrently and apply a
reasonable concurrency bound. Modern HTTP transports reuse connections for
concurrent requests; `@rdf-label-cache/client` handles the request scheduling and
in-flight de-duplication.

This design is aimed at interactive views and working sets with reusable terms.
It does not make request count free: every lookup remains a billable Workers
request and requires client-side response handling. Measure the service with
your own representative working set before relying on a latency target.

## Why not a batch endpoint?

An arbitrary `POST /labels` body usually produces a request combination that
will not recur, so it loses the per-IRI cache reuse that makes the read path
effective. It also moves fan-out and response assembly into Worker CPU.

A batch endpoint may still be useful for cold server-to-server jobs where cache
locality is already poor. If one is added, it should complement rather than
replace per-IRI `GET` for interactive use.

| Approach | Cache behavior | Best fit |
|---|---|---|
| Per-IRI `GET` | Reusable entry for each `(IRI, language)` | Interactive views |
| Generic batch `POST` | Request combinations rarely repeat | Cold bulk jobs |

## Why one language per request?

The R2 layout is `labels/{language}/{iri}`. `?lang=en` reads the English object;
omitting `?lang` reads the untagged object under `labels/und/{iri}`. One request
therefore maps directly to one R2 object and one cache entry.

There is no server-side language merge or fallback. A consumer that wants
"English, then untagged" makes that policy explicit. The client library supports
such fallback without changing the server contract.

## How do browser and server caches differ?

Browsers may store responses according to `Cache-Control`; the client library
uses normal `fetch` and does not bypass that cache. Browser caches are controlled
by the user agent and cannot be purged by this service.

Server runtimes generally do not provide a browser-style shared HTTP cache. The
client therefore enables a size-bounded, one-hour in-memory LRU by default in
Node, Workers, and Deno. Use `cache: false` when the host already provides
caching, or pass a custom store to share entries between clients in the same
process (the `LabelStore` interface is synchronous, so it cannot be backed by
an external cache such as Redis).
