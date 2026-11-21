# CI Artifacts — SBOM Generation

This document is the operator-facing reference for the SBOM generation pipeline
in `.github/workflows/sbom.yml`.  It describes what each job produces, where the
outputs land, how to reproduce them locally, and what to check if the pipeline
breaks.

For the full format rationale, review guidance for vendored components, and the
provenance-tracing procedure, see [`docs/SBOM.md`](./SBOM.md).

---

## What is generated

The workflow produces four CycloneDX 1.5 JSON SBOMs, each with a sibling
`*.meta.json` provenance record:

| Artifact | Covers | Generator | Source lockfile |
|---|---|---|---|
| `sbom-frontend.cdx.json` | `frontend/elcarehub-app` npm workspace | `@cyclonedx/cyclonedx-npm` | `frontend/elcarehub-app/package-lock.json` |
| `sbom-indexer.cdx.json` | `indexer` npm workspace | `@cyclonedx/cyclonedx-npm` | `indexer/package-lock.json` |
| `sbom-contracts.cdx.json` | Rust/Soroban workspace (`contracts/*` + vendored patch) | `cargo metadata --locked` → `scripts/sbom/cargo-metadata-to-cyclonedx.mjs` | `Cargo.lock` |
| `sbom-docker-indexer.cdx.json` | Built indexer container image (OS packages, Prisma, prod `node_modules`) | [`anchore/sbom-action`](https://github.com/anchore/sbom-action) (syft) | `indexer/package-lock.json` (provenance only) |

---

## Where outputs land

| Trigger | Location | Retention |
|---|---|---|
| Pull request or `workflow_dispatch` | Build artifact `sbom-bundle-<sha>` on the workflow run, plus individual `sbom-<component>` artifacts | 90 days |
| `v*` tag push | Attached to the GitHub Release for that tag as release assets | Permanent |

Download an artifact bundle from a PR run:

```bash
# Install the GitHub CLI if not already present
# https://cli.github.com

gh run download <RUN_ID> -n sbom-bundle-<SHA> --dir ./sboms
ls ./sboms
```

---

## Generating SBOMs locally

`scripts/sbom/generate-all.sh` mirrors every step the workflow runs.  It writes
`sbom-*.cdx.json` and `sbom-*.meta.json` to the repository root (both patterns
are gitignored).

**Requirements:** `node` ≥ 20, `npm`, `cargo` (stable).  
`syft` is optional — without it the Docker SBOM step is skipped with a note.

```bash
./scripts/sbom/generate-all.sh
```

The script runs the following commands in order:

### 1 — Frontend SBOM

```bash
npx --yes @cyclonedx/cyclonedx-npm@^1 \
  --output-format json \
  --output-reproducible \
  --output-file sbom-frontend.cdx.json \
  frontend/elcarehub-app/package.json

node scripts/sbom/write-meta.mjs \
  --component frontend \
  --lockfile frontend/elcarehub-app/package-lock.json \
  --out sbom-frontend.meta.json
```

### 2 — Indexer SBOM

```bash
npx --yes @cyclonedx/cyclonedx-npm@^1 \
  --output-format json \
  --output-reproducible \
  --output-file sbom-indexer.cdx.json \
  indexer/package.json

node scripts/sbom/write-meta.mjs \
  --component indexer \
  --lockfile indexer/package-lock.json \
  --out sbom-indexer.meta.json
```

### 3 — Contracts SBOM

```bash
cargo metadata --format-version=1 --locked > cargo-metadata.json

node scripts/sbom/cargo-metadata-to-cyclonedx.mjs \
  cargo-metadata.json \
  sbom-contracts.cdx.json

node scripts/sbom/write-meta.mjs \
  --component contracts \
  --lockfile Cargo.lock \
  --out sbom-contracts.meta.json
```

### 4 — Docker image SBOM (optional locally)

```bash
docker build \
  --build-arg BUILD_SHA=$(git rev-parse HEAD) \
  --build-arg BUILD_TIME=$(git log -1 --format=%cI) \
  -t elcarehub-indexer-sbom:local \
  indexer

# Requires syft: https://github.com/anchore/syft#installation
syft elcarehub-indexer-sbom:local \
  -o cyclonedx-json \
  --file sbom-docker-indexer.cdx.json

node scripts/sbom/write-meta.mjs \
  --component docker-indexer \
  --lockfile indexer/package-lock.json \
  --out sbom-docker-indexer.meta.json
```

---

## Freshness gate

After every generation run, CI verifies that each `*.meta.json`'s recorded
lockfile SHA-256 still matches the lockfile on disk:

```bash
node scripts/sbom/check-freshness.mjs \
  frontend/elcarehub-app/package-lock.json sbom-frontend.meta.json

node scripts/sbom/check-freshness.mjs \
  indexer/package-lock.json sbom-indexer.meta.json

node scripts/sbom/check-freshness.mjs \
  Cargo.lock sbom-contracts.meta.json

node scripts/sbom/check-freshness.mjs \
  indexer/package-lock.json sbom-docker-indexer.meta.json
```

If this check fails, treat it as "SBOM generation is broken" rather than a
content drift issue — the SBOMs are always regenerated fresh from the
checked-out lockfile in the same workflow run.  Rerunning the workflow on the
same commit should produce identical `generatedAt` timestamps (which are set to
the commit timestamp, not wall-clock time).

---

## Non-empty gate

Each SBOM must have at least one entry in its `components` array:

```bash
# Quick local check
for f in sbom-*.cdx.json; do
  count=$(node -e "console.log((JSON.parse(require('fs').readFileSync('$f')).components||[]).length)")
  echo "$f: $count components"
done
```

A count of zero means the tool ran but produced an empty SBOM — check that the
lockfile is committed (`--locked` flag requires it for `cargo metadata`) and that
`npm install` has been run in the relevant workspace.

---

## Expected outputs on a clean checkout

After running `./scripts/sbom/generate-all.sh` from a clean checkout with locked
lockfiles, you should see approximately:

| File | Min component count | Notes |
|---|---|---|
| `sbom-frontend.cdx.json` | > 200 | Next.js + React + all frontend deps |
| `sbom-indexer.cdx.json` | > 100 | Express + Prisma + indexer deps |
| `sbom-contracts.cdx.json` | > 30 | Soroban SDK + workspace crates + vendored patch |
| `sbom-docker-indexer.cdx.json` | > 150 | Alpine OS packages + production npm + Prisma engine |

The contracts SBOM will contain one component with `"provenance": "vendored-patch"` for
`patches/soroban-env-host-25.0.1`.  This is expected and documented in
[`docs/SBOM.md` — Review guidance for exceptions](./SBOM.md#review-guidance-for-exceptions).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `cargo metadata` exits non-zero | `Cargo.lock` out of sync with `Cargo.toml` | Run `cargo generate-lockfile` and commit |
| `@cyclonedx/cyclonedx-npm` outputs 0 components | `package-lock.json` missing | Run `npm install` in the workspace directory |
| Freshness check fails | SBOM was not regenerated (cached artifact used) | Re-run the workflow; do not use `--reuse-artifacts` |
| Docker SBOM step skipped locally | `syft` not installed | Install from [anchore/syft](https://github.com/anchore/syft#installation) or rely on CI |
| Release assets missing after tag push | Release creation step failed | Check workflow logs; manually run `gh release upload <tag> sboms/*.cdx.json sboms/*.meta.json` |

---

## Owner

| Role | Contact |
|---|---|
| **Primary:** Security Lead | security@elcarehub.xyz |
| **Secondary:** DevOps Engineer | devops@elcarehub.xyz |

**Rollback:** SBOMs are read-only audit artifacts — no rollback needed.  
If a generated SBOM is incorrect, regenerate from the same commit and re-upload
the release assets with `gh release upload <tag> ... --clobber`.

---

## Related

- [`docs/SBOM.md`](./SBOM.md) — full format, provenance tracing, vendored patch review guidance
- [`.github/workflows/sbom.yml`](../.github/workflows/sbom.yml) — workflow source
- [`scripts/sbom/`](../scripts/sbom/) — generation scripts (`generate-all.sh`, `cargo-metadata-to-cyclonedx.mjs`, `write-meta.mjs`, `check-freshness.mjs`)
- [`docs/RELEASE_VERIFICATION.md`](./RELEASE_VERIFICATION.md) — how release artifacts including SBOMs are signed and verified
