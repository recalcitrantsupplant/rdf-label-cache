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

  // Namespace-agnostic keying: the R2 key is the full IRI itself, so any
  // namespace resolves without registration — and the IRI's own path becomes
  // the R2 hierarchy, readable/browsable for debugging:
  //   labels/https://schema.org/name/en
  const r2Key = lang ? `labels/${iri}/${lang}` : `labels/${iri}`;

  const object = await env.PUBLIC_LABELS.get(r2Key);
  if (!object) {
    return errorResponse(
      { error: "not_found", iri, ...(lang ? { lang } : {}), message: "Label not found in store." },
      404
    );
  }

  // Cached by Workers Cache per Cache-Control; invalidated by purging the
  // `labels` tag (or `labels:{ns}` for one namespace) on a data refresh. The
  // per-namespace tag is best-effort — known namespaces only; others just get
  // `labels`. Keying no longer depends on it.
  const ns = parseIRI(iri)?.namespaceAlias;
  const headers = cacheHeaders(
    "application/ld+json",
    ns ? ["labels", `labels:${ns}`] : ["labels"],
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
