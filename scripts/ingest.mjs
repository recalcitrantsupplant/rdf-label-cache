#!/usr/bin/env node
// Ingest common ontologies into the label-store key structure.
//
// Fetches (or reads) each vocabulary, extracts label + description literals for
// every term defined in the namespace, and writes a flat manifest of the exact
// R2 keys the Worker resolves, each with its JSON-LD body:
//
//   labels/{lang}/{iri}           ← one object per (IRI, language); untagged -> `und`
//   context/labels-v1.json        ← shared JSON-LD context
//
// Output is a manifest (dist/seed/manifest.ndjson: one {key, body} per line),
// not a file tree - keys like schema/Text and schema/text are distinct in R2
// but collide as paths on case-insensitive filesystems. Upload with
// scripts/upload-seed.mjs (S3 API). Keys are lang-FIRST (labels/{lang}/{iri}) so
// the fixed lang segment can't collide with the slashed IRI, and each language
// is a listable prefix. Language tags are preserved faithfully - untagged
// literals stay untagged (served on a no-`lang` request); nothing is coerced.
//
// Sources: w3.org namespace docs are Cloudflare-challenged (403 to scripts), so
// rdf/rdfs/owl/skos are hand-curated Turtle under scripts/vocab/. dcterms, dcat
// (via the W3C DXWG GitHub mirror) and schema.org fetch cleanly.
//
// Modes:
//   node ingest.mjs                     all public vocabularies
//   node ingest.mjs --only skos,rdf     just those vocabularies
//   node ingest.mjs --input data.ttl    your own RDF dump instead
//   node ingest.mjs --input labels/     every RDF file in a folder (multi-file)
//
// `--input` accepts a single RDF file OR a directory. A directory ingests every
// RDF file inside it (see RDF_EXTS) in sorted order, merging their quads before
// extraction - the drop-a-folder-of-labels convention the GitHub Action seed
// path uses (see docs/one-click-onboarding-design.md).
//
// Label/description predicates default to the JSON-LD context's families (see
// DEFAULT_LABEL_PREDS / DEFAULT_DESC_PREDS, kept in sync with extract-labels.rq).
// Override per run: `--label-preds <iri,…>` / `--desc-preds <iri,…>` (list order =
// priority when one subject has several).
import { readFile, writeFile, mkdir, rm, stat, readdir } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import N3 from "n3";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "dist", "seed");
// SEED_BASE is the deployed origin, baked into every object's @context URL.
// Required and explicit: a wrong/placeholder value silently bakes the wrong host
// into all seeded objects, so fail fast rather than default to any instance.
if (!process.env.SEED_BASE) {
  console.error("Missing required env: SEED_BASE (your deployed Worker origin, e.g. https://label-cache-<project>.<subdomain>.workers.dev — baked into each object's @context URL)");
  process.exit(1);
}
const BASE = process.env.SEED_BASE.replace(/\/$/, "");
const CONTEXT_URL = `${BASE}/context/labels-v1.json`;
// `--input <file>` ingests your own RDF dump instead of the public ontologies.
const inputIdx = process.argv.indexOf("--input");
const INPUT = inputIdx > -1 ? process.argv[inputIdx + 1] : null;
// `--only <ns,ns,…>` (public-ontology mode only) restricts the seed to the
// named vocabularies, e.g. `--only skos,rdf,rdfs`. Omit for all of them.
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx > -1
  ? new Set(process.argv[onlyIdx + 1].split(",").map((s) => s.trim()).filter(Boolean))
  : null;

// Which predicates carry the label (→ prefLabel) and the description (→ definition).
// Defaults mirror the JSON-LD context's label/description families and are kept in
// sync with scripts/extract-labels.rq so the file and SPARQL paths agree. Override
// with `--label-preds <iri,iri,…>` / `--desc-preds <iri,iri,…>` (full IRIs, comma-
// separated); the flag REPLACES the default list. List ORDER is priority: for a
// given (IRI, language) the value from the earliest-listed predicate present wins,
// so `--label-preds` order is how you resolve prefLabel-vs-label-vs-title conflicts.
const DEFAULT_LABEL_PREDS = [
  "http://www.w3.org/2004/02/skos/core#prefLabel",
  "http://www.w3.org/2000/01/rdf-schema#label",
  "http://purl.org/dc/terms/title",
  "https://schema.org/name",
  "http://schema.org/name",
];
const DEFAULT_DESC_PREDS = [
  "http://www.w3.org/2004/02/skos/core#definition",
  "http://www.w3.org/2000/01/rdf-schema#comment",
  "http://purl.org/dc/terms/description",
  "https://schema.org/description",
  "http://schema.org/description",
];
const predArg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const list = (process.argv[i + 1] || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) {
    console.error(`Missing value for ${flag} (comma-separated predicate IRIs)`);
    process.exit(1);
  }
  return list;
};
const LABEL_PREDS = predArg("--label-preds", DEFAULT_LABEL_PREDS);
const DESC_PREDS = predArg("--desc-preds", DEFAULT_DESC_PREDS);

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

// Collect labels + descriptions FAITHFULLY: keep every (subject, language) pair
// as-is - untagged literals stay untagged (lang ""), tags are preserved, nothing
// is coerced to a default language. Shape: iri -> Map(lang -> value).
//
// Predicate list order defines priority: for each (iri, lang) the value from the
// earliest-listed predicate present wins, deterministically, regardless of quad
// order in the source. Ties within the same predicate keep the first literal seen.
function collectLiterals(quads, accept) {
  const labelRank = new Map(LABEL_PREDS.map((p, i) => [p, i]));
  const descRank = new Map(DESC_PREDS.map((p, i) => [p, i]));
  const labels = new Map(); // iri -> Map(lang -> { value, rank })
  const defs = new Map();
  const consider = (map, rank, iri, lang, value) => {
    if (rank === undefined) return;
    let m = map.get(iri);
    if (!m) map.set(iri, (m = new Map()));
    const cur = m.get(lang);
    if (!cur || rank < cur.rank) m.set(lang, { value, rank });
  };
  for (const q of quads) {
    if (q.subject.termType !== "NamedNode" || q.object.termType !== "Literal") continue;
    if (!accept(q.subject.value)) continue;
    const lang = q.object.language || "";
    consider(labels, labelRank.get(q.predicate.value), q.subject.value, lang, q.object.value);
    consider(defs, descRank.get(q.predicate.value), q.subject.value, lang, q.object.value);
  }
  const strip = (map) => {
    for (const [, byLang] of map) for (const [lang, v] of byLang) byLang.set(lang, v.value);
    return map;
  };
  return { labels: strip(labels), defs: strip(defs) };
}

// Flatten to one record per (iri, language): { iri, lang, label, definition }.
// The description is matched by the same language as the label.
function toRecords(labels, defs) {
  const recs = [];
  for (const [iri, byLang] of labels) {
    for (const [lang, label] of byLang) {
      recs.push({ iri, lang, label, definition: defs.get(iri)?.get(lang) });
    }
  }
  return recs;
}

// A public ontology: terms are those defined in the namespace, keyed by its alias.
async function ingestSource(src) {
  const quads = await parseRDF(await loadText(src));
  const { labels, defs } = collectLiterals(
    quads,
    (iri) => iri.startsWith(src.base) && iri.length > src.base.length && !/[/#?]/.test(iri.slice(src.base.length))
  );
  return toRecords(labels, defs);
}

// RDF file extensions ingested from an `--input` directory. N3's parser is a
// superset of Turtle/N-Triples/TriG/N-Quads, so those all parse; JSON-LD does
// not and is deliberately excluded. Non-RDF files (e.g. a README) are skipped.
const RDF_EXTS = new Set([".ttl", ".turtle", ".nt", ".n3", ".nq", ".trig"]);

// Resolve `--input` to the list of files to parse: a single file stays itself;
// a directory expands to its RDF files in sorted (deterministic) order.
async function resolveInputFiles(input) {
  if (!(await stat(input)).isDirectory()) return [input];
  const entries = await readdir(input, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && RDF_EXTS.has(extname(e.name).toLowerCase()))
    .map((e) => join(input, e.name))
    .sort();
  if (!files.length) {
    throw new Error(`No RDF files (${[...RDF_EXTS].join(", ")}) in ${input}/`);
  }
  return files;
}

// A user RDF dump (e.g. a SPARQL CONSTRUCT of your data's annotation props), or a
// folder of them: every labelled subject IRI is emitted - keying is namespace-
// agnostic, so no registration is needed. Quads from all files are merged before
// extraction, so cross-file (IRI, language) precedence follows the same predicate
// list-order rule; ties keep the first literal seen in sorted file order.
async function ingestDump(input) {
  const files = await resolveInputFiles(input);
  const quads = [];
  for (const file of files) {
    if (files.length > 1) process.stdout.write(`    + ${file}\n`);
    quads.push(...(await parseRDF(await readFile(file, "utf8"))));
  }
  const { labels, defs } = collectLiterals(quads, () => true);
  return toRecords(labels, defs);
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

  const writeTerms = (nsLabel, records) => {
    for (const t of records) {
      // lang-first key; untagged -> `und` segment. Mirrors src/routes/label.ts.
      const key = `labels/${t.lang || "und"}/${t.iri}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // JSON-LD @language map: the real tag as the key, `@none` for untagged.
      const lk = t.lang || "@none";
      const doc = { "@context": CONTEXT_URL, "@id": t.iri, prefLabel: { [lk]: t.label } };
      if (t.definition) doc.definition = { [lk]: t.definition };
      emit(key, JSON.stringify(doc));
    }
    summary.push({ ns: nsLabel, terms: records.length, withDefinition: records.filter((t) => t.definition).length });
    total += records.length;
  };

  if (INPUT) {
    process.stdout.write(`  dump      ${INPUT}\n`);
    writeTerms("your-data", await ingestDump(INPUT));
  } else {
    if (ONLY) {
      const unknown = [...ONLY].filter((ns) => !SOURCES.some((s) => s.ns === ns));
      if (unknown.length) {
        throw new Error(`--only: unknown namespace(s) ${unknown.join(", ")} - valid: ${SOURCES.map((s) => s.ns).join(", ")}`);
      }
    }
    for (const src of SOURCES) {
      if (ONLY && !ONLY.has(src.ns)) continue;
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
