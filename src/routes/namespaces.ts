import { KNOWN_NAMESPACES } from "../lib/namespaces";
import { cacheHeaders } from "../lib/cache";

export async function handleNamespaces(env: Env, nsAlias?: string): Promise<Response> {
  if (nsAlias) {
    // Describe a specific namespace
    const object = await env.PUBLIC_LABELS.get(`namespaces/${nsAlias}/all.json`);
    if (!object) {
      return new Response(JSON.stringify({ error: "not_found", namespace: nsAlias }), {
        status: 404,
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
      });
    }

    const headers = cacheHeaders(
      "application/json",
      ["namespaces", `labels:${nsAlias}`],
      object.httpMetadata?.contentEncoding
    );
    return new Response(object.body, { status: 200, headers });
  }

  // List all known public namespaces: prefix (short name) + namespace (base URI)
  const list = Object.entries(KNOWN_NAMESPACES).map(([namespace, prefix]) => ({ prefix, namespace }));
  const headers = cacheHeaders("application/json", ["namespaces"]);
  return new Response(JSON.stringify({ namespaces: list }), { status: 200, headers });
}
