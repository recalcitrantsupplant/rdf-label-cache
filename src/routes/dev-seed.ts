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

// Each optional field is a JSON-LD term mapping a distinct predicate - nothing is
// coerced to prefLabel. An array becomes a multi-valued language entry (a subject
// can carry several, e.g. altLabels). Mirrors scripts/pipeline/ingest.mjs' emitted shape.
const TERM_FIELDS = ["prefLabel", "label", "altLabel", "title", "name", "definition", "comment", "description"] as const;

interface LabelEntry {
  iri: string;
  // BCP-47 tag; omit for an untagged literal (served on a no-`lang` request).
  lang?: string;
  prefLabel?: string;
  label?: string;
  altLabel?: string | string[];
  title?: string;
  name?: string;
  definition?: string;
  comment?: string;
  description?: string;
}

const SEED_LABELS: LabelEntry[] = [
  // rdfs
  { iri: "http://www.w3.org/2000/01/rdf-schema#label", prefLabel: "label", definition: "A human-readable name for the subject." },
  { iri: "http://www.w3.org/2000/01/rdf-schema#comment", prefLabel: "comment", definition: "A description of the subject resource." },
  { iri: "http://www.w3.org/2000/01/rdf-schema#Class", prefLabel: "Class", definition: "The class of all classes." },
  { iri: "http://www.w3.org/2000/01/rdf-schema#subClassOf", prefLabel: "subClassOf", definition: "The subject is a subclass of a class." },
  // owl
  { iri: "http://www.w3.org/2002/07/owl#Class", prefLabel: "Class", definition: "The class of OWL classes." },
  { iri: "http://www.w3.org/2002/07/owl#ObjectProperty", prefLabel: "ObjectProperty", definition: "The class of object properties." },
  { iri: "http://www.w3.org/2002/07/owl#DatatypeProperty", prefLabel: "DatatypeProperty", definition: "The class of data properties." },
  // skos - Concept carries several distinct predicates plus a multi-valued
  // altLabel, so the sample exercises the faithful multi-term / multi-value shape.
  { iri: "http://www.w3.org/2004/02/skos/core#Concept", prefLabel: "Concept", label: "Concept", altLabel: ["Idea", "Notion"], definition: "An idea or notion; a unit of thought." },
  { iri: "http://www.w3.org/2004/02/skos/core#prefLabel", prefLabel: "preferred label", definition: "The preferred lexical label for a resource, in a given language." },
  { iri: "http://www.w3.org/2004/02/skos/core#definition", prefLabel: "definition", definition: "A statement or formal explanation of the meaning of a concept." },
  { iri: "http://www.w3.org/2004/02/skos/core#ConceptScheme", prefLabel: "Concept Scheme", definition: "A set of concepts, optionally including statements about semantic relationships between those concepts." },
  // A language-TAGGED entry (the rest are untagged, like the real vocabularies),
  // so the sample exercises both the `labels/en/...` and `labels/und/...` paths.
  { iri: "http://purl.org/dc/terms/title", prefLabel: "Title", definition: "A name given to the resource.", lang: "en" },
];

function labelDoc(entry: LabelEntry, contextUrl: string): string {
  // JSON-LD @language map key: the real tag, or `@none` for untagged literals.
  const lk = entry.lang || "@none";
  const doc: Record<string, unknown> = { "@context": contextUrl, "@id": entry.iri };
  for (const term of TERM_FIELDS) {
    const value = entry[term];
    if (value !== undefined) doc[term] = { [lk]: value };
  }
  return JSON.stringify(doc);
}

const TEXT = { contentType: "application/ld+json" };

export async function handleDevSeed(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // Objects embed an absolute @context URL. Default to this request's origin so
  // deployed objects point at the deployed host; ?base= overrides (e.g. when
  // seeding remote R2 from `wrangler dev --remote` on localhost).
  const base = (url.searchParams.get("base") || url.origin).replace(/\/$/, "");
  const contextUrl = `${base}/context/labels-v1.json`;
  const written: string[] = [];

  // Context document
  await env.PUBLIC_LABELS.put("context/labels-v1.json", JSON.stringify(CONTEXT_DOC), {
    httpMetadata: { contentType: "application/ld+json" },
  });
  written.push("context/labels-v1.json");

  // Label objects, keyed lang-FIRST: labels/{lang}/{iri} (untagged -> `und`).
  // See src/routes/label.ts for the matching read path.
  for (const entry of SEED_LABELS) {
    const body = labelDoc(entry, contextUrl);
    const key = `labels/${entry.lang || "und"}/${entry.iri}`;
    await env.PUBLIC_LABELS.put(key, body, { httpMetadata: TEXT });
    written.push(key);
  }

  return new Response(JSON.stringify({ seeded: written.length, keys: written }), {
    headers: { "Content-Type": "application/json" },
  });
}
