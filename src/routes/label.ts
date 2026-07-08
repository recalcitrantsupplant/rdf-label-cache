import { parseIRI } from "../lib/namespaces";
import { cacheHeaders, ERROR_CACHE } from "../lib/cache";

export async function handleLabel(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const iriParam = url.searchParams.get("iri");
  const lang = url.searchParams.get("lang");

  if (!iriParam) {
    return errorResponse({ error: "missing_param", message: "?iri= is required" }, 400);
  }

  let iri: string;
  try {
    iri = decodeURIComponent(iriParam);
  } catch {
    return errorResponse({ error: "invalid_param", message: "?iri= is not valid percent-encoding" }, 400);
  }

  const parsed = parseIRI(iri);
  if (!parsed) {
    return errorResponse({ error: "not_found", iri, message: "Namespace not in public store." }, 404);
  }

  const { namespaceAlias, localName } = parsed;
  const r2Key = lang
    ? `labels/${namespaceAlias}/${localName}/${lang}`
    : `labels/${namespaceAlias}/${localName}`;

  const object = await env.PUBLIC_LABELS.get(r2Key);
  if (!object) {
    return errorResponse(
      { error: "not_found", iri, ...(lang ? { lang } : {}), message: "Label not found in public store." },
      404
    );
  }

  // Cached by Workers Cache per Cache-Control; invalidated by purging the
  // `labels` tag (or `labels:{ns}` for one namespace) on a data refresh.
  const headers = cacheHeaders(
    "application/ld+json",
    ["labels", `labels:${namespaceAlias}`],
    object.httpMetadata?.contentEncoding
  );
  return new Response(object.body, { status: 200, headers });
}

function errorResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": ERROR_CACHE },
  });
}
