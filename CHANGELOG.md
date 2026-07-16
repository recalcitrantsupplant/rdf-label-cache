# Changelog

## [0.4.0](https://github.com/recalcitrantsupplant/label-cdn/compare/rdf-label-resolver-v0.3.0...rdf-label-resolver-v0.4.0) (2026-07-10)


### Features

* **demo:** single-page landing + self-serve getting-started ([9645bde](https://github.com/recalcitrantsupplant/label-cdn/commit/9645bdec513ee5955e2d0854586a62b903dfd8d2))

## [0.3.0](https://github.com/recalcitrantsupplant/label-cdn/compare/rdf-label-resolver-v0.2.0...rdf-label-resolver-v0.3.0) (2026-07-10)


### Features

* **demo:** single-page landing as the front door; tool moves to /demo ([6477caf](https://github.com/recalcitrantsupplant/label-cdn/commit/6477caf466ac2ba869678161955b1b55be142212))


### Bug Fixes

* **seed:** fail fast on missing R2 credentials ([2c8f982](https://github.com/recalcitrantsupplant/label-cdn/commit/2c8f9822cd122d341a39e0fc36a6265487bf69bd))

## [0.2.0](https://github.com/recalcitrantsupplant/label-cdn/compare/rdf-label-resolver-v0.1.2...rdf-label-resolver-v0.2.0) (2026-07-08)


### Features

* **cache:** adopt Workers Cache with immutable TTL and tag purge ([0ccc85f](https://github.com/recalcitrantsupplant/label-cdn/commit/0ccc85f197a300aae4f80bdcafcefcdd4fbed854))
* **demo:** add "Why label-cache?" page and clearer intro ([672c1e9](https://github.com/recalcitrantsupplant/label-cdn/commit/672c1e97f4899eb6798e87634fbadd00da568d38))
* **demo:** requests pane with label lookup and prefix provenance ([f17a659](https://github.com/recalcitrantsupplant/label-cdn/commit/f17a659f7b0a03fcadf4e0b910381e5a3c0caaa5))
* **demo:** static demo landing page ([a0807fb](https://github.com/recalcitrantsupplant/label-cdn/commit/a0807fb8966751989962bde57db261ebbad6a16e))
* **dev:** binding-based /dev/load loader for local seeding ([e56d203](https://github.com/recalcitrantsupplant/label-cdn/commit/e56d2031b77379964a06bce38da783f6584ee254))
* **ingest:** --input for your own RDF dumps; share the namespace map ([cb0b4e6](https://github.com/recalcitrantsupplant/label-cdn/commit/cb0b4e631958aee0512a73475a2ba428b13e3409))
* namespace-agnostic keying by full IRI ([b5d6b11](https://github.com/recalcitrantsupplant/label-cdn/commit/b5d6b11d4b4af68bb7c4464afb65d5abe8456c60))
* RDF-labeling demo page + ontology ingest pipeline ([61a3b13](https://github.com/recalcitrantsupplant/label-cdn/commit/61a3b133c4d88fc2c444d76ee0a3d3efc8115aa6))
* **seed:** ingest common ontologies into R2 ([3eba1ca](https://github.com/recalcitrantsupplant/label-cdn/commit/3eba1ca6e65d868b001720b653b964d4a167a7ed))


### Bug Fixes

* **demo:** nothing is pre-loaded - clarify you populate R2 yourself ([0f8910b](https://github.com/recalcitrantsupplant/label-cdn/commit/0f8910b096888c6b8d4447eb575747285ff4c193))

## [0.1.2](https://github.com/recalcitrantsupplant/label-cdn/compare/rdf-label-resolver-v0.1.1...rdf-label-resolver-v0.1.2) (2026-07-08)


### Bug Fixes

* **namespaces:** return prefix/namespace keys in listing ([75123f5](https://github.com/recalcitrantsupplant/label-cdn/commit/75123f5e19ece6a659c9fe32001be6bc818a9f85))

## [0.1.1](https://github.com/recalcitrantsupplant/label-cdn/compare/rdf-label-resolver-v0.1.0...rdf-label-resolver-v0.1.1) (2026-07-07)


### Bug Fixes

* **dev-seed:** derive [@context](https://github.com/context) URL from request origin ([fd29625](https://github.com/recalcitrantsupplant/label-cdn/commit/fd296250d6b26fb413e42ce33162c28e50af8dc4))
