import { KNOWN_NAMESPACES } from "../lib/namespaces";
import { cacheHeaders } from "../lib/cache";

export function handleNamespaces(): Response {
  // This is a static prefix registry, not a statement about which labels have
  // been uploaded to the current R2 bucket.
  const list = Object.entries(KNOWN_NAMESPACES).map(([namespace, prefix]) => ({ prefix, namespace }));
  const headers = cacheHeaders("application/json", ["namespaces"]);
  return new Response(JSON.stringify({ namespaces: list }), { status: 200, headers });
}
