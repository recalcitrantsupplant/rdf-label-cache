# Changelog

## [1.1.0](https://github.com/recalcitrantsupplant/rdf-label-cache/compare/rdf-label-cache-v1.0.1...rdf-label-cache-v1.1.0) (2026-07-19)


### Features

* **seed:** fail fast with a checklist when seed config is missing ([#41](https://github.com/recalcitrantsupplant/rdf-label-cache/issues/41)) ([8626feb](https://github.com/recalcitrantsupplant/rdf-label-cache/commit/8626feb87560e3c7565026e41c27208ac68f0b6a))
* **seed:** make seed-labels a reusable workflow (add workflow_call) ([#43](https://github.com/recalcitrantsupplant/rdf-label-cache/issues/43)) ([edd84fc](https://github.com/recalcitrantsupplant/rdf-label-cache/commit/edd84fc6e9e6394386035fa0e0e2af9a7dcb1c38))

## [1.0.1](https://github.com/recalcitrantsupplant/rdf-label-cache/compare/rdf-label-cache-v1.0.0...rdf-label-cache-v1.0.1) (2026-07-19)


### Bug Fixes

* **client:** memo-cache TTL, invalid-body guard, honest store docs (0.1.2) ([c2e12a3](https://github.com/recalcitrantsupplant/rdf-label-cache/commit/c2e12a34f1769476a14a135ff6e2a227b87f4fdd))

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
