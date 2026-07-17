# Consuming RDF Label Cache — Client Recommendations

How to call the service well from an application. This is the practical companion to
[`FAQ.md`](./FAQ.md) (which argues *why* the per-request design is sound); here we cover
what a consumer should actually do.

---

## 1. Fire label lookups in parallel

Every label is an independent `GET /label?iri=…&lang=…`. They are not a batch and they do
not depend on each other, so resolve them **concurrently** — never one at a time. Over
Cloudflare's HTTP/2 and HTTP/3 they multiplex over a single connection and land within
roughly one round trip.

```js
const pickLabel = (m) => (m ? m["@none"] ?? m.en ?? Object.values(m)[0] : null);
const labels = Object.fromEntries(await Promise.all(
  iris.map(async (iri) => {
    // no ?lang= -> untagged label; add &lang=xx for a specific language.
    const res = await fetch(`${BASE}/label?iri=${encodeURIComponent(iri)}`);
    return [iri, res.ok ? pickLabel((await res.json()).prefLabel) : null];
  }),
));
```

There is no server-side language fallback: `?lang=en` is exactly `labels/en/{iri}`, and no
`?lang=` is `labels/und/{iri}` (the untagged label). If your data mixes tagged and untagged
labels, decide the order client-side and make a second call on a miss — cheap and cached.

Bound in-flight requests to **~100** (Cloudflare's per-connection stream limit). Firing
thousands unbounded just queues them and can trip flow control. See
[`FAQ.md`](./FAQ.md#its-one-http-request-per-label-isnt-that-slow--an-n1-problem) for the
full transport rationale.

---

## 2. Let the HTTP cache do the caching

Label responses are served:

```
Cache-Control: public, max-age=3600, s-maxage=31536000, stale-while-revalidate=604800
```

Four knobs plus the tag purge, each answering a different question. Defaults and when to
change them:

| Knob | Default | What it controls | Tune when |
|---|---|---|---|
| browser `max-age` | `3600` (1h) | Worst-case time a **changed** label keeps showing stale to a returning browser — a purge can't reach browsers | Lower for faster change propagation; raise if labels rarely change |
| edge `s-maxage` | `31536000` (1y) | How long the edge holds an entry — a **cost/efficiency** dial, *not* freshness (the tag purge overrides it) | Leave long |
| `stale-while-revalidate` | `604800` (1w) | How far past `max-age` a browser serves its cached copy **instantly** while refreshing in the background | Raise toward `s-maxage` for near-always local hits; lower to bound returning-visitor staleness |
| error/404 `max-age` | `60s`, untagged | How fast a newly-**added** label for a previously-missing IRI appears — no purge needed | Keep short |
| tag purge | on change | Invalidate the edge after **editing** existing labels | Always, after changing an existing label |

**Why `stale-while-revalidate` is there.** A shared cache forwards an `Age` header (how long
the entry has sat in caches), and a browser judges freshness as `age < max-age` against that
forwarded age — not against when *it* fetched. Popular labels stay warm at the edge for
hours, so they arrive with `Age` already **past** `max-age=3600`: stale on arrival. Without
`stale-while-revalidate` the browser then blocks and refetches on **every** request, so its
own cache goes effectively unused for any warm entry. With it, a stale-but-within-window copy
is served **instantly (0 bytes, ~2 ms)** while a background refresh pulls the current value in
for next time. Returning visitors get local-cache speed; freshness stays bounded by `max-age`
+ the purge, at the cost of one stale render immediately after a change.

**Changes vs. additions** — only one needs a purge:

- **Editing an existing label:** upload + purge the `labels` tag. The edge serves the new
  value immediately; a returning browser picks it up within one request (SWR background
  refresh) and within `max-age` at worst. Write-heavy label workloads that need instant,
  guaranteed correction are not a fit — version the resource URL instead.
- **Adding a label for a new IRI:** no purge. An IRI never requested before simply misses to
  origin and returns the new value. If it had previously returned a 404, that 404 is cached
  only ~60s (and untagged, so a `labels` purge wouldn't touch it) — the added label appears
  within about a minute on its own.

What you do on the client depends on where your code runs:

- **Browser apps — you generally do *not* need an app-level label cache.** The browser's
  HTTP cache stores each `(IRI, lang)` response and serves it locally — instantly, refreshing
  in the background when the copy is stale (see above). A hand-rolled in-memory label map
  mostly duplicates it. The one thing worth
  adding is an **in-flight de-dupe** so a single render that mentions the same IRI twice
  fires one request, not two:

  ```js
  const inflight = new Map();
  const getLabel = (iri, lang = "en") => {
    const url = `${BASE}/label?iri=${encodeURIComponent(iri)}&lang=${lang}`;
    if (!inflight.has(url)) inflight.set(url, fetch(url).then((r) => (r.ok ? r.json() : null)));
    return inflight.get(url);
  };
  ```

- **Server-side / non-browser callers** (Node `fetch`, another Worker, a CLI) have **no
  shared HTTP cache** — every `fetch` hits the network. Here you *should* keep your own
  cache: a small in-memory LRU keyed by `iri|lang`. The responses only change on a
  data refresh, so a generous TTL (hours) is safe; size it to your working set.

---

## 3. Cache the JSON-LD `@context` in the client

If you parse responses as JSON-LD, each document references an absolute `@context` URL and
the parser re-fetches it once per document by default. The context is **versioned and
stable** (`/context/labels-v1.json` does not change), so fetch it once and hand your
JSON-LD parser a preloaded `context` / `documentLoader` that resolves it from memory. Every
label lookup then skips the context round trip.

---

## 4. Warm the connection (browsers)

So the first label request doesn't pay the TLS/QUIC handshake, preconnect to the
RDF Label Cache origin as the page loads:

```html
<link rel="preconnect" href="https://label-cache-orders.<subdomain>.workers.dev" crossorigin>
```

QUIC 0-RTT resumption helps repeat visitors on top of this.

---

## 5. One instance can serve many apps

Because objects are **keyed by the full IRI** and the Worker is namespace-agnostic, an app
only ever fetches the IRIs it actually renders. Adding a second, unrelated app to the same
instance never bloats what the first one pulls. So you can point several apps at **one**
RDF Label Cache instance rather than standing up one per app — load every app's labels into the
one bucket and each app retrieves only its own slice.

**What is and isn't shared across apps** — worth being precise about:

- **Cloudflare's edge cache is shared** across every caller of the instance. The first app
  to request `schema:name` warms it at the edge; every other app then gets an edge hit that
  never invokes the Worker. This is the real cross-app win.
- **Browser HTTP caches are *not* shared across different sites.** Modern browsers
  partition the HTTP cache by top-level site, so `app-a.com` and `app-b.com` each keep
  their own copy even when hitting the same RDF Label Cache origin. Apps under the *same* site
  (subpaths, or subdomains that share an eTLD+1) can share a browser-cache partition;
  genuinely unrelated sites cannot.

### Merge or separate?

| Run **one shared** instance when… | Run **separate** instances when… |
|---|---|
| The apps' label sets overlap (shared vocabularies, shared entities) | You need blast-radius isolation — one app's purge/refresh must not touch another |
| You want one operational surface: one bucket, one deploy, one purge | You need an independent auth boundary per app (see `architecture.md` §6.4) |
| You want the edge cache warmed across apps | The data is sensitive and must live in a separate store |

The default tooling names the Worker and bucket `label-cache-<project>` per app, which
gives you separate instances out of the box; merging is a deliberate choice — point the
apps at one deployment and seed the combined label set into its bucket.

---

See also: [`architecture.md`](./architecture.md) for the full design and
[`FAQ.md`](./FAQ.md) for design rationale.
