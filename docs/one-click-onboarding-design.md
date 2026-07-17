# One-Click Onboarding — Design Document

**Version:** 0.1 (draft)
**Status:** Phase 1 designed · Phase 2 file-mode **implemented**, SPARQL-mode deferred
**Companion to:** `architecture.md` §7 (the roadmap entry this expands), and
`portable-deployment-design.md` (whose write-behind fallback is the strategic
end-state, §6.3 below)

---

## 1. Motivation

Standing up an instance today is "clone the repo and run ~five commands"
(`docs/DEPLOY.md`). Two of those steps are genuine friction for a newcomer who
only has a Cloudflare account:

1. **Deploy** — create an R2 bucket, deploy the Worker, install a purge token.
2. **Seed** — run the Node ingestion pipeline locally and upload to R2 over the
   S3 API, which needs Node installed and an R2 API token minted by hand.

The goal is to collapse this into **two clear phases a non-terminal user can
follow**, without abandoning the project's deliberate design choice that
**nothing ships pre-loaded** — you always populate your own R2.

**Guiding split:** *Phase 1 stands up code + empty resources; Phase 2 puts data
in.* They stay separate because data (R2) and code (Worker) have independent
lifecycles — a design invariant the ingestion pipeline already honours
(`scripts/seed.sh`, `.github/workflows/seed.yml`; the release path deploys code
only and says so — `scripts/deploy-demo.sh`).

**Scope of the GitHub Action path.** Treat it as *lightweight ops* — vocabularies
and small/modest RDF, for a "click here to get your own and get started"
experience. It is deliberately **not** a production bulk-loader: large or serious
deployments should clone the repo and run the pipeline directly (or their own CI),
where there is no runner budget to respect and full control over concurrency,
credentials, and multi-project layout (§3.6). The Action buys zero-setup
onboarding, not scale.

---

## 2. Phase 1 — deploy the service

A **Deploy to Cloudflare** button in the README (alongside enabling **Use this
template** and a C3 `npm create cloudflare -- --template …` entry) stands up the
Worker and provisions the bound R2 bucket in the user's own account — from a
Cloudflare account alone, no terminal.

**What the button does** (confirmed against Cloudflare docs):

- Provisions bound resources declared in the Wrangler config — **R2 buckets**,
  plus KV/D1/Queues/Durable Objects/etc. if present — and rewrites the config
  with the new resource IDs.
- Clones the source repo into the user's **GitHub/GitLab** account (this clone
  doubles as their Phase-2 repo — see §3).
- Wires up **Workers Builds** CI so subsequent pushes redeploy.

**Limitations to design around:**

- The button deploys **code + resources, not data** — R2 comes up **empty**, so
  every `/label` returns 404 until Phase 2 runs. The README must make the seed
  step loud; nobody should expect labels to appear by magic.
- The repo's local per-project naming trick (`_gen` → `.wrangler.gen.toml`
  rewriting `name`/`bucket_name` to `label-cache-<project>`, see `Justfile`) is a
  CLI mechanism the button does **not** run. The button reads `wrangler.toml`
  as-is and auto-provisions/renames. A button-friendly config must be directly
  deployable (today's `wrangler.toml` essentially is); the auto-generated bucket
  name replaces the `label-cache-<project>` convention for button users — one
  cache per repo, see §3.6.
- Button/template requires a **public** GitHub/GitLab repo; Pages apps and
  private repos are unsupported.

**The one hand-off to Phase 2:** `SEED_BASE`. Every seeded object bakes the
Worker origin into its `@context` URL, so Phase 2 must know the deployed
`workers.dev` URL the button just created. This is set as a repository Variable
before seeding (§3.2).

---

## 3. Phase 2 — seed the data (headline: GitHub Action, two input modes)

The primary seed path is a **GitHub Action in the repo the user already has**
(the button clones one; a manual fork gets the same). The user adds their
Cloudflare secrets, chooses an input, and runs the workflow — no local Node, no
laptop pipeline.

### 3.1 Why CI, not a "temp Worker that ingests"

An earlier idea was a throwaway Worker that fetches the ontologies and writes R2
via its binding. Rejected as the primary path:

- **Cost is a non-issue.** Seeding is a one-time write of ~3,200 objects: R2
  Class-A writes are $4.50/million → **~$0.0000144** for the full public set.
  Worker invocation cost is rounding error. Cost never was the blocker.
- **Per-invocation limits are the blocker.** Parsing schema.org's N-Triples and
  fanning ~3,200 R2 writes through a single Worker invocation strains CPU-time
  and subrequest/binding-op ceilings (and won't run at all on the free plan).
- **CI has none of those limits.** A GitHub-hosted Ubuntu runner has full Node
  and no Worker execution budget, so it runs the **exact existing pipeline**
  (`ingest.mjs` → `upload-seed.mjs`) verbatim — **no new Worker code**.

CI is also better than seeding inside the **Workers Builds deploy step**: that
runs on push and would recouple data to code deploys, breaking the
independent-lifecycle invariant. A **manually-triggered** (`workflow_dispatch`)
Action keeps them separate. There is **no cron**: nothing makes a repo's data
drift on its own — releases deploy code, not data — so periodic reseeding would
only chase upstream public-vocab changes, which is a manual "refresh when you
care" action, not a schedule. (The maintainer `seed.yml` likewise dropped its
monthly cron and is manual-only.) `seed-labels.yml` runs in **any fork** with no
owner guard, gated only by being manual so a fork's secrets are never exposed to
an untrusted push.

### 3.2 Setup common to both modes

The forker/button-user configures, once, in **Settings → Secrets and variables →
Actions**:

| Kind | Name | Value |
|---|---|---|
| Variable | `SEED_BASE` | deployed Worker URL from Phase 1 (`https://…workers.dev`) |
| Variable | `R2_BUCKET` | their bucket name (button-generated, or `label-cache-<you>`) |
| Secret | `R2_ACCOUNT_ID` | Cloudflare account id |
| Secret | `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | from an R2 API token |
| Secret | `PURGE_TOKEN` | same value installed on the Worker (`purge-token-set`) |

The workflow is **manual only** (`workflow_dispatch`) so a fork's secrets are
never exposed to an untrusted push/PR.

### 3.3 Mode 1 — file in the repo **(implemented)**

Drop RDF files in a **`labels/`** folder and run the **seed-labels** workflow.

Implemented in this repo:

- **`labels/`** — the drop folder, with a `README.md` explaining formats and
  extraction (the README is skipped by the ingester).
- **`scripts/ingest.mjs --input <dir>`** — `--input` now accepts a **directory**,
  ingesting every RDF file inside it (`.ttl`, `.turtle`, `.nt`, `.n3`, `.nq`,
  `.trig`) in sorted order, merging their quads before extraction. A single-file
  `--input` is unchanged. JSON-LD is intentionally excluded (N3 can't parse it).
- **`scripts/seed-labels.sh`** — ingest the folder → `upload-seed.mjs` → purge
  `labels,context`. `R2_BUCKET` is required (no demo default). `INCLUDE_PUBLIC=1`
  runs an optional public-vocabulary pass first, so your own labels win any
  overlapping `(IRI, language)` key (upload overwrites by key).
- **`.github/workflows/seed-labels.yml`** — `workflow_dispatch` with
  `labels_dir` (default `labels`) and `include_public` (default false) inputs.
  Runs in **any fork** (no owner guard), unlike `seed.yml`.

A **full instance-data dump works** — only label/description predicates are
extracted (`ingest.mjs` `DEFAULT_LABEL_PREDS`/`DEFAULT_DESC_PREDS`); non-label
triples are ignored.

**Caveats specific to this mode:**

- Committing labels puts them in git history — fine for **public or modest** sets;
  for **large dumps** (git bloat) or **sensitive labels** prefer a private repo or
  Mode 2.
- Cross-file `(IRI, language)` collisions resolve by predicate list-order, then
  first-seen in sorted filename order — deterministic but worth documenting for
  users spreading one subject across files.

### 3.4 Mode 2 — SPARQL endpoint **(deferred — captured here)**

Point the workflow at a SPARQL endpoint; `scripts/extract-labels.rq` pulls the
annotation triples for every IRI the data uses, then the **same** ingest + upload
+ purge path runs. Almost entirely built (`extract-labels.rq`, the `just
extract-labels` recipe, `ingest.mjs --input`, `upload-seed.mjs`); the remaining
work is workflow wiring plus deciding how the endpoint is supplied.

**Design when implemented:**

- Add an `endpoint` input (or an `SPARQL_ENDPOINT` repo Variable/Secret — Secret
  if the URL is sensitive) to a mode selector on `seed-labels.yml` (e.g.
  `mode: file | sparql`), or a sibling `seed-sparql.yml`.
- Step order: `extract-labels` → `data.ttl` → `ingest.mjs --input data.ttl` →
  `upload-seed.mjs` → purge. A wrapper `scripts/seed-sparql.sh` mirrors
  `seed-labels.sh`.

**Caveat — reachability:** GitHub-hosted runners have public egress but no VPN,
so a **private/internal** endpoint needs a self-hosted runner or a tunnel.
Public/cloud endpoints work directly.

### 3.5 The public-vocabulary top-up — what "public" is (and isn't)

"Public" is **not a third input mode and not a folder users fill**. It's the
**curated, bundled** well-known vocabularies that already ship in the repo:
`scripts/vocab/*.ttl` (rdf, rdfs, owl, skos — hand-curated because w3.org
challenges scripts) plus dcterms, dcat and schema.org fetched live by
`ingest.mjs`. The only folder a user fills is `labels/` (Mode 1).

The top-up is `ingest.mjs` with no `--input`, uploaded additively to the same
bucket, so a deployment can serve well-known-vocab labels alongside its own. It's
the `include_public` toggle in Mode 1; the same toggle applies to Mode 2 when
built. Purely optional — many deployments only care about their own IRIs.

### 3.6 One repo = one label cache (projects)

The `label-cache-<project>` naming — a Worker + bucket per app — is a **local
`just`** convenience (`.wrangler.gen.toml` rewriting the config), **not** part of
the one-click path:

- The Deploy button provisions a **single** Worker + bucket per forked repo.
- `seed-labels.yml` seeds the **single** bucket named by `vars.R2_BUCKET`.

So a one-click user gets **one label cache per repo** — set `R2_BUCKET` to
whatever the button created (or `label-cache-<you>`). Want several isolated
caches? Fork/clone again per instance, or use the local `just project=<name>`
pipeline — the same clone-and-run route everything large should take anyway
(§1, Scope). The one-click flow deliberately does not template multiple projects.

---

## 4. R2 credentials — keep the S3 bulk path, guide the token setup

`upload-seed.mjs` writes over the **R2 S3 API**
(`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`) with concurrency (default 32) and
preserves keys containing `#`/`%` that the `wrangler r2 object put` CLI mangles
(see `dev-load.ts`).

**Decision: keep this, and just guide users to mint an R2 API token** (a handful
of Cloudflare keys, pasted once into repo Secrets). We do **not** chase a
"single credential" flow: the only token-free alternative,
`wrangler r2 object put`, is **one HTTP request per object** — ~3,200 sequential
PUTs for the public set — far slower than the concurrent bulk upload. Trading a
two-minute one-time token setup for a slow per-object upload is a bad deal. A few
guided clicks in the Cloudflare dashboard is the right cost here.

---

## 5. Alternatives (kept, not primary)

- **Self-seed Worker route.** A guarded `POST /admin/seed` (authed by the
  existing `PURGE_TOKEN`) that fetches the public ontologies — or pulls a
  reachable SPARQL endpoint — and writes R2 via its own binding, **no R2 API
  token at all**. To survive the per-invocation limits of §3.1, back it with
  **Cloudflare Workflows** (durable, per-namespace steps, automatic retries) or a
  Queue. This is the "I don't want GitHub at all" fallback.
- **Write-behind SPARQL fallback (strategic end-state).** From
  `portable-deployment-design.md`: on a cache/R2 miss the Worker queries SPARQL,
  returns it, and `ctx.waitUntil`-writes it into R2. This **dissolves bulk
  seeding** — a fresh button deploy needs only an endpoint configured, and R2
  populates lazily under real traffic. The best long-term answer for private data;
  a bundled fallback source could do the same for public vocab.

---

## 6. Status & rollout

| Item | Status |
|---|---|
| Phase 1 — Deploy button / template / C3 wiring | designed (§2); not yet added to README |
| Phase 2, Mode 1 — file-in-`labels/` GitHub Action | **implemented** (§3.3) |
| Phase 2, Mode 2 — SPARQL endpoint | deferred (§3.4) |
| Cron / scheduled seeding | **rejected** — manual only; `seed.yml` cron removed (§3.1) |
| R2 credentials | **decided** — keep S3 bulk token, guide the setup (§4) |
| Projects | **decided** — one cache per repo; multi-project is the clone route (§3.6) |
| Self-seed Worker route (Workflows) | alternative, not started (§5) |
| Write-behind SPARQL fallback | tracked in `portable-deployment-design.md` |

**Next steps:** add the Deploy button + template + C3 entry to the README with a
loud "R2 is empty until you seed" note and the `SEED_BASE` hand-off; then wire
Mode 2 onto the same `seed-labels.yml` behind a `mode` input.
