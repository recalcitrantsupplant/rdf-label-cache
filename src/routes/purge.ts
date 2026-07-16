// Authenticated cache-purge endpoint. Workers Cache can only be purged from
// inside the Worker (ctx.cache.purge - there is no external REST/CLI purge), so
// CI/deploy and the ingestion pipeline invalidate by calling this endpoint.
//
//   POST /admin/purge?tags=labels,context      Authorization: Bearer $PURGE_TOKEN
//
// Default tags cover all data artifacts. Code deployments do not need a purge:
// Workers Cache is version-isolated by default.

interface CachePurger {
  purge(options: { tags: string[] }): Promise<void>;
}

export async function handlePurge(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  }

  const auth = request.headers.get("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!env.PURGE_TOKEN || token !== env.PURGE_TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }

  const tags = (new URL(request.url).searchParams.get("tags") ?? "labels,context,namespaces")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  // ctx.cache is provided by Workers Cache at runtime; the type may lag the
  // platform and it is absent under local emulation, so guard the call.
  const purger = (ctx as unknown as { cache?: CachePurger }).cache;
  if (purger) await purger.purge({ tags });

  return json({ purged: tags, applied: Boolean(purger) }, 200);
}

function json(body: unknown, status: number, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}
