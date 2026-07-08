// Maps IRI prefix → short namespace alias. NOT required for resolution — the
// Worker keys R2 by the full IRI, so any namespace resolves. This map only
// drives the /namespaces listing and the best-effort per-namespace cache tag
// (labels:{alias}) used for targeted purging.
import namespaces from "./namespaces.json";

export const KNOWN_NAMESPACES: Record<string, string> = namespaces;

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
