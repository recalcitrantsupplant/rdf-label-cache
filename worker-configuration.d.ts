interface Env {
  PUBLIC_LABELS: R2Bucket;
  ENVIRONMENT: string;
  // Secret guarding POST /admin/purge (cache invalidation). Optional: unset
  // means the purge endpoint is closed (always 401).
  PURGE_TOKEN?: string;
}
