# Your labels go here

Drop RDF files in this folder and the **seed-labels** GitHub Action ingests every
one of them into your R2 bucket. This is the file-based Phase-2 seed path from
[`docs/one-click-onboarding-design.md`](../docs/one-click-onboarding-design.md).

- **Accepted formats:** Turtle/N-Triples/TriG/N-Quads — `.ttl`, `.turtle`,
  `.nt`, `.n3`, `.nq`, `.trig`. Non-RDF files (like this README) are skipped.
- **What's extracted:** only the label/description predicates
  (`skos:prefLabel`, `rdfs:label`, `dcterms:title`, `schema:name`;
  `skos:definition`, `rdfs:comment`, `dcterms:description`, `schema:description`).
  A **full instance-data dump works** — non-label triples are ignored.
- **Multiple files** are merged; when a subject carries the same `(IRI, language)`
  label in several files, predicate list-order wins (see `scripts/ingest.mjs`).

Then run the **seed-labels** workflow (Actions tab → *Run workflow*) once your
Cloudflare secrets/variables are set. See the design doc for the full runbook.

> Committing labels here puts them in your git history. Fine for public or modest
> label sets; for large dumps or sensitive labels prefer a private repo or the
> (deferred) SPARQL-endpoint seed path.
