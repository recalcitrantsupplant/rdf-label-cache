# Changelog

## [1.0.0](https://github.com/recalcitrantsupplant/rdf-label-cache/releases/tag/rdf-label-cache-v1.0.0) (2026-07-18)

First stable release of RDF Label Cache.

### Highlights

- Cloudflare Worker read API backed by R2 and Workers Cache.
- Per-language, full-IRI object keys with faithful JSON-LD label predicates.
- Browser-based deploy and GitHub Actions seed path, plus a local pipeline for
  larger datasets.
- Public demo and interactive Turtle playground.
- Zero-dependency `@rdf-label-cache/client` package for browsers and server
  runtimes.

### Breaking change

- `R2_ACCOUNT_ID` was replaced by `CLOUDFLARE_ACCOUNT_ID` in deployment and seed
  configuration.

Pre-1.0 changes remain available in the repository history and GitHub releases.
