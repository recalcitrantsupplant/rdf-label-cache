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

  // Key layout is lang-FIRST: labels/{lang}/{iri}. The lang segment is a fixed,
  // slash-free token, so it can never collide with the raw IRI (which contains
  // slashes) - e.g. IRI ".../doc" @en vs IRI ".../doc/en" untagged stay distinct.
  // It also makes each language a listable prefix (labels/en/..., labels/und/...).
  // No `lang` maps to the untagged literal, stored under the `und` segment:
  //   labels/en/https://schema.org/name   |   labels/und/https://schema.org/name
  const r2Key = `labels/${lang || "und"}/${iri}`;

  const object = await env.PUBLIC_LABELS.get(r2Key);
  if (!object) {
    return errorResponse(
      { error: "not_found", iri, ...(lang ? { lang } : {}), message: "Label not found in store." },
      404
    );
  }

  // Cached by Workers Cache per Cache-Control; invalidated by purging the
  // `labels` tag (or `labels:{ns}` for one namespace) on a data refresh. The
  // per-namespace tag is best-effort - known namespaces only; others just get
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
