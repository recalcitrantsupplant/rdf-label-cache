import { KNOWN_NAMESPACES } from "../lib/namespaces";

export async function handleNamespaces(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  nsAlias?: string
): Promise<Response> {
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  if (nsAlias) {
    // Describe a specific namespace
    const object = await env.PUBLIC_LABELS.get(`namespaces/${nsAlias}/all.json`);
    if (!object) {
      return new Response(JSON.stringify({ error: "not_found", namespace: nsAlias }), {
        status: 404,
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
      });
    }

    const headers = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    });
    const ce = object.httpMetadata?.contentEncoding;
    if (ce) headers.set("Content-Encoding", ce);

    const response = new Response(object.body, { status: 200, headers });
    ctx.waitUntil(cache.put(request, response.clone()));
    return response;
  }

  // List all known public namespaces
  const list = Object.entries(KNOWN_NAMESPACES).map(([iri, alias]) => ({ alias, iri }));
  const body = JSON.stringify({ namespaces: list });
  const response = new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}
