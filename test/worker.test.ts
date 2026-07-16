import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const BASE = "https://labelcache.test";
const SKOS_CONCEPT = "http://www.w3.org/2004/02/skos/core#Concept"; // untagged in the sample
const DCTERMS_TITLE = "http://purl.org/dc/terms/title"; // en-tagged in the sample

function labelUrl(iri: string, lang?: string): string {
  const q = new URLSearchParams({ iri });
  if (lang) q.set("lang", lang);
  return `${BASE}/label?${q.toString()}`;
}

// Seed the local R2 once before the suite (ENVIRONMENT=test enables /dev/seed).
beforeAll(async () => {
  const res = await SELF.fetch(`${BASE}/dev/seed`);
  expect(res.status).toBe(200);
});

describe("/label", () => {
  it("resolves an untagged IRI on a no-lang request", async () => {
    const res = await SELF.fetch(labelUrl(SKOS_CONCEPT));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/ld+json");
    const body = (await res.json()) as any;
    expect(body["@id"]).toBe(SKOS_CONCEPT);
    // untagged literal -> JSON-LD @none key
    expect(body.prefLabel).toEqual({ "@none": "Concept" });
    expect(body["@context"]).toContain("/context/labels-v1.json");
  });

  it("404s a no-lang request when only a tagged label exists", async () => {
    const res = await SELF.fetch(labelUrl(DCTERMS_TITLE)); // only en exists
    expect(res.status).toBe(404);
  });

  it("resolves a tagged IRI with ?lang=en", async () => {
    const res = await SELF.fetch(labelUrl(DCTERMS_TITLE, "en"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.prefLabel.en).toBe("Title");
  });

  it("404s ?lang=en when only an untagged label exists", async () => {
    const res = await SELF.fetch(labelUrl(SKOS_CONCEPT, "en"));
    expect(res.status).toBe(404);
  });

  it("sets short browser / long edge Cache-Control + Cache-Tag on hits", async () => {
    const res = await SELF.fetch(labelUrl(SKOS_CONCEPT));
    expect(res.headers.get("Cache-Control")).toContain("max-age=3600");
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=31536000");
    const tag = res.headers.get("Cache-Tag") ?? "";
    expect(tag).toContain("labels");
    expect(tag).toContain("labels:skos");
    expect(tag).not.toContain("all");
  });

  it("404s an unknown IRI", async () => {
    const res = await SELF.fetch(labelUrl("http://example.org/nope#Thing"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error).toBe("not_found");
  });

  it("400s when ?iri= is missing", async () => {
    const res = await SELF.fetch(`${BASE}/label`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toBe("missing_param");
  });

  it("rejects unknown and repeated query parameters", async () => {
    const unknown = await SELF.fetch(`${labelUrl(SKOS_CONCEPT)}&nonce=123`);
    expect(unknown.status).toBe(400);

    const repeated = await SELF.fetch(`${labelUrl(SKOS_CONCEPT)}&iri=${encodeURIComponent(SKOS_CONCEPT)}`);
    expect(repeated.status).toBe(400);
  });

  it("preserves a literal percent escape instead of decoding it twice", async () => {
    const iri = "https://example.org/a%2Fb";
    const res = await SELF.fetch(labelUrl(iri));
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.iri).toBe(iri);
  });

  it("rejects invalid IRI schemes and malformed language tags", async () => {
    const badIri = await SELF.fetch(`${BASE}/label?iri=urn%3Aexample%3Aterm`);
    expect(badIri.status).toBe(400);
    const badLang = await SELF.fetch(`${labelUrl(SKOS_CONCEPT)}&lang=en/au`);
    expect(badLang.status).toBe(400);
  });

  it("rejects ?lang=und (the internal untagged-storage segment)", async () => {
    const res = await SELF.fetch(`${labelUrl(SKOS_CONCEPT)}&lang=und`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toBe("invalid_param");
  });
});

describe("/namespaces", () => {
  it("lists known namespaces", async () => {
    const res = await SELF.fetch(`${BASE}/namespaces`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const prefixes = body.namespaces.map((n: any) => n.prefix);
    expect(prefixes).toContain("skos");
    expect(prefixes).toContain("owl");
    // each entry exposes prefix + namespace (base URI)
    const skos = body.namespaces.find((n: any) => n.prefix === "skos");
    expect(skos.namespace).toBe("http://www.w3.org/2004/02/skos/core#");
  });

  it("does not advertise or serve per-namespace dumps", async () => {
    const res = await SELF.fetch(`${BASE}/namespaces/skos`);
    expect(res.status).toBe(404);
  });
});

describe("/context/labels-v1.json", () => {
  it("serves the JSON-LD context document", async () => {
    const res = await SELF.fetch(`${BASE}/context/labels-v1.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body["@context"].skos).toBe("http://www.w3.org/2004/02/skos/core#");
  });

  it("stays browser-immutable (versioned URL never changes content)", async () => {
    const res = await SELF.fetch(`${BASE}/context/labels-v1.json`);
    expect(res.headers.get("Cache-Control")).toContain("immutable");
  });
});

describe("method handling", () => {
  it("405s a non-GET method", async () => {
    const res = await SELF.fetch(`${BASE}/namespaces`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("supports CORS and HEAD on public read routes only", async () => {
    const options = await SELF.fetch(`${BASE}/label`, { method: "OPTIONS" });
    expect(options.status).toBe(204);
    expect(options.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(options.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");

    const head = await SELF.fetch(labelUrl(SKOS_CONCEPT), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await head.text()).toBe("");

    const admin = await SELF.fetch(`${BASE}/admin/purge`, { method: "OPTIONS" });
    expect(admin.status).toBe(405);
    expect(admin.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("/admin/purge", () => {
  it("401s without a valid token", async () => {
    const res = await SELF.fetch(`${BASE}/admin/purge?tags=all`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("purges with a valid token", async () => {
    const res = await SELF.fetch(`${BASE}/admin/purge?tags=labels`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.purged).toEqual(["labels"]);
  });

  it("405s a GET on the purge endpoint", async () => {
    const res = await SELF.fetch(`${BASE}/admin/purge`);
    expect(res.status).toBe(405);
  });

  it("uses the scoped data tags by default", async () => {
    const res = await SELF.fetch(`${BASE}/admin/purge`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.purged).toEqual(["labels", "context", "namespaces"]);
  });
});
