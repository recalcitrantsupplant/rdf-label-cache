#!/usr/bin/env node
// Ingest common ontologies into the label-store key structure.
//
// Fetches (or reads) each vocabulary, extracts label + description literals for
// every term defined in the namespace, and writes a flat manifest of the exact
// R2 keys the Worker resolves, each with its JSON-LD body:
//
//   labels/{ns}/{local}/en        ← per-language object (English)
//   context/labels-v1.json        ← shared JSON-LD context
//
// Output is a manifest (dist/seed/manifest.ndjson: one {key, body} per line),
// not a file tree — keys like schema/Text and schema/text are distinct in R2
// but collide as paths on case-insensitive filesystems. Upload with
// scripts/upload-seed.mjs (S3 API). Only per-language keys are emitted; the
// all-languages bundle (§4.1) is optional and the demo sends ?lang=en.
//
// Sources: w3.org namespace docs are Cloudflare-challenged (403 to scripts), so
// rdf/rdfs/owl/skos are hand-curated Turtle under scripts/vocab/. dcterms, dcat
// (via the W3C DXWG GitHub mirror) and schema.org fetch cleanly.
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import N3 from "n3";
import NS from "../src/lib/namespaces.json" with { type: "json" };

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "dist", "seed");
const BASE = (process.env.SEED_BASE || "https://rdf-label-cache.dhabgood.workers.dev").replace(/\/$/, "");
const CONTEXT_URL = `${BASE}/context/labels-v1.json`;
// `--input <file>` ingests your own RDF dump instead of the public ontologies.
const inputIdx = process.argv.indexOf("--input");
const INPUT = inputIdx > -1 ? process.argv[inputIdx + 1] : null;

// Mirror of the Worker's parseIRI (src/lib/namespaces.ts): split on the last #
// or / (# wins), look up the namespace alias. Returns null for namespaces not
// registered in namespaces.json — those IRIs would 404, so we skip them.
function parseKey(iri) {
  const hashIdx = iri.lastIndexOf("#");
  const at = hashIdx !== -1 ? hashIdx : iri.lastIndexOf("/");
  if (at === -1 || at === iri.length - 1) return null;
  const alias = NS[iri.slice(0, at + 1)];
  const local = iri.slice(at + 1);
  return alias && local ? { alias, local } : null;
}

// Kept in sync with src/routes/dev-seed.ts CONTEXT_DOC.
const CONTEXT_DOC = {
  "@context": {
    rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    rdfs: "http://www.w3.org/2000/01/rdf-schema#",
    owl: "http://www.w3.org/2002/07/owl#",
    skos: "http://www.w3.org/2004/02/skos/core#",
    skosxl: "http://www.w3.org/2008/05/skos-xl#",
    dc: "http://purl.org/dc/elements/1.1/",
    dcterms: "http://purl.org/dc/terms/",
    schema: "https://schema.org/",
    xsd: "http://www.w3.org/2001/XMLSchema#",
    dcat: "http://www.w3.org/ns/dcat#",
    prov: "http://www.w3.org/ns/prov#",
    foaf: "http://xmlns.com/foaf/0.1/",
    void: "http://rdfs.org/ns/void#",
    label: { "@id": "rdfs:label", "@container": "@language" },
    prefLabel: { "@id": "skos:prefLabel", "@container": "@language" },
    altLabel: { "@id": "skos:altLabel", "@container": "@language" },
    definition: { "@id": "skos:definition", "@container": "@language" },
    comment: { "@id": "rdfs:comment", "@container": "@language" },
    title: { "@id": "dcterms:title", "@container": "@language" },
    name: { "@id": "schema:name", "@container": "@language" },
  },
};

const SOURCES = [
  { ns: "rdf", base: "http://www.w3.org/1999/02/22-rdf-syntax-ns#", file: "vocab/rdf.ttl" },
  { ns: "rdfs", base: "http://www.w3.org/2000/01/rdf-schema#", file: "vocab/rdfs.ttl" },
  { ns: "owl", base: "http://www.w3.org/2002/07/owl#", file: "vocab/owl.ttl" },
  { ns: "skos", base: "http://www.w3.org/2004/02/skos/core#", file: "vocab/skos.ttl" },
  { ns: "dcterms", base: "http://purl.org/dc/terms/", url: "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/dublin_core_terms.ttl" },
  { ns: "dcat", base: "http://www.w3.org/ns/dcat#", url: "https://raw.githubusercontent.com/w3c/dxwg/gh-pages/dcat/rdf/dcat.ttl" },
  { ns: "schema", base: "https://schema.org/", url: "https://schema.org/version/latest/schemaorg-current-https.nt" },
];

const LABEL_PREDS = new Set([
  "http://www.w3.org/2000/01/rdf-schema#label",
  "http://www.w3.org/2004/02/skos/core#prefLabel",
]);
const DESC_PREDS = new Set([
  "http://www.w3.org/2000/01/rdf-schema#comment",
  "http://www.w3.org/2004/02/skos/core#definition",
  "http://purl.org/dc/terms/description",
  "https://schema.org/description",
  "http://schema.org/description",
]);

// Prefer English, then untagged, then anything; keep the first on a tie.
const langRank = (l) => (l === "en" ? 0 : !l ? 1 : 2);
const better = (cur, lit) => (!cur || langRank(lit.lang) < langRank(cur.lang) ? lit : cur);

async function loadText(src) {
  if (src.file) return readFile(join(ROOT, "scripts", src.file), "utf8");
  const res = await fetch(src.url, { headers: { "User-Agent": "labelcache-ingest/1.0" } });
  if (!res.ok) throw new Error(`${src.url} → HTTP ${res.status}`);
  return res.text();
}

function parseRDF(text) {
  return new Promise((resolve, reject) => {
    const quads = [];
    // The Turtle parser is a superset of N-Triples, so it handles both.
    new N3.Parser().parse(text, (err, quad) => {
      if (err) reject(err);
      else if (quad) quads.push(quad);
      else resolve(quads);
    });
  });
}

// Collect the best label + description literal for each accepted subject IRI.
function collectLiterals(quads, accept) {
  const labels = new Map(); // iri -> {lang, value}
  const defs = new Map();
  for (const q of quads) {
    if (q.subject.termType !== "NamedNode" || q.object.termType !== "Literal") continue;
    if (!accept(q.subject.value)) continue;
    const lit = { lang: q.object.language || "", value: q.object.value };
    if (LABEL_PREDS.has(q.predicate.value)) labels.set(q.subject.value, better(labels.get(q.subject.value), lit));
    else if (DESC_PREDS.has(q.predicate.value)) defs.set(q.subject.value, better(defs.get(q.subject.value), lit));
  }
  return { labels, defs };
}

// A public ontology: terms are those defined in the namespace, keyed by its alias.
async function ingestSource(src) {
  const quads = await parseRDF(await loadText(src));
  const { labels, defs } = collectLiterals(
    quads,
    (iri) => iri.startsWith(src.base) && iri.length > src.base.length && !/[/#?]/.test(iri.slice(src.base.length))
  );
  const terms = [];
  for (const [iri, label] of labels) {
    terms.push({ iri, ns: src.ns, local: iri.slice(src.base.length), label: label.value, definition: defs.get(iri)?.value });
  }
  return terms;
}

// A user RDF dump (e.g. a SPARQL CONSTRUCT of your data's annotation props):
// every subject IRI is a candidate, keyed via the registered namespaces.
async function ingestDump(file) {
  const { labels, defs } = collectLiterals(await parseRDF(await readFile(file, "utf8")), () => true);
  const terms = [];
  const unregistered = new Map(); // namespace prefix -> count
  for (const [iri, label] of labels) {
    const k = parseKey(iri);
    if (!k) {
      const hashIdx = iri.lastIndexOf("#");
      const at = hashIdx !== -1 ? hashIdx : iri.lastIndexOf("/");
      unregistered.set(iri.slice(0, at + 1), (unregistered.get(iri.slice(0, at + 1)) || 0) + 1);
      continue;
    }
    terms.push({ iri, ns: k.alias, local: k.local, label: label.value, definition: defs.get(iri)?.value });
  }
  if (unregistered.size) {
    const dropped = [...unregistered.values()].reduce((a, b) => a + b, 0);
    console.warn(`\n  ⚠ skipped ${dropped} labelled IRIs in unregistered namespaces — add these to src/lib/namespaces.json and redeploy:`);
    for (const [pfx, n] of [...unregistered].sort((a, b) => b[1] - a[1])) console.warn(`      ${String(n).padStart(6)}  ${pfx}`);
  }
  return terms;
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const lines = [];
  const emit = (key, body) => lines.push(JSON.stringify({ key, body }));
  emit("context/labels-v1.json", JSON.stringify(CONTEXT_DOC));

  const summary = [];
  let total = 0;
  const seen = new Set(); // exact-key duplicate guard (across namespaces)

  const writeTerms = (label, terms) => {
    for (const t of terms) {
      const key = `labels/${t.ns}/${t.local}/en`;
      if (seen.has(key)) continue;
      seen.add(key);
      const doc = { "@context": CONTEXT_URL, "@id": t.iri, prefLabel: { en: t.label } };
      if (t.definition) doc.definition = { en: t.definition };
      emit(key, JSON.stringify(doc));
    }
    summary.push({ ns: label, terms: terms.length, withDefinition: terms.filter((t) => t.definition).length });
    total += terms.length;
  };

  if (INPUT) {
    process.stdout.write(`  dump      ${INPUT}\n`);
    writeTerms("your-data", await ingestDump(INPUT));
  } else {
    for (const src of SOURCES) {
      process.stdout.write(`  ${src.ns.padEnd(8)} ${src.file || src.url}\n`);
      writeTerms(src.ns, await ingestSource(src));
    }
  }

  await writeFile(join(OUT, "manifest.ndjson"), lines.join("\n") + "\n");
  await writeFile(join(OUT, "summary.json"), JSON.stringify({ base: BASE, total, objects: lines.length, namespaces: summary }, null, 2));
  console.log("\n  namespace  terms  with-definition");
  for (const s of summary) console.log(`  ${s.ns.padEnd(9)}  ${String(s.terms).padStart(5)}  ${String(s.withDefinition).padStart(5)}`);
  console.log(`\n  ${total} terms · ${lines.length} objects → ${join(OUT, "manifest.ndjson")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
