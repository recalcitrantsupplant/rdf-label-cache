// Maps IRI prefix → short namespace alias used as R2 key segment.
// Single source of truth shared with scripts/ingest.mjs. To serve labels for
// your own namespace, add it here (prefix → alias) and redeploy — the Worker
// only resolves IRIs whose namespace is registered.
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
