# Deploy & demo runbook

Phase-1 deploy: static labels served from R2. Assumes a Cloudflare account.

Prerequisites: Node 22+, pnpm (or an equivalent package manager), and
[just](https://just.systems/) for the recipe path. A raw Wrangler path remains
available in the README.

Pick a **project name** first: your Worker and bucket are both named
`label-cache-<project>`, so each app gets its own isolated instance. Set it once
in `.env` (`PROJECT=orders`) or pass `project=orders` on each command below.

## Local demo

Run the asset-backed landing page and playground with a local R2 bucket:

```bash
just demo-local
```

The recipe starts the demo Worker, then seeds it through the **production ingest
pipeline** (`scripts/ingest.mjs`) and loads the result via `/dev/load` - the same
public vocabularies (rdf, rdfs, owl, skos, dcterms, dcat, schema.org) and the same
faithful labels a real deployment serves, with each object's `@context` baked to
the local origin. So the local demo shows exactly what production does - no curated
fixtures. The first run fetches schema.org, so it takes a few seconds. Open `/`
for the landing page or `/demo` for the playground. Set `PORT=8790` if port 8787
is already occupied.

## One-time

```bash
just login                       # browser OAuth into your Cloudflare account
just project=orders bucket       # create R2 bucket `label-cache-orders`
export PURGE_TOKEN="$(openssl rand -base64 48)"
just project=orders purge-token-set
```

Keep the same `PURGE_TOKEN` in the secret store used by the production seed
job. It is required: the upload scripts fail rather than report success with
stale edge data.

## Deploy

```bash
just project=orders deploy       # publishes the Worker; prints its URL, e.g.
                                 #   https://label-cache-orders.<subdomain>.workers.dev
```

## Seed production R2

The full label set (~3,200 terms: rdf, rdfs, owl, skos, dcterms, dcat, and all of
schema.org) is produced by the ingestion pipeline and uploaded to R2 over the S3 API:

```bash
export SEED_BASE=https://label-cache-orders.<subdomain>.workers.dev
export R2_BUCKET=label-cache-orders
export CLOUDFLARE_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
export PURGE_TOKEN=...           # same value installed with purge-token-set
./scripts/seed.sh            # = pnpm seed:ingest (fetch + parse) then pnpm seed:upload
```

(`./scripts/seed.sh` targets the maintainer demo bucket `label-cache-demo` by
default; set `R2_BUCKET` as above for your own project. From `just`, the
`project=` recipes set it for you.)

`SEED_BASE` is the deployed origin, baked into each object's `@context` URL. R2 keys are
case-sensitive, so `schema:Text` and `schema:text` stay distinct. In CI this runs from
`.github/workflows/seed.yml` (manual + monthly), decoupled from code deploys - data and
Worker have independent lifecycles. See [architecture.md](./architecture.md) §6.6.

Sources: `dcterms`, `dcat` (W3C DXWG GitHub mirror) and schema.org are fetched live;
`rdf/rdfs/owl/skos` are hand-curated Turtle under `scripts/vocab/` because w3.org's
namespace docs sit behind a Cloudflare bot challenge (403 to scripts).

`just seed-remote <url>` (or `scripts/seed-remote.sh <url>`) is a one-command wrapper
for the same full seed — a thin shim over `seed.sh` that takes the base URL as an
argument and runs ingest → S3 upload → purge:

```bash
just project=orders seed-remote https://label-cache-orders.<subdomain>.workers.dev
```

For a quick 12-term smoke sample (no ingest, no S3 keys), hit the Worker's dev-only
`/dev/seed` endpoint directly (`just seed` against a local dev server).

## Verify / demo

```bash
just demo https://label-cache-orders.<subdomain>.workers.dev
```

Or by hand:

```bash
curl "https://<your-url>/label?iri=http%3A%2F%2Fwww.w3.org%2F2004%2F02%2Fskos%2Fcore%23Concept" | jq
```

## Notes

- **Custom domain (optional):** attach a route in `wrangler.toml` or the dashboard, then
  re-run `seed-remote` with the custom base so `@context` URLs match the public host.
- **Seed data**: the full set comes from the ingestion pipeline (`scripts/ingest.mjs` +
  `scripts/upload-seed.mjs`; see "Seed production R2" above). The 12-term sample in
  `src/routes/dev-seed.ts` is now only a local/dev smoke test.
- **Workers Cache** is enabled by `[cache] enabled = true` in both Worker
  configurations. It sits in front of the Worker; code deployments use the
  platform's default version-isolated cache and do not require a broad purge.
- **Split browser/edge TTL:** labels use
  `max-age=3600, s-maxage=31536000, stale-while-revalidate=604800`. A successful
  admin purge invalidates the Cloudflare edge immediately; browsers cannot be
  purged, but `stale-while-revalidate` lets a returning browser serve its cached
  copy instantly and refresh in the background, so a data refresh reaches it
  within one request (bounded by the hour-long `max-age`). See
  [`docs/consuming.md`](./consuming.md#2-let-the-http-cache-do-the-caching) for
  the freshness model. Only the versioned context document stays `immutable` -
  its URL never changes content.
