// Unit tests for the JSON-LD → RDF expansion (the important bit).
// Zero new deps: Node's built-in test runner + assert, run against the built
// dist. Uses a mock RDF/JS DataFactory to prove the factory wiring without
// pulling in n3.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileContext,
  expandDocument,
  createLabelClient,
  pickLabel,
  lruStore,
  DEFAULT_ORDER,
} from "../dist/index.js";

const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const SKOS = "http://www.w3.org/2004/02/skos/core#";
const EX = "http://example.org/";
const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";
const RDF_LANGSTRING = "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString";

const RAW_CONTEXT = {
  "@context": {
    rdfs: RDFS,
    skos: SKOS,
    ex: EX,
    label: { "@id": "rdfs:label", "@container": "@language" },
    prefLabel: { "@id": "skos:prefLabel", "@container": "@language" },
    altLabel: { "@id": "skos:altLabel", "@container": "@language" },
  },
};
const CTX = compileContext(RAW_CONTEXT);

const iri = (t) => t.termType === "NamedNode" && t.value;
const lit = (t) => t.termType === "Literal";

// --------------------------------------------------------------------------
// compileContext
// --------------------------------------------------------------------------

test("compileContext: builds term table with @language flag and expanded @id", () => {
  assert.deepEqual(CTX.terms.prefLabel, { id: `${SKOS}prefLabel`, language: true });
  assert.deepEqual(CTX.terms.label, { id: `${RDFS}label`, language: true });
});

test("compileContext: expands known CURIEs, passes through absolute IRIs and unknown prefixes", () => {
  assert.equal(CTX.expand("skos:prefLabel"), `${SKOS}prefLabel`);
  assert.equal(CTX.expand("ex:custom"), `${EX}custom`);
  assert.equal(CTX.expand("http://x/y"), "http://x/y");
  assert.equal(CTX.expand("nope:foo"), "nope:foo"); // unknown prefix, left as-is
  assert.equal(CTX.expand("plain"), "plain");
});

test("compileContext: accepts a bare context map (no @context wrapper)", () => {
  const c = compileContext(RAW_CONTEXT["@context"]);
  assert.deepEqual(c.terms.label, { id: `${RDFS}label`, language: true });
});

// --------------------------------------------------------------------------
// expandDocument — zero-dep (plain RDF/JS objects)
// --------------------------------------------------------------------------

test("expands a language-tagged literal to an rdf:langString triple", () => {
  const [q, ...rest] = expandDocument({ "@id": `${EX}a`, prefLabel: { en: "Alpha" } }, CTX);
  assert.equal(rest.length, 0);
  assert.equal(iri(q.subject), `${EX}a`);
  assert.equal(iri(q.predicate), `${SKOS}prefLabel`);
  assert.ok(lit(q.object));
  assert.equal(q.object.value, "Alpha");
  assert.equal(q.object.language, "en");
  assert.equal(q.object.datatype.value, RDF_LANGSTRING);
  assert.equal(q.graph.termType, "DefaultGraph");
});

test("expands an untagged (@none) literal to an xsd:string triple", () => {
  const [q] = expandDocument({ "@id": `${EX}a`, label: { "@none": "Alpha" } }, CTX);
  assert.equal(iri(q.predicate), `${RDFS}label`);
  assert.equal(q.object.value, "Alpha");
  assert.equal(q.object.language, "");
  assert.equal(q.object.datatype.value, XSD_STRING);
});

test("expands an array value to one triple per value, order preserved", () => {
  const quads = expandDocument({ "@id": `${EX}a`, altLabel: { en: ["x", "y", "z"] } }, CTX);
  assert.deepEqual(quads.map((q) => q.object.value), ["x", "y", "z"]);
  assert.ok(quads.every((q) => iri(q.predicate) === `${SKOS}altLabel` && q.object.language === "en"));
});

test("expands multiple predicates on one subject", () => {
  const quads = expandDocument(
    { "@id": `${EX}a`, prefLabel: { en: "Alpha" }, label: { en: "A" }, altLabel: { en: ["a1", "a2"] } },
    CTX,
  );
  assert.equal(quads.length, 4);
  assert.deepEqual(
    [...new Set(quads.map((q) => iri(q.predicate)))].sort(),
    [`${SKOS}altLabel`, `${SKOS}prefLabel`, `${RDFS}label`].sort(),
  );
});

test("carries @context/@id but never emits them as triples", () => {
  const quads = expandDocument(
    { "@context": "https://host/context/labels-v1.json", "@id": `${EX}a`, label: { en: "A" } },
    CTX,
  );
  assert.equal(quads.length, 1);
  assert.equal(iri(quads[0].predicate), `${RDFS}label`);
});

test("expands an unknown-but-known-prefix CURIE with a scalar value", () => {
  const [q] = expandDocument({ "@id": `${EX}a`, "ex:note": "hi" }, CTX);
  assert.equal(iri(q.predicate), `${EX}note`);
  assert.equal(q.object.value, "hi");
  assert.equal(q.object.datatype.value, XSD_STRING);
});

test("drops a bare non-IRI key (matches JSON-LD expansion)", () => {
  assert.deepEqual(expandDocument({ "@id": `${EX}a`, randomField: { en: "x" } }, CTX), []);
});

test("drops non-string literal values", () => {
  assert.deepEqual(expandDocument({ "@id": `${EX}a`, label: { en: 42 } }, CTX), []);
});

test("returns [] for null, missing @id, or non-string @id", () => {
  assert.deepEqual(expandDocument(null, CTX), []);
  assert.deepEqual(expandDocument({ label: { en: "A" } }, CTX), []);
  assert.deepEqual(expandDocument({ "@id": 123, label: { en: "A" } }, CTX), []);
});

test("skips empty (null/undefined) predicate values", () => {
  assert.deepEqual(expandDocument({ "@id": `${EX}a`, label: null }, CTX), []);
});

// --------------------------------------------------------------------------
// expandDocument — with an RDF/JS DataFactory (interop wiring)
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// pickLabel — alias-based, context-independent
// --------------------------------------------------------------------------

test("pickLabel: preference order picks the first present alias", () => {
  const doc = { "@id": "x", label: { "@none": "L" }, name: { "@none": "N" } };
  assert.equal(pickLabel(doc, DEFAULT_ORDER), "L"); // label precedes name
  assert.equal(pickLabel(doc, ["name", "label"]), "N"); // custom order flips it
});

test("pickLabel: keys on the alias, oblivious to the IRI behind it", () => {
  // The context maps `name` to foaf:name here, not schema:name - picking still
  // works because pickLabel reads the `name` KEY, never the IRI.
  const doc = { "@id": "x", name: { "@none": "Ada" } };
  assert.equal(pickLabel(doc, DEFAULT_ORDER), "Ada");
});

test("pickLabel: a renamed alias misses the default but works via custom order", () => {
  const doc = { "@id": "x", pref_label: { "@none": "P" } }; // non-standard alias
  assert.equal(pickLabel(doc, DEFAULT_ORDER), null);
  assert.equal(pickLabel(doc, ["pref_label"]), "P");
});

test("pickLabel: null doc, empty order, and language preference", () => {
  assert.equal(pickLabel(null), null);
  assert.equal(pickLabel({ "@id": "x", label: { en: "L" } }, []), null);
  const doc = { "@id": "x", label: { en: "hi", fr: "salut" } };
  assert.equal(pickLabel(doc, ["label"], "fr"), "salut");
});

function mockFactory(calls) {
  return {
    namedNode: (value) => (calls.push(["namedNode", value]), { termType: "NamedNode", value }),
    literal: (value, lod) => (calls.push(["literal", value, lod ?? null]), { termType: "Literal", value, lod }),
    quad: (subject, predicate, object) => (calls.push(["quad", subject.value, predicate.value, object.value]), {
      subject,
      predicate,
      object,
      graph: { termType: "DefaultGraph", value: "" },
    }),
  };
}

test("factory path: routes every term through the factory, tagged vs untagged", () => {
  const calls = [];
  const quads = expandDocument(
    { "@id": `${EX}a`, prefLabel: { en: "Alpha" }, label: { "@none": "A" } },
    CTX,
    mockFactory(calls),
  );
  assert.equal(quads.length, 2);
  // language tag passed through for tagged; undefined (→ xsd:string) for untagged
  assert.ok(calls.some((c) => c[0] === "literal" && c[1] === "Alpha" && c[2] === "en"));
  assert.ok(calls.some((c) => c[0] === "literal" && c[1] === "A" && c[2] === null));
  assert.ok(calls.some((c) => c[0] === "namedNode" && c[1] === `${SKOS}prefLabel`));
  assert.ok(calls.some((c) => c[0] === "quad" && c[1] === `${EX}a`));
});

// --------------------------------------------------------------------------
// client.toQuads / toQuadsMany (async, preloaded context)
// --------------------------------------------------------------------------

const offlineClient = () =>
  createLabelClient({
    base: "https://host",
    context: RAW_CONTEXT,
    fetch: async () => ({ ok: false, status: 404 }),
  });

test("client.toQuads matches the pure expandDocument", async () => {
  const doc = { "@id": `${EX}a`, prefLabel: { en: "Alpha" }, altLabel: { en: ["x", "y"] } };
  const viaClient = await offlineClient().toQuads(doc);
  const viaPure = expandDocument(doc, CTX);
  assert.deepEqual(viaClient, viaPure);
  assert.equal(viaClient.length, 3);
});

test("client.toQuadsMany concatenates and skips null docs", async () => {
  const quads = await offlineClient().toQuadsMany([
    { "@id": `${EX}a`, label: { en: "A" } },
    null,
    { "@id": `${EX}b`, label: { en: "B" } },
  ]);
  assert.deepEqual(quads.map((q) => q.subject.value), [`${EX}a`, `${EX}b`]);
});

test("lruStore expires entries at its configured TTL", () => {
  const store = lruStore(10, 0);
  store.set("label", { "@id": `${EX}label` });
  assert.equal(store.get("label"), undefined);
});

test("client treats an invalid success body as a miss", async () => {
  const client = createLabelClient({
    base: "https://host",
    cache: false,
    fetch: async () => new Response("not json", { status: 200 }),
  });
  assert.equal(await client.document(`${EX}bad`), null);
});
