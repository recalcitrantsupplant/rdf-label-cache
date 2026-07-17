# Demo cutover & operations

One-time runbook to move the public demo off the old resources onto the
per-project scheme, **plus** the evergreen reference for how the demo is operated
(CI) and how that differs from what a self-hosting user does.

- **Part 1–4** — the one-time cutover (do once).
- **Part 5–7** — how the demo runs on an ongoing basis, and CI vs. end-user flow.

---

## What changes

| | Old | New |
|---|---|---|
| Worker | `rdf-label-cache` (and/or `rdf-label-resolver`) | `label-cache-demo` |
| R2 bucket | `rdf-public-labels` | `label-cache-demo` |
| Demo URL | `rdf-label-cache.dhabgood.workers.dev` | `label-cache-demo.dhabgood.workers.dev` |
| Product name | mixed (`rdf-label-resolver`, `label-cache`) | `rdf-label-cache` (brand) / `label-cache-<project>` (resources) |

`dhabgood` is the account-level workers.dev subdomain — it does **not** change.

> **Ordering note.** This runbook tears the old resources down **first** (you
> want a genuine clean slate on a pre-release demo). For a *live* service you'd
> invert it — stand the new instance up, verify, then delete the old — so there's
> never a dead window. The steps are the same; only the order flips.

---

## 1. Mint credentials in the Cloudflare portal

You need **two distinct tokens**. They are not interchangeable:

| Token | Made where | Used for | Needed by |
|---|---|---|---|
| **R2 API token** (S3 access key + secret) | dashboard → **R2** → **Manage API Tokens** → **Create API Token** → *Object Read & Write* | bulk seed upload over the S3 API (`upload-seed.mjs`, 32 concurrent PUTs) | **local & CI** |
| **Cloudflare API token** | **My Profile → API Tokens → Create** → permissions: *Workers Scripts: Edit*, *Workers R2 Storage: Edit*, *Account Settings: Read* | `wrangler deploy` + bucket create in **CI** (CI can't do browser OAuth) | **CI only** |

Locally you don't need the Cloudflare API token — `wrangler login` (OAuth) covers
deploy + bucket create. So **local = one token (R2 S3); CI = two tokens**.

Record from the R2 token screen: **Account ID**, **Access Key ID**, **Secret
Access Key** (the secret is shown once).

---

## 2. Clean slate — tear down the old resources

In the Cloudflare dashboard (or via `wrangler`, logged in):

1. **Workers & Pages** → delete every old demo Worker. Check the dashboard list
   first to see exactly what exists, then (`name` is a positional arg):
   ```bash
   pnpm exec wrangler delete rdf-label-cache
   pnpm exec wrangler delete rdf-label-resolver     # only if it exists
   ```
2. **R2** → empty then delete the old bucket (a bucket must be empty to delete):
   ```bash
   # dashboard: bucket → Settings → Delete (offers to empty first), OR:
   pnpm exec wrangler r2 bucket delete rdf-public-labels
   ```
3. **Routes / custom domains** — if any route pointed at the old Worker, remove it.
4. **Old tokens** — revoke any stale R2 / API tokens tied to the old setup.

Clean slate achieved.

---

## 3. Stand up the new demo (local, maintainer)

```bash
git checkout main && git pull --ff-only
just login                                    # browser OAuth
```

Create the bucket and deploy the **demo config** (this is the maintainer path —
it carries the landing pages via `[assets]`; it is *not* `just deploy`):

```bash
just project=demo bucket                      # creates bucket label-cache-demo
pnpm wrangler deploy -c demo/wrangler.demo.toml   # deploys Worker + landing pages
#   → prints https://label-cache-demo.dhabgood.workers.dev   (confirm this matches)
```

> The demo deploys `demo/wrangler.demo.toml` (Worker `label-cache-demo`, bucket
> `label-cache-demo`, `[assets] = ./public`). A self-hoster instead runs
> `just project=<name> deploy`, which uses the root `wrangler.toml` — **no
> `[assets]`, API only.** See Part 6.

Now put credentials in `.env` (copy `.env.example`) — `SEED_BASE` is the URL you
just saw printed:

```
PROJECT=demo
SEED_BASE=https://label-cache-demo.dhabgood.workers.dev
CLOUDFLARE_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
```

Seed the full public vocabulary (~3,200 terms, S3 bulk upload) and verify:

```bash
just project=demo seed-public                 # ingest all bundled vocabs → S3 upload
just demo https://label-cache-demo.dhabgood.workers.dev
```

`just demo` should report the namespace count and resolve `skos:Concept` /
`owl:Class`, and the context should list its prefixes. Open the URL in a browser
to confirm the landing pages render.

---

## 4. (Recommended) Prove isolation with a second project

Confirms a self-hoster's deploy is API-only and never ships demo content:

```bash
just project=orders bucket
just project=orders deploy                    # root config (no [assets])
curl -s -o /dev/null -w '%{http_code}\n' https://label-cache-orders.dhabgood.workers.dev/    # → 404 (no landing page)
curl -s "https://label-cache-orders.dhabgood.workers.dev/label?iri=http%3A%2F%2Fwww.w3.org%2F2004%2F02%2Fskos%2Fcore%23Concept"   # → API works
```

A `404` on `/` next to a working `/label` lookup is the proof: `demo/public/*`
lives only in the demo config, never in a per-project deploy. Tear the test
project down afterward (delete Worker `label-cache-orders`, empty+delete its
bucket).

---

## 5. CI automation for the demo

The demo runs itself from the repo. Set these in the **maintainer repo**
(Settings → Secrets and variables → Actions):

| Kind | Name | Value |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | the Cloudflare API token from Part 1 |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | your account ID (also the R2 S3 endpoint host) |
| Secret | `R2_ACCESS_KEY_ID` | R2 token access key |
| Secret | `R2_SECRET_ACCESS_KEY` | R2 token secret |
| Secret | `PURGE_TOKEN` | *(optional)* cache-purge bearer token |
| Var | `SEED_BASE` | `https://label-cache-demo.dhabgood.workers.dev` |
| Var | `R2_BUCKET` | `label-cache-demo` |

**Code and data have separate lifecycles — two independent pipelines:**

| Workflow | Trigger | Runs | Auth | Touches |
|---|---|---|---|---|
| `ci.yml` | every push to `main` + PRs | `scripts/ci.sh` (typecheck + tests) | none | nothing |
| `release.yml` | push to `main` → release-please; on a cut release → `ci.sh` + `deploy-demo.sh` | deploys demo **code** | `CLOUDFLARE_API_TOKEN` | Worker `label-cache-demo` |
| `deploy-demo.yml` | manual (`workflow_dispatch`) | `deploy-demo.sh` | `CLOUDFLARE_API_TOKEN` | Worker `label-cache-demo` |
| `seed.yml` | manual + monthly cron | `seed.sh` (ingest + S3 upload) | `R2_*` | bucket `label-cache-demo` |

So: **deploying the Worker never reseeds R2, and reseeding never redeploys the
Worker.** `deploy-demo.sh` also ensures the bucket exists (idempotent), so a
first release won't 500 on a missing bucket.

All demo workflows are guarded by `if: github.repository_owner == '...'` and need
secrets forks don't have — they're inert in clones.

---

## 6. CI automation vs. end-user flow

Same building blocks, wired differently. The demo pipeline is **not** meant to
mirror the user flow — it's automation for one specific instance.

| | Demo (CI automation) | End user (clone + per-project) |
|---|---|---|
| Auth for deploy | `CLOUDFLARE_API_TOKEN` secret (no browser) | `wrangler login` (OAuth, browser) |
| Tokens needed | two (CF API for deploy **+** R2 S3 for seed) | one (R2 S3 for seed) |
| Wrangler config | `demo/wrangler.demo.toml` — **has `[assets]`** (landing pages) | root `wrangler.toml` — **no assets**, API only |
| Deploy command | `scripts/deploy-demo.sh` (CI-only; requires the API token env) | `just project=<name> deploy` |
| Naming | fixed `label-cache-demo` | `label-cache-<project>` of their choice |
| Seed contents | all bundled public vocabularies | their own `data.ttl` ± chosen public vocabs |
| Deploy ↔ seed | decoupled (`release.yml` vs `seed.yml`), independent lifecycles | usually sequential (`bucket → deploy → seed`), or one-shot `just bootstrap` |
| Cadence | code on release, data monthly | once, then on demand |
| Upload mechanism | **identical** — `upload-seed.mjs`, S3 API, concurrent PUTs | **identical** |

The **upload path is deliberately the same** in both — one fast, well-tested
concurrent-S3 code path, not a separate loop for the demo. The only real
differences are *how you authenticate* (CI token vs OAuth) and *which wrangler
config you deploy* (demo-with-assets vs root-API-only).

---

## 7. Rollback & safety

- **Nothing precious is deleted.** The old bucket held only public-vocabulary
  labels, all regenerable by `just project=demo seed-public`. The old Worker was
  stateless.
- **If the new deploy misbehaves**, the code is versioned — redeploy an earlier
  tag with `wrangler deploy -c demo/wrangler.demo.toml` from that ref, or just
  fix forward; seeding is idempotent and re-runnable.
- **The old URL dies** when its Worker is deleted. Nothing public links to it
  pre-release; afterward, prefer the invert order (Part 0 note) so the new URL is
  live before the old one goes away.
