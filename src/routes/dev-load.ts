// Dev-only bulk loader. POST an NDJSON manifest (one {"key","body"} per line)
// and each object is written to R2 through the binding. Used for local seeding:
// the `wrangler r2 object put` CLI mangles keys containing "#" (truncated as a
// URL fragment) or "%" (percent-decoded), but the binding stores them verbatim.
// Guarded to non-production in the router (like /dev/seed).
export async function handleDevLoad(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const text = await request.text();
  let loaded = 0;
  const errors: string[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: { key?: string; body?: string };
    try {
      rec = JSON.parse(trimmed);
    } catch {
      errors.push("invalid JSON line");
      continue;
    }
    if (!rec.key || typeof rec.body !== "string") {
      errors.push(`invalid record: ${rec.key ?? "?"}`);
      continue;
    }
    await env.PUBLIC_LABELS.put(rec.key, rec.body, {
      httpMetadata: { contentType: "application/ld+json" },
    });
    loaded++;
  }

  return json({ loaded, ...(errors.length ? { errors: errors.slice(0, 10) } : {}) }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
