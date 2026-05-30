const CONTEXT_URL = "http://localhost:8787/context/labels-v1.json";

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

interface LabelEntry {
  ns: string;
  local: string;
  iri: string;
  prefLabel: string;
  definition?: string;
  comment?: string;
}

const SEED_LABELS: LabelEntry[] = [
  // rdfs
  { ns: "rdfs", local: "label", iri: "http://www.w3.org/2000/01/rdf-schema#label", prefLabel: "label", definition: "A human-readable name for the subject." },
  { ns: "rdfs", local: "comment", iri: "http://www.w3.org/2000/01/rdf-schema#comment", prefLabel: "comment", definition: "A description of the subject resource." },
  { ns: "rdfs", local: "Class", iri: "http://www.w3.org/2000/01/rdf-schema#Class", prefLabel: "Class", definition: "The class of all classes." },
  { ns: "rdfs", local: "subClassOf", iri: "http://www.w3.org/2000/01/rdf-schema#subClassOf", prefLabel: "subClassOf", definition: "The subject is a subclass of a class." },
  // owl
  { ns: "owl", local: "Class", iri: "http://www.w3.org/2002/07/owl#Class", prefLabel: "Class", definition: "The class of OWL classes." },
  { ns: "owl", local: "ObjectProperty", iri: "http://www.w3.org/2002/07/owl#ObjectProperty", prefLabel: "ObjectProperty", definition: "The class of object properties." },
  { ns: "owl", local: "DatatypeProperty", iri: "http://www.w3.org/2002/07/owl#DatatypeProperty", prefLabel: "DatatypeProperty", definition: "The class of data properties." },
  // skos
  { ns: "skos", local: "Concept", iri: "http://www.w3.org/2004/02/skos/core#Concept", prefLabel: "Concept", definition: "An idea or notion; a unit of thought." },
  { ns: "skos", local: "prefLabel", iri: "http://www.w3.org/2004/02/skos/core#prefLabel", prefLabel: "preferred label", definition: "The preferred lexical label for a resource, in a given language." },
  { ns: "skos", local: "definition", iri: "http://www.w3.org/2004/02/skos/core#definition", prefLabel: "definition", definition: "A statement or formal explanation of the meaning of a concept." },
  { ns: "skos", local: "ConceptScheme", iri: "http://www.w3.org/2004/02/skos/core#ConceptScheme", prefLabel: "Concept Scheme", definition: "A set of concepts, optionally including statements about semantic relationships between those concepts." },
];

function labelDoc(entry: LabelEntry): string {
  const doc: Record<string, unknown> = {
    "@context": CONTEXT_URL,
    "@id": entry.iri,
    prefLabel: { en: entry.prefLabel },
  };
  if (entry.definition) doc.definition = { en: entry.definition };
  if (entry.comment) doc.comment = { en: entry.comment };
  return JSON.stringify(doc);
}

const TEXT = { contentType: "application/ld+json" };

export async function handleDevSeed(env: Env): Promise<Response> {
  const written: string[] = [];

  // Context document
  await env.PUBLIC_LABELS.put("context/labels-v1.json", JSON.stringify(CONTEXT_DOC), {
    httpMetadata: { contentType: "application/ld+json" },
  });
  written.push("context/labels-v1.json");

  // Label objects — English and all-languages bundle (same content for now)
  for (const entry of SEED_LABELS) {
    const body = labelDoc(entry);
    const enKey = `labels/${entry.ns}/${entry.local}/en`;
    const bundleKey = `labels/${entry.ns}/${entry.local}`;

    await env.PUBLIC_LABELS.put(enKey, body, { httpMetadata: TEXT });
    await env.PUBLIC_LABELS.put(bundleKey, body, { httpMetadata: TEXT });
    written.push(enKey);
  }

  return new Response(JSON.stringify({ seeded: written.length, keys: written }), {
    headers: { "Content-Type": "application/json" },
  });
}
