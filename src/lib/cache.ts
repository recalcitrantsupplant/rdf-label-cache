// Workers Cache strategy: the edge holds entries for a year (s-maxage) and is
// invalidated by cache-tag purges after a data refresh. Browsers get a short
// max-age instead, because nothing can evict an already-cached browser
// response - a purge only reaches the Cloudflare edge, so browsers pick up a
// *change* by revalidating once their copy is older than max-age (one hour).
//
// stale-while-revalidate lets a browser serve its cached copy instantly and
// refresh in the background once past max-age. Without it, browsers cannot use
// their own cache at all for edge-warm entries: the edge forwards a large `Age`
// (time the entry has sat in shared caches), and once Age exceeds max-age the
// response is stale-on-arrival, forcing a blocking refetch on every request.
// SWR moves that refetch into the background - the user gets an instant local
// hit and the new value on the next request - at the cost of one stale render
// for a returning user. That means max-age is NOT a hard staleness bound: in
// the usual case a later request uses the refreshed value, but the first
// request past max-age may still render the old copy while SWR is allowed.
//
// Cache tags are deliberately scoped. `labels` is the full label-data scope;
// there is no catch-all tag because code deploys use version-isolated cache.
export const DATA_CACHE = "public, max-age=3600, s-maxage=31536000, stale-while-revalidate=604800";

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
