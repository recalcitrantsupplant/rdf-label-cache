// A really thin, zero-dependency client for the RDF Label Cache.
//
// It is deliberately small - a canonical reference for *how* to consume the
// service well, encoding the guidance in docs/consuming.md and docs/FAQ.md:
//
//   1. Fire label lookups in parallel, bounded to 100 in flight by default.
//                                                              [consuming.md §1]
//   2. Let the HTTP cache do the caching. We never bust the browser cache
//      (no `cache: "no-store"`), so returning views cost 0 bytes on the wire.
//      Browsers get an app-level in-flight de-dupe only; non-browser callers
//      (Node/Workers) have no shared HTTP cache, so they get a small memo LRU.
//                                                              [consuming.md §2]
//   3. Preserve every predicate faithfully - the server never coerces to
//      prefLabel, so the *consumer* picks a preference order.  [consuming.md §1]
//   4. There is no server-side language fallback; the client applies an explicit
//      fallback chain after a miss.                         [consuming.md §1, FAQ]
//   5. Warm the connection early (browsers) via `<link rel="preconnect">`.
//                                                              [consuming.md §4]
//
// Isomorphic: uses the global `fetch`. Works in browsers, Node 18+, Workers,
// Deno, Bun. No build-time coupling to the Worker.

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

/**
 * A JSON-LD `@language` map for a single predicate term. Because each cached
 * object is one `(IRI, lang)` pair, in practice a map holds exactly ONE key:
 * the real language tag (e.g. `en`), or `@none` for an untagged literal. The
 * value is a string, or an array when the source carried several (e.g.
 * multiple `altLabel`s). See scripts/pipeline/ingest.mjs.
 */
export type LangMap = Record<string, string | string[] | undefined>;

/**
 * A `/label` response document. Each source predicate is kept under its own
 * term (`prefLabel`, `label`, `title`, `name`, `definition`, …) - never
 * collapsed into `prefLabel`.
 */
export interface LabelDoc {
  "@context"?: string;
  "@id"?: string;
  [term: string]: LangMap | string | undefined;
}

// ---------------------------------------------------------------------------
// RDF term shapes (structurally compatible with RDF/JS)
// ---------------------------------------------------------------------------

const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";
const RDF_LANGSTRING = "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString";

/** An RDF/JS-shaped term. n3's / @rdfjs's terms satisfy this structurally. */
export interface RdfTerm {
  termType: string;
  value: string;
  language?: string;
  datatype?: RdfTerm;
}
/** An RDF/JS-shaped quad. */
export interface Quad {
  subject: RdfTerm;
  predicate: RdfTerm;
  object: RdfTerm;
  graph: RdfTerm;
}
/**
 * The subset of the RDF/JS DataFactory interface {@link LabelClient.toQuads}
 * uses. Pass `n3.DataFactory` (or `@rdfjs/data-model`) to emit that library's
 * native quads for zero-friction interop; omit it for the zero-dep default,
 * which emits plain RDF/JS-shaped objects.
 */
export interface RdfDataFactory {
  namedNode(value: string): RdfTerm;
  literal(value: string, languageOrDatatype?: string | RdfTerm): RdfTerm;
  quad(subject: RdfTerm, predicate: RdfTerm, object: RdfTerm): Quad;
}

// ---------------------------------------------------------------------------
// Pure pickers (usable without a client)
// ---------------------------------------------------------------------------

/**
 * Default preference order for picking a display label, as JSON-LD **term
 * aliases** (the document's keys, e.g. `prefLabel`) - NOT IRIs like
 * `skos:prefLabel`. The picker reads `doc[alias]`, so it never resolves an IRI;
 * these are just the aliases the service's default context emits (in step with
 * scripts/pipeline/ingest.mjs). First hit across terms wins.
 *
 * A term keeps its alias even when a deployment maps it to a different IRI (e.g.
 * `name` → foaf:name rather than schema:name), so IRI remapping needs no change
 * here. What a custom context CAN change is the alias spelling itself - if yours
 * renames these terms, or omits some, pass your own `order` (the alias names as
 * they appear in your documents) to {@link LabelClient} or {@link pickLabel}.
 */
export const DEFAULT_ORDER = ["prefLabel", "label", "title", "name"] as const;

/**
 * Read one string out of a language map. A cached object carries a single
 * language key, so prefer the requested tag, fall back to `@none`, then to
 * whatever single value is present. A term may hold an array - take the first.
 */
export function pickFromMap(map: LangMap | undefined, lang: string | null): string | undefined {
  if (!map) return undefined;
  const v = map[lang ?? "@none"] ?? map["@none"] ?? Object.values(map)[0];
  return Array.isArray(v) ? v[0] : v ?? undefined;
}

/**
 * Pick a display label from a document by preference order. `order` entries are
 * JSON-LD term aliases matching the document's keys (see {@link DEFAULT_ORDER}),
 * not IRIs. Returns `null` if none of the preferred terms carry a value.
 */
export function pickLabel(
  doc: LabelDoc | null,
  order: readonly string[] = DEFAULT_ORDER,
  lang: string | null = null
): string | null {
  if (!doc) return null;
  for (const term of order) {
    const v = pickFromMap(doc[term] as LangMap | undefined, lang);
    if (v) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Memo store (for non-browser callers)
// ---------------------------------------------------------------------------

/**
 * A minimal document store. Implement this to plug in your own in-process
 * cache - `get` is synchronous, so an external backend (Redis, etc.) cannot
 * sit behind it. Only *successful* documents are stored; misses are never
 * cached, so a label seeded shortly after a 404 becomes visible on the next
 * call.
 */
export interface LabelStore {
  get(key: string): LabelDoc | undefined;
  set(key: string, doc: LabelDoc): void;
}

/**
 * A tiny insertion-order LRU with an expiry. The default TTL matches the
 * service's one-hour browser max-age so long-lived server processes eventually
 * observe refreshed labels.
 */
export function lruStore(max = 1000, ttlMs = 3_600_000): LabelStore {
  const m = new Map<string, { doc: LabelDoc; storedAt: number }>();
  return {
    get(key) {
      const entry = m.get(key);
      if (entry === undefined) return undefined;
      if (Date.now() - entry.storedAt >= ttlMs) {
        m.delete(key);
        return undefined;
      }
      m.delete(key); // bump recency
      m.set(key, entry);
      return entry.doc;
    },
    set(key, doc) {
      m.delete(key);
      m.set(key, { doc, storedAt: Date.now() });
      if (m.size > max) m.delete(m.keys().next().value as string);
    },
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface LabelClientOptions {
  /** Deployed Worker origin, e.g. `https://label-cache-orders.<sub>.workers.dev`. */
  base: string;
  /** Predicate preference, first hit wins. Default {@link DEFAULT_ORDER}. */
  order?: readonly string[];
  /**
   * Max in-flight requests. The default of 100 prevents unbounded request
   * bursts while retaining useful parallelism.
   */
  concurrency?: number;
  /**
   * Memo cache for resolved documents:
   *  - `"auto"` (default): OFF in browsers (the partitioned HTTP cache already
   *    stores each response and reuses it with no round trip), ON elsewhere
   *    (Node/Workers/Deno have no shared HTTP cache, so every fetch hits the
   *    network without one).
   *  - `true` / `false` to force, or pass your own {@link LabelStore}.
   */
  cache?: "auto" | boolean | LabelStore;
  /** Injectable fetch (tests, a pooled agent, a Worker binding). Default `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /**
   * The JSON-LD context document (parsed JSON), preloaded to skip the one-time
   * fetch that {@link LabelClient.toQuads} needs. Omit and it is fetched once
   * from `/context/labels-v1.json` and cached (per docs/consuming.md §3).
   */
  context?: unknown;
}

export interface ResolveOptions {
  /** Requested language; omit or `null` for the untagged (`und`) label. */
  lang?: string | null;
  /**
   * Language chain tried in order on a miss - the client's stand-in for the
   * server's (deliberately absent) fallback. Default: the requested language,
   * then the untagged label. Each step remains a separate cacheable resource.
   */
  fallback?: (string | null)[];
}

const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

/** Preserve order, drop duplicates - for building the fallback chain. */
function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/**
 * A canonical consumer of the RDF Label Cache. Construct once with your
 * deployed origin and reuse it - one instance keeps the connection warm, the
 * in-flight de-dupe live, and (server-side) the memo cache populated.
 */
export class LabelClient {
  readonly base: string;
  readonly order: readonly string[];
  readonly concurrency: number;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly store: LabelStore | null;
  // Per-burst de-dupe: collapses concurrent requests for the same key into one
  // fetch, then clears on settle so repeat calls revalidate through the real
  // cache (browser HTTP cache or the memo store) rather than a stale promise.
  private readonly inflight = new Map<string, Promise<LabelDoc | null>>();
  private preloadedContext: unknown;
  private compiledContext?: Promise<CompiledContext>;

  constructor(opts: LabelClientOptions) {
    if (!opts?.base) throw new Error("LabelClient: `base` (your deployed Worker origin) is required");
    this.base = opts.base.replace(/\/$/, "");
    this.order = opts.order ?? DEFAULT_ORDER;
    this.concurrency = Math.max(1, opts.concurrency ?? 100);
    this.doFetch = opts.fetch ?? globalThis.fetch;
    this.preloadedContext = opts.context;
    const cache = opts.cache ?? "auto";
    this.store =
      typeof cache === "object" ? cache
      : cache === true || (cache === "auto" && !isBrowser) ? lruStore()
      : null;
  }

  /** Build the request URL for one `(IRI, lang)` pair. */
  url(iri: string, lang: string | null = null): string {
    const u = `${this.base}/label?iri=${encodeURIComponent(iri)}`;
    return lang ? `${u}&lang=${encodeURIComponent(lang)}` : u;
  }

  /**
   * Fetch one raw JSON-LD document for a single `(IRI, lang)` key. Deduped
   * while in flight and (server-side) memoized. Returns `null` on a 404 miss
   * or any non-OK / network failure - never throws. No language fallback here;
   * use {@link resolve} for that.
   */
  document(iri: string, lang: string | null = null): Promise<LabelDoc | null> {
    const url = this.url(iri, lang);
    const cached = this.store?.get(url);
    if (cached !== undefined) return Promise.resolve(cached);
    const existing = this.inflight.get(url);
    if (existing) return existing;
    const p = this.fetchDoc(url).finally(() => this.inflight.delete(url));
    this.inflight.set(url, p);
    return p;
  }

  private async fetchDoc(url: string): Promise<LabelDoc | null> {
    let res: Response;
    try {
      // No `cache` option: we WANT the browser's HTTP cache to serve this.
      res = await this.doFetch(url, { headers: { Accept: "application/ld+json" } });
    } catch {
      return null; // network error - treat as a miss
    }
    if (!res.ok) return null; // 404 (not seeded) or any error - a miss, uncached
    let doc: LabelDoc;
    try {
      doc = (await res.json()) as LabelDoc;
    } catch {
      return null;
    }
    this.store?.set(url, doc);
    return doc;
  }

  /**
   * Resolve a single IRI to a display label, applying predicate preference and
   * the language fallback chain. Returns `null` if nothing resolves.
   */
  async resolve(iri: string, opts: ResolveOptions = {}): Promise<string | null> {
    const requested = opts.lang ?? null;
    const chain = opts.fallback ? dedupe(opts.fallback) : dedupe([requested, null]);
    for (const lang of chain) {
      const label = pickLabel(await this.document(iri, lang), this.order, lang);
      if (label) return label;
    }
    return null;
  }

  /**
   * Resolve many IRIs to labels concurrently (deduped, bounded to
   * {@link concurrency}). Returns a map of IRI → label (or `null`). This is the
   * hot path: independent, edge-cached GETs issued concurrently.
   */
  async resolveMany(iris: string[], opts: ResolveOptions = {}): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    await mapLimit(dedupe(iris), this.concurrency, async (iri) => {
      out[iri] = await this.resolve(iri, opts);
    });
    return out;
  }

  /**
   * Fetch many raw documents concurrently for one language. Returns a map of
   * IRI → document (or `null`). Use when you want the full JSON-LD, not a
   * single picked label.
   */
  async documentMany(iris: string[], lang: string | null = null): Promise<Record<string, LabelDoc | null>> {
    const out: Record<string, LabelDoc | null> = {};
    await mapLimit(dedupe(iris), this.concurrency, async (iri) => {
      out[iri] = await this.document(iri, lang);
    });
    return out;
  }

  /**
   * The JSON-LD context document (parsed JSON), fetched once from
   * `/context/labels-v1.json` and cached. It is versioned and immutable, so a
   * generous cache is safe (docs/consuming.md §3). Also hand this to a real
   * JSON-LD parser's `documentLoader` if you process responses that way.
   */
  async getContext(): Promise<unknown> {
    if (this.preloadedContext !== undefined) return this.preloadedContext;
    const res = await this.doFetch(`${this.base}/context/labels-v1.json`, {
      headers: { Accept: "application/ld+json" },
    });
    if (!res.ok) throw new Error(`LabelClient: context fetch failed (HTTP ${res.status})`);
    return (this.preloadedContext = await res.json());
  }

  /** Compile the context into an expansion table once; reused by {@link toQuads}. */
  private loadContext(): Promise<CompiledContext> {
    return (this.compiledContext ??= this.getContext().then(compileContext));
  }

  /**
   * Expand one label document into RDF triples. The raw JSON-LD only *becomes*
   * RDF once interpreted against the context; this does exactly that, driven by
   * the service's own (fetched) context, so it stays correct for any deployment
   * - including self-hosters with custom predicates. Zero-dep: emits plain
   * RDF/JS-shaped {@link Quad}s. Pass `{ factory: n3.DataFactory }` to emit that
   * library's native quads (`store.addQuads(await client.toQuads(doc, { factory: DataFactory }))`).
   */
  async toQuads(doc: LabelDoc | null, opts: { factory?: RdfDataFactory } = {}): Promise<Quad[]> {
    return expandDocument(doc, await this.loadContext(), opts.factory);
  }

  /** Expand many documents and concatenate their triples (one context load). */
  async toQuadsMany(docs: Array<LabelDoc | null>, opts: { factory?: RdfDataFactory } = {}): Promise<Quad[]> {
    const ctx = await this.loadContext();
    return docs.flatMap((d) => expandDocument(d, ctx, opts.factory));
  }

  /**
   * Browser only: preconnect to the origin so the first label request doesn't
   * pay the TLS/QUIC handshake. Safe to call on page load; a no-op elsewhere or
   * if a preconnect for this origin already exists.
   */
  preconnect(): void {
    if (!isBrowser) return;
    const href = new URL(this.base).origin;
    if (document.querySelector(`link[rel="preconnect"][href="${href}"]`)) return;
    const link = document.createElement("link");
    link.rel = "preconnect";
    link.href = href;
    link.crossOrigin = "anonymous";
    document.head.appendChild(link);
  }
}

/** Convenience factory. `createLabelClient({ base })`. */
export function createLabelClient(opts: LabelClientOptions): LabelClient {
  return new LabelClient(opts);
}

// ---------------------------------------------------------------------------
// JSON-LD expansion (context-driven, zero-dep)
// ---------------------------------------------------------------------------

/** Compiled context: term→predicate table with @language flags, plus prefix expansion. */
export interface CompiledContext {
  terms: Record<string, { id: string; language: boolean }>;
  expand(curieOrIri: string): string;
}

const asArray = <T>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);

/** A minimal absolute-IRI test: a scheme followed by `:` (RFC 3987 shape). */
const isAbsoluteIri = (s: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(s);

/**
 * Normalize one predicate's value into `[language, values]` pairs to emit.
 * A `@language` map yields one pair per tag (`@none` → untagged); anything else
 * is a single untagged group. This is where the two JSON-LD value shapes merge
 * so the emit loop stays flat.
 */
function langGroups(def: { language: boolean } | undefined, val: unknown): Array<[string | null, string | string[]]> {
  if (def?.language && val && typeof val === "object" && !Array.isArray(val)) {
    return Object.entries(val as LangMap)
      .filter(([, v]) => v != null)
      .map(([lang, v]) => [lang === "@none" ? null : lang, v as string | string[]]);
  }
  return [[null, val as string | string[]]];
}

/**
 * Pure, synchronous expansion of one label document into RDF triples against a
 * compiled context - the transform behind {@link LabelClient.toQuads}, usable
 * standalone when you already hold a context. Untagged literals are `xsd:string`,
 * language-tagged ones are `rdf:langString`. Pass an RDF/JS `factory` (e.g.
 * `n3.DataFactory`) for native quads, or omit it for plain RDF/JS-shaped objects.
 */
export function expandDocument(doc: LabelDoc | null, ctx: CompiledContext, factory?: RdfDataFactory): Quad[] {
  const id = doc?.["@id"];
  if (!doc || typeof id !== "string") return [];
  const subject = mkNamed(factory, id);
  const out: Quad[] = [];
  for (const [key, val] of Object.entries(doc)) {
    // Skip JSON-LD keywords (@id, @context, @type, …) and empty values.
    if (key[0] === "@" || val == null) continue;
    // A defined term maps to its predicate IRI; an unknown key is treated as a
    // CURIE/IRI. Anything that doesn't resolve to an absolute IRI is dropped,
    // matching JSON-LD expansion (a bare non-IRI key is not a property).
    const def = ctx.terms[key];
    const predicateIri = def ? def.id : ctx.expand(key);
    if (!isAbsoluteIri(predicateIri)) continue;
    const predicate = mkNamed(factory, predicateIri);
    for (const [lang, values] of langGroups(def, val)) {
      for (const s of asArray(values)) {
        // The store only holds string literals; ignore anything else so the
        // output is always well-formed RDF.
        if (typeof s === "string") out.push(mkQuad(factory, subject, predicate, mkLiteral(factory, s, lang)));
      }
    }
  }
  return out;
}

/**
 * Compile the service's JSON-LD context into an expansion table. The context is
 * a flat map of prefix→namespace strings and term→definition objects (each with
 * an `@id` CURIE/IRI and optionally `@container: @language`) - the only two
 * features this service uses - so no general JSON-LD processor is needed.
 */
export function compileContext(context: unknown): CompiledContext {
  const raw = (context as { "@context"?: unknown })?.["@context"] ?? context;
  const map = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const prefixes: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) if (typeof v === "string") prefixes[k] = v;
  const expand = (s: string): string => {
    const i = s.indexOf(":");
    if (i < 0) return s;
    const pfx = prefixes[s.slice(0, i)];
    return pfx ? pfx + s.slice(i + 1) : s;
  };
  const terms: Record<string, { id: string; language: boolean }> = {};
  for (const [k, v] of Object.entries(map)) {
    if (v && typeof v === "object") {
      const def = v as { "@id"?: string; "@container"?: string };
      terms[k] = { id: expand(def["@id"] ?? k), language: def["@container"] === "@language" };
    }
  }
  return { terms, expand };
}

function mkNamed(f: RdfDataFactory | undefined, value: string): RdfTerm {
  return f ? f.namedNode(value) : { termType: "NamedNode", value };
}
function mkLiteral(f: RdfDataFactory | undefined, value: string, language: string | null): RdfTerm {
  if (f) return f.literal(value, language ?? undefined);
  return language
    ? { termType: "Literal", value, language, datatype: { termType: "NamedNode", value: RDF_LANGSTRING } }
    : { termType: "Literal", value, language: "", datatype: { termType: "NamedNode", value: XSD_STRING } };
}
function mkQuad(f: RdfDataFactory | undefined, subject: RdfTerm, predicate: RdfTerm, object: RdfTerm): Quad {
  if (f) return f.quad(subject, predicate, object);
  return { subject, predicate, object, graph: { termType: "DefaultGraph", value: "" } };
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

/**
 * Run `fn` over `items` with at most `limit` in flight. A fixed pool of workers
 * pulls from a shared cursor - keeps exactly `limit` streams busy without
 * building a huge promise array up front.
 */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
