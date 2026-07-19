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
// path uses (see "Get started fast" in README.md).
//
// Label/description predicates default to the JSON-LD context's families (see
// LABEL_TERMS / DESC_TERMS, kept in sync with extract-labels.rq). Every harvested
// predicate is stored under its OWN JSON-LD term - nothing is coerced to prefLabel,
// and a term may hold several values per language. Precedence is a consumer choice.
// Override the harvested set per run: `--label-preds <iri,…>` / `--desc-preds <iri,…>`.
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

// Which RDF predicates we harvest, and the JSON-LD term each is stored under.
// We do NOT coerce across predicates: skos:prefLabel, rdfs:label, dcterms:title,
// schema:name and skos:altLabel each keep their own term, as do the description
// predicates. A (term, language) may carry several values - all are preserved.
// Precedence ("prefer prefLabel over label over …") is a CONSUMER concern; we
// store every predicate faithfully and the client picks. Kept in sync with the
// JSON-LD context (CONTEXT_DOC) and scripts/extract-labels.rq.
//
// The only merges are genuine synonyms, not precedence choices: the two schema.org
// rows are one predicate under http+https, and schema:description is folded into
// dcterms `description`. Override the harvested set with `--label-preds` /
// `--desc-preds` (comma-separated IRIs); a recognised predicate keeps its friendly
// term, an unrecognised one falls back to the family term (`label` / `description`).
const LABEL_TERMS = {
  "http://www.w3.org/2004/02/skos/core#prefLabel": "prefLabel",
  "http://www.w3.org/2004/02/skos/core#altLabel": "altLabel",
  "http://www.w3.org/2000/01/rdf-schema#label": "label",
  "http://purl.org/dc/terms/title": "title",
  "https://schema.org/name": "name",
  "http://schema.org/name": "name",
};
const DESC_TERMS = {
  "http://www.w3.org/2004/02/skos/core#definition": "definition",
  "http://www.w3.org/2000/01/rdf-schema#comment": "comment",
  "http://purl.org/dc/terms/description": "description",
  "https://schema.org/description": "description",
  "http://schema.org/description": "description",
};
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
// predicate IRI -> JSON-LD term. Custom predicates supplied via the flags fall
// back to their family's generic term (`label` / `description`).
const PRED_TERM = new Map();
for (const p of predArg("--label-preds", Object.keys(LABEL_TERMS))) PRED_TERM.set(p, LABEL_TERMS[p] || "label");
for (const p of predArg("--desc-preds", Object.keys(DESC_TERMS))) PRED_TERM.set(p, DESC_TERMS[p] || "description");
// Terms that count as a description in the run-summary tally.
const DESC_TERM_SET = new Set(Object.values(DESC_TERMS));

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
    description: { "@id": "dcterms:description", "@container": "@language" },
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

// Harvest annotation literals FAITHFULLY into:
//   iri -> Map(term -> Map(lang -> string[]))
// Every harvested predicate keeps its own term; a (term, language) may carry many
// values, all preserved (exact duplicates dropped, first-seen order kept). Untagged
// literals stay untagged (lang ""); nothing is coerced to a default language OR a
// default predicate. Deterministic regardless of quad order in the source.
function collectLiterals(quads, accept) {
  const out = new Map();
  for (const q of quads) {
    if (q.subject.termType !== "NamedNode" || q.object.termType !== "Literal") continue;
    const term = PRED_TERM.get(q.predicate.value);
    if (!term) continue;
    if (!accept(q.subject.value)) continue;
    const lang = q.object.language || "";
    let byTerm = out.get(q.subject.value);
    if (!byTerm) out.set(q.subject.value, (byTerm = new Map()));
    let byLang = byTerm.get(term);
    if (!byLang) byTerm.set(term, (byLang = new Map()));
    let vals = byLang.get(lang);
    if (!vals) byLang.set(lang, (vals = []));
    if (!vals.includes(q.object.value)) vals.push(q.object.value);
  }
  return out;
}

// Flatten to one record per (iri, language): { iri, lang, terms }, where `terms`
// maps each JSON-LD term to its value - a string, or an array when several values
// share that (term, language). The whole (iri, lang) becomes a single R2 object.
function toRecords(byIri) {
  const recs = new Map(); // `${iri}\t${lang}` -> record
  for (const [iri, byTerm] of byIri) {
    for (const [term, byLang] of byTerm) {
      for (const [lang, vals] of byLang) {
        const k = `${iri}\t${lang}`;
        let rec = recs.get(k);
        if (!rec) recs.set(k, (rec = { iri, lang, terms: {} }));
        rec.terms[term] = vals.length === 1 ? vals[0] : vals;
      }
    }
  }
  return [...recs.values()];
}

// A public ontology: terms are those defined in the namespace, keyed by its alias.
async function ingestSource(src) {
  const quads = await parseRDF(await loadText(src));
  return toRecords(collectLiterals(
    quads,
    (iri) => iri.startsWith(src.base) && iri.length > src.base.length && !/[/#?]/.test(iri.slice(src.base.length))
  ));
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
// extraction, so a subject's values from several files accumulate under their
// terms; exact-duplicate literals collapse, first-seen (sorted file order) kept.
async function ingestDump(input) {
  const files = await resolveInputFiles(input);
  const quads = [];
  for (const file of files) {
    if (files.length > 1) process.stdout.write(`    + ${file}\n`);
    quads.push(...(await parseRDF(await readFile(file, "utf8"))));
  }
  return toRecords(collectLiterals(quads, () => true));
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
      // Each term is emitted under its own predicate alias as a JSON-LD @language
      // map (real tag as key, `@none` for untagged) - no coercion to prefLabel. The
      // value is a string, or an array when the source has several for that term.
      const lk = t.lang || "@none";
      const doc = { "@context": CONTEXT_URL, "@id": t.iri };
      for (const [term, value] of Object.entries(t.terms)) doc[term] = { [lk]: value };
      emit(key, JSON.stringify(doc));
    }
    const withDesc = records.filter((t) => Object.keys(t.terms).some((term) => DESC_TERM_SET.has(term))).length;
    summary.push({ ns: nsLabel, terms: records.length, withDefinition: withDesc });
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
