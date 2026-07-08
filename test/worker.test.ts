import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const BASE = "https://labelcache.test";
const SKOS_CONCEPT = "http://www.w3.org/2004/02/skos/core#Concept";

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
  it("resolves a known IRI to JSON-LD", async () => {
    const res = await SELF.fetch(labelUrl(SKOS_CONCEPT));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/ld+json");
    const body = (await res.json()) as any;
    expect(body["@id"]).toBe(SKOS_CONCEPT);
    expect(body.prefLabel).toEqual({ en: "Concept" });
    expect(body["@context"]).toContain("/context/labels-v1.json");
  });

  it("resolves with an explicit lang", async () => {
    const res = await SELF.fetch(labelUrl(SKOS_CONCEPT, "en"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.prefLabel.en).toBe("Concept");
  });

  it("sets a cacheable Cache-Control on hits", async () => {
    const res = await SELF.fetch(labelUrl(SKOS_CONCEPT));
    expect(res.headers.get("Cache-Control")).toContain("max-age=86400");
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
