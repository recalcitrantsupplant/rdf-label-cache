// Maps IRI prefix → short namespace alias used as R2 key segment
export const KNOWN_NAMESPACES: Record<string, string> = {
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#": "rdf",
  "http://www.w3.org/2000/01/rdf-schema#": "rdfs",
  "http://www.w3.org/2002/07/owl#": "owl",
  "http://www.w3.org/2004/02/skos/core#": "skos",
  "http://www.w3.org/2008/05/skos-xl#": "skosxl",
  "http://purl.org/dc/elements/1.1/": "dc",
  "http://purl.org/dc/terms/": "dcterms",
  "https://schema.org/": "schema",
  "http://schema.org/": "schema",
  "http://www.w3.org/2001/XMLSchema#": "xsd",
  "http://www.w3.org/ns/dcat#": "dcat",
  "http://www.w3.org/ns/prov#": "prov",
  "http://xmlns.com/foaf/0.1/": "foaf",
  "http://rdfs.org/ns/void#": "void",
};

export interface ParsedIRI {
  namespaceAlias: string;
  localName: string;
}

export function parseIRI(iri: string): ParsedIRI | null {
  // Try hash-based split first (#), then path-based (last /)
  const hashIdx = iri.lastIndexOf("#");
  const slashIdx = iri.lastIndexOf("/");
  const splitIdx = hashIdx !== -1 ? hashIdx : slashIdx;

  if (splitIdx === -1 || splitIdx === iri.length - 1) return null;

  const prefix = iri.slice(0, splitIdx + 1);
  const localName = iri.slice(splitIdx + 1);

  if (!localName) return null;

  const namespaceAlias = KNOWN_NAMESPACES[prefix];
  if (!namespaceAlias) return null;

  return { namespaceAlias, localName };
}
