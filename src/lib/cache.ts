// Workers Cache strategy: responses are immutable between deploys and data
// refreshes, so we cache them effectively forever and invalidate explicitly by
// purging cache tags (POST /admin/purge → ctx.cache.purge).
//
// Every cacheable success carries the `all` tag (purged on deploy) plus finer
// tags for targeted invalidation (e.g. purge just `labels` on a data refresh,
// or `labels:skos` for a single namespace).
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
    "Cache-Tag": ["all", ...tags].join(","),
  });
  if (contentEncoding) headers.set("Content-Encoding", contentEncoding);
  return headers;
}
