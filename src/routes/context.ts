import { cacheHeaders } from "../lib/cache";

export async function handleContext(env: Env): Promise<Response> {
  const object = await env.PUBLIC_LABELS.get("context/labels-v1.json");

  if (!object) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
    });
  }

  const headers = cacheHeaders("application/ld+json", ["context"], object.httpMetadata?.contentEncoding);
  return new Response(object.body, { status: 200, headers });
}
