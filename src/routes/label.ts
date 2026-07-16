import { parseIRI } from "../lib/namespaces";
import { cacheHeaders, ERROR_CACHE } from "../lib/cache";

const MAX_IRI_BYTES = 900;
const MAX_LANG_LENGTH = 63;
const LANGUAGE_TAG = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

export async function handleLabel(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const validated = validateQuery(url.searchParams);
  if (validated instanceof Response) return validated;
  const { iri, lang } = validated;

  // Key layout is lang-FIRST: labels/{lang}/{iri}. The lang segment is a fixed,
  // slash-free token, so it can never collide with the raw IRI (which contains
  // slashes) - e.g. IRI ".../doc" @en vs IRI ".../doc/en" untagged stay distinct.
  // It also makes each language a listable prefix (labels/en/..., labels/und/...).
  // No `lang` maps to the untagged literal, stored under the `und` segment:
  //   labels/en/https://schema.org/name   |   labels/und/https://schema.org/name
  const r2Key = `labels/${lang || "und"}/${iri}`;

  // HEAD needs only the metadata; R2 `head` avoids streaming a body that the
  // top-level handler would immediately discard.
  const object =
    request.method === "HEAD" ? await env.PUBLIC_LABELS.head(r2Key) : await env.PUBLIC_LABELS.get(r2Key);
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
  // `head` results carry no body; the cast is safe because `body` only exists
  // on R2ObjectBody (from `get`).
  return new Response("body" in object ? (object.body as BodyInit) : null, { status: 200, headers });
}

function validateQuery(params: URLSearchParams): { iri: string; lang: string | null } | Response {
  const unknown = [...params.keys()].find((key) => key !== "iri" && key !== "lang");
  if (unknown) {
    return errorResponse({ error: "invalid_param", message: `Unsupported query parameter: ${unknown}` }, 400);
  }

  const iris = params.getAll("iri");
  if (iris.length === 0 || !iris[0]) {
    return errorResponse({ error: "missing_param", message: "?iri= is required" }, 400);
  }
  if (iris.length !== 1) {
    return errorResponse({ error: "invalid_param", message: "?iri= must be supplied exactly once" }, 400);
  }

  const iri = iris[0];
  if (new TextEncoder().encode(iri).byteLength > MAX_IRI_BYTES) {
    return errorResponse({ error: "invalid_param", message: "?iri= is too long" }, 400);
  }
  try {
    const parsed = new URL(iri);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    return errorResponse({ error: "invalid_param", message: "?iri= must be an absolute http(s) IRI" }, 400);
  }

  const langs = params.getAll("lang");
  if (langs.length > 1) {
    return errorResponse({ error: "invalid_param", message: "?lang= may be supplied at most once" }, 400);
  }
  const lang = langs[0] ?? null;
  if (lang !== null && (!lang || lang.length > MAX_LANG_LENGTH || !LANGUAGE_TAG.test(lang))) {
    return errorResponse({ error: "invalid_param", message: "?lang= must be an alphanumeric language tag" }, 400);
  }
  // `und` is the internal storage segment for untagged literals; accepting it as
  // a query value would alias the no-`lang` URL under a second cache key.
  if (lang?.toLowerCase() === "und") {
    return errorResponse({ error: "invalid_param", message: "Omit ?lang= to request the untagged label" }, 400);
  }

  return { iri, lang };
}

function errorResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": ERROR_CACHE },
  });
}
