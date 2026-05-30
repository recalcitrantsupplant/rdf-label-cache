export async function handleContext(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const object = await env.PUBLIC_LABELS.get("context/labels-v1.json");

  if (!object) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const headers = new Headers({
    "Content-Type": "application/ld+json",
    "Cache-Control": "public, max-age=31536000, immutable",
  });

  const ce = object.httpMetadata?.contentEncoding;
  if (ce) headers.set("Content-Encoding", ce);

  const response = new Response(object.body, { status: 200, headers });
  ctx.waitUntil(cache.put(request, response.clone()));

  return response;
}
