import { parseIRI } from "../lib/namespaces";

export async function handleLabel(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const iriParam = url.searchParams.get("iri");
  const lang = url.searchParams.get("lang");

  if (!iriParam) {
    return jsonResponse({ error: "missing_param", message: "?iri= is required" }, 400, 60);
  }

  let iri: string;
  try {
    iri = decodeURIComponent(iriParam);
  } catch {
    return jsonResponse({ error: "invalid_param", message: "?iri= is not valid percent-encoding" }, 400, 60);
  }

  // Edge cache check
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const parsed = parseIRI(iri);
  if (!parsed) {
    const body = {
      error: "not_found",
      iri,
      message: "Namespace not in public store. Provide ?fallback= or register a resolver.",
    };
    return jsonResponse(body, 404, 60);
  }

  const { namespaceAlias, localName } = parsed;
  const r2Key = lang
    ? `labels/${namespaceAlias}/${localName}/${lang}`
    : `labels/${namespaceAlias}/${localName}`;

  const object = await env.PUBLIC_LABELS.get(r2Key);

  if (!object) {
    const body = {
      error: "not_found",
      iri,
      ...(lang ? { lang } : {}),
      message: "Label not found in public store.",
    };
    return jsonResponse(body, 404, 60);
  }

  const headers = new Headers({
    "Content-Type": "application/ld+json",
    "Cache-Control": "public, max-age=86400",
    "CF-Cache-Tag": "public-labels",
  });

  // Propagate Content-Encoding from R2 metadata (objects stored gzip-compressed)
  const ce = object.httpMetadata?.contentEncoding;
  if (ce) headers.set("Content-Encoding", ce);

  const response = new Response(object.body, { status: 200, headers });

  // Populate edge cache for subsequent requests from this PoP
  ctx.waitUntil(cache.put(request, response.clone()));

  return response;
}

function jsonResponse(body: unknown, status: number, cacheTtl: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${cacheTtl}`,
    },
  });
}
