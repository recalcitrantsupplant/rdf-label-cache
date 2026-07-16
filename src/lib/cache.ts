// Workers Cache strategy: the edge holds entries for a year (s-maxage) and is
// invalidated by cache-tag purges after a data refresh. Browsers get a short
// max-age instead, because nothing can evict an already-cached browser
// response - a purge only reaches the Cloudflare edge, so a data refresh
// becomes visible to returning browsers within the hour.
//
// Cache tags are deliberately scoped. `labels` is the full label-data scope;
// there is no catch-all tag because code deploys use version-isolated cache.
export const DATA_CACHE = "public, max-age=3600, s-maxage=31536000";

// The versioned context URL never changes content (enforced at upload by
// scripts/upload-seed.mjs), so browsers may hold it forever.
export const IMMUTABLE = "public, max-age=31536000, immutable";

// Errors self-expire quickly instead of being cached forever, so a label that
// is seeded shortly after a 404 becomes visible without an explicit purge.
export const ERROR_CACHE = "public, max-age=60";

export function cacheHeaders(
  contentType: string,
  tags: string[],
  contentEncoding?: string,
  cacheControl: string = DATA_CACHE
): Headers {
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    "Cache-Tag": tags.join(","),
  });
  if (contentEncoding) headers.set("Content-Encoding", contentEncoding);
  return headers;
}
