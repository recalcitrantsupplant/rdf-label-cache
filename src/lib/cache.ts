// Workers Cache strategy: static RDF responses are intentionally immutable for
// a year. Cache-tag purges invalidate the Cloudflare edge after a data refresh,
// but cannot evict an already-cached browser response.
//
// Cache tags are deliberately scoped. `labels` is the full label-data scope;
// there is no catch-all tag because code deploys use version-isolated cache.
export const IMMUTABLE = "public, max-age=31536000, immutable";

// Errors self-expire quickly instead of being cached forever, so a label that
// is seeded shortly after a 404 becomes visible without an explicit purge.
export const ERROR_CACHE = "public, max-age=60";

export function cacheHeaders(
  contentType: string,
  tags: string[],
  contentEncoding?: string
): Headers {
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": IMMUTABLE,
    "Cache-Tag": tags.join(","),
  });
  if (contentEncoding) headers.set("Content-Encoding", contentEncoding);
  return headers;
}
