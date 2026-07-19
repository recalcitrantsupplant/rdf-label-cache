# Your labels go here

Drop RDF files in this folder and the **seed-labels** GitHub Action ingests every
one of them into your R2 bucket. See the repository
[`README`](../README.md#get-started-fast) for setup and credential instructions.

- **Accepted formats:** Turtle/N-Triples/TriG/N-Quads — `.ttl`, `.turtle`,
  `.nt`, `.n3`, `.nq`, `.trig`. Non-RDF files (like this README) are skipped.
- **What's extracted:** only the label/description predicates
  (`skos:prefLabel`, `rdfs:label`, `dcterms:title`, `schema:name`, `skos:altLabel`;
  `skos:definition`, `rdfs:comment`, `dcterms:description`, `schema:description`),
  **each kept under its own JSON-LD term** — nothing is coerced to prefLabel. A
  **full instance-data dump works** — non-label triples are ignored.
- **Multiple files** are merged; a subject accumulates every value it carries
  across files (exact duplicates collapse; multi-valued terms become arrays — see
  `scripts/ingest.mjs`).

Then run the **seed-labels** workflow (Actions tab → *Run workflow*) once your
Cloudflare secrets/variables are set.

> Committing labels here puts them in your git history. Fine for public or modest
> label sets; for large dumps or sensitive labels prefer a private repo or run
> the local ingestion pipeline without committing the source data.
