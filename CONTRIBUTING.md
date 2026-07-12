# Contributing

Thanks for your interest in improving RDF Label Cache. This guide covers the workflow, the
commit and release conventions, and how CI is wired.

## Ways to contribute

- **Bugs / ideas** — open an issue describing the problem or proposal.
- **Code / docs** — fork the repo, make your change on a branch, and open a pull request.

## Getting set up

Requirements: **Node 22** and **pnpm** (the repo pins `pnpm@11.3.0` via `packageManager`;
Corepack will use it automatically).

```bash
git clone https://github.com/recalcitrantsupplant/label-cdn && cd label-cdn
pnpm install                 # frozen lockfile in CI; commit lockfile changes
```

Everything CI runs is in `scripts/`, so you can reproduce it locally:

```bash
./scripts/ci.sh              # install (frozen) + typecheck + test — the full CI gate
# or individually:
pnpm typecheck               # tsc --noEmit
pnpm test                    # vitest (Workers pool)
```

CI runs `./scripts/ci.sh` on every push and PR (`.github/workflows/ci.yml`). Keep it
green — PRs that fail typecheck or tests won't merge.

## Making a change

1. Branch off `main` (`git switch -c fix/thing` or `feat/thing`).
2. Make the change **with tests** — the suite must cover new behaviour and keep passing.
3. Run `./scripts/ci.sh` locally.
4. Open a PR against `main`. Keep it focused; describe the *why*, not just the *what*.

Project conventions worth matching:

- **Thin workflows, logic in scripts.** GitHub Actions only check out, set up the
  toolchain, and call a `scripts/*.sh` script. Put real logic in a versioned script so it
  runs identically locally and in CI.
- **IRI-keyed, namespace-agnostic.** The Worker builds the R2 key from the IRI; don't add
  per-namespace registration or config.

## Commit messages — Conventional Commits (required)

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/). This is
not cosmetic: **release-please derives the next version and the changelog from commit
types**, so the wrong type ships the wrong release (or none).

```
<type>(optional-scope): summary in the imperative

feat(label): return altLabel when present
fix(seed): fail fast on missing R2 credentials
docs(faq): correct the all-languages-bundle key
```

Common types: `feat` (minor bump), `fix` (patch bump), `docs`, `refactor`, `test`, `ci`,
`build`, `chore`, `perf`. A breaking change — `feat!:` or a `BREAKING CHANGE:` footer —
triggers a major bump.

Enforcement is automatic on both sides:

- **Locally** — a husky `commit-msg` hook runs commitlint (`@commitlint/config-conventional`)
  as you commit. Run `pnpm install` once so husky installs the hook.
- **In CI** — `commitlint.yml` lints every commit in a PR (Dependabot's machine commits are
  exempt).

## How releases work (release-please)

You don't cut releases by hand — [release-please](https://github.com/googleapis/release-please)
does it from the commit history:

1. When Conventional Commits land on `main`, release-please opens/updates a **release PR**
   that bumps the version in `package.json` + `.release-please-manifest.json` and writes the
   `CHANGELOG.md` entry.
2. A **maintainer merges that release PR**, which tags `vX.Y.Z` and cuts a GitHub Release
   (`.github/workflows/release.yml`).
3. On a cut release, CI re-runs the full suite and deploys the public demo. These steps are
   guarded to the maintainer's account and need Cloudflare secrets, so they're inert in
   forks — you don't need any of it to contribute.

So as a contributor: **write good Conventional Commits and the release takes care of
itself.** No version bumps or changelog edits in your PR — release-please owns those files.

## Dependencies

- Commit the `pnpm-lock.yaml` when you add or update a dependency; CI installs with
  `--frozen-lockfile`.
- **Minimum package age is enforced** — new dependency releases aren't adopted until
  they're at least a week old, a guard against compromised fresh publishes. This is done at
  the point updates enter the repo, via Dependabot `cooldown` (`.github/dependabot.yml`);
  pnpm's `minimumReleaseAge` is intentionally left unset (see the note in
  `pnpm-workspace.yaml`). Prefer minimal, well-scoped dependencies.

---

Questions or unsure about scope? Open an issue first and we'll figure out the shape
together.
