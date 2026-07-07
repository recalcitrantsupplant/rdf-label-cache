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

Production has `ENVIRONMENT=production`, which disables the `/dev/seed` endpoint, so
we never expose a seeding route publicly. Instead we seed the *real* bucket through a
throwaway `--remote` dev server. Pass the deployed URL so objects embed the right
`@context`:

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
- **Seed data** is the 12-term sample in `src/routes/dev-seed.ts`. Real ontology data
  comes from the ingestion pipeline (architecture.md §6.6), not yet built.
- **Workers Cache** (`[cache] enabled = true`) is documented but not yet enabled in
  `wrangler.toml` — see `2026-07-06-workers-cache-migration.md`. Deploy works without it;
  the Worker's own edge-cache code carries phase 1.
