# Deploy & demo runbook

Phase-1 deploy: static labels served from R2. Assumes a Cloudflare account.

## One-time

```bash
just login                       # browser OAuth into your Cloudflare account
just bucket                      # create R2 bucket `rdf-public-labels`
```

## Deploy

```bash
just deploy                      # publishes the Worker; prints its URL, e.g.
                                 #   https://rdf-label-resolver.<subdomain>.workers.dev
```

## Seed production R2

The full label set (~3,200 terms: rdf, rdfs, owl, skos, dcterms, dcat, and all of
schema.org) is produced by the ingestion pipeline and uploaded to R2 over the S3 API:

```bash
export SEED_BASE=https://rdf-label-resolver.<subdomain>.workers.dev
export R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
./scripts/seed.sh            # = pnpm seed:ingest (fetch + parse) then pnpm seed:upload
```

`SEED_BASE` is the deployed origin, baked into each object's `@context` URL. R2 keys are
case-sensitive, so `schema:Text` and `schema:text` stay distinct. In CI this runs from
`.github/workflows/seed.yml` (manual + monthly), decoupled from code deploys — data and
Worker have independent lifecycles. See [architecture.md](./architecture.md) §6.6.

Sources: `dcterms`, `dcat` (W3C DXWG GitHub mirror) and schema.org are fetched live;
`rdf/rdfs/owl/skos` are hand-curated Turtle under `scripts/vocab/` because w3.org's
namespace docs sit behind a Cloudflare bot challenge (403 to scripts).

**Smoke test only:** to seed just the 12-term sample (no ingest, no S3 keys) via a
throwaway `--remote` dev server calling `/dev/seed`:

```bash
just seed-remote https://rdf-label-resolver.<subdomain>.workers.dev
```

## Verify / demo

```bash
just demo https://rdf-label-resolver.<subdomain>.workers.dev
```

Or by hand:

```bash
curl "https://<your-url>/label?iri=http%3A%2F%2Fwww.w3.org%2F2004%2F02%2Fskos%2Fcore%23Concept" | jq
curl "https://<your-url>/namespaces" | jq
```

## Notes

- **Custom domain (optional):** attach a route in `wrangler.toml` or the dashboard, then
  re-run `seed-remote` with the custom base so `@context` URLs match the public host.
- **Seed data**: the full set comes from the ingestion pipeline (`scripts/ingest.mjs` +
  `scripts/upload-seed.mjs`; see "Seed production R2" above). The 12-term sample in
  `src/routes/dev-seed.ts` is now only a local/dev smoke test.
- **Workers Cache** (`[cache] enabled = true`) is documented but not yet enabled in
  `wrangler.toml` — see `2026-07-06-workers-cache-migration.md`. Deploy works without it;
  the Worker's own edge-cache code carries phase 1.
