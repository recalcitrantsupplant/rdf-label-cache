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

  it("sets immutable Cache-Control + Cache-Tag on hits", async () => {
    const res = await SELF.fetch(labelUrl(SKOS_CONCEPT));
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    const tag = res.headers.get("Cache-Tag") ?? "";
    expect(tag).toContain("all");
    expect(tag).toContain("labels:skos");
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
});

describe("/context/labels-v1.json", () => {
  it("serves the JSON-LD context document", async () => {
    const res = await SELF.fetch(`${BASE}/context/labels-v1.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body["@context"].skos).toBe("http://www.w3.org/2004/02/skos/core#");
  });
});

describe("method handling", () => {
  it("405s a non-GET method", async () => {
    const res = await SELF.fetch(`${BASE}/namespaces`, { method: "POST" });
    expect(res.status).toBe(405);
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
});
