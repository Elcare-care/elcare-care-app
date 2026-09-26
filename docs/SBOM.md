# Software Bill of Materials (SBOM)

This document describes the SBOM (Software Bill of Materials) and
dependency-provenance pipeline for elcare-care-app, implemented in
[`.github/workflows/sbom.yml`](../.github/workflows/sbom.yml). It exists so
an operator (or an auditor responding to an incident/CVE) can answer:
"what's actually in this release, where did it come from, and can I trust
it wasn't tampered with between lockfile and shipped artifact."

This is a separate concern from the vulnerability-scanning `dependency-scan`
job described in [`SECURITY_SCANNING_TRIAGE.md`](../SECURITY_SCANNING_TRIAGE.md)
(`cargo audit` / `npm audit`). Vulnerability scanning tells you if a known-bad
package version is present. SBOM generation tells you what packages,
versions, and licenses are present at all, and how each one traces back to a
lockfile and (for the container image) an image layer — regardless of
whether anything is currently flagged as vulnerable.

## What is generated

Four CycloneDX 1.5 JSON SBOMs, one per release-relevant artifact:

| SBOM file | Covers | Source of truth | Generator |
|---|---|---|---|
| `sbom-frontend.cdx.json` | `frontend/elcarehub-app` npm workspace | `frontend/elcarehub-app/package-lock.json` | `@cyclonedx/cyclonedx-npm` |
| `sbom-indexer.cdx.json` | `indexer` npm workspace | `indexer/package-lock.json` | `@cyclonedx/cyclonedx-npm` |
| `sbom-contracts.cdx.json` | Rust/Soroban workspace (`contracts/*` + the vendored `patches/soroban-env-host-25.0.1` crate) | root `Cargo.lock` (via `cargo metadata --locked`) | `scripts/sbom/cargo-metadata-to-cyclonedx.mjs` |
| `sbom-docker-indexer.cdx.json` | The built `indexer` container image (OS packages, Prisma engine binaries, production `node_modules`) | The image built from `indexer/Dockerfile` at the commit being released | [`anchore/sbom-action`](https://github.com/anchore/sbom-action) (syft) |

Each SBOM has a sibling `*.meta.json` build-provenance file (see below).

### Why `cargo metadata` instead of `cargo-cyclonedx` for contracts

We chose `cargo metadata --format-version=1 --locked` (built into cargo,
already present wherever `cargo build` runs — no extra tool to install or
version-pin) piped through a small transform script
(`scripts/sbom/cargo-metadata-to-cyclonedx.mjs`) rather than the
`cargo-cyclonedx` subcommand. This keeps the contracts SBOM job dependency-free
and fast, and gives us direct control over how the vendored patch crate is
flagged (see "Review guidance for exceptions" below). If `cargo-cyclonedx`
is adopted later for richer CycloneDX output (e.g. dependency-graph edges),
the transform script can be swapped without changing the workflow's
job/output contract.

### Why a real image build instead of a directory scan for Docker

`sbom-docker` builds the actual `indexer` image (the same `docker build`
invocation `load-tests.yml` already uses) rather than running syft against
the Dockerfile's build context, so the SBOM reflects what's actually
shipped — Alpine OS packages, the Prisma-generated client, and
production-only (`npm ci --omit=dev`) dependencies — not just the source
lockfile. This costs a couple of extra minutes of CI time per run, which is
already paid elsewhere in this repo (`load-tests.yml`), so it wasn't worth
trading accuracy for speed here.

## Where to find SBOMs

- **On a release** (pushing a `v*` tag): all four SBOMs and their
  `*.meta.json` files are uploaded as assets on the GitHub Release for that
  tag (created if it doesn't already exist, or appended to if it does).
- **On a pull request / manual run**: SBOMs are uploaded as a workflow
  artifact bundle (`sbom-bundle-<sha>`) — visible under the workflow run's
  "Artifacts" section — for 90 days, plus each job also uploads its
  individual `sbom-<component>` artifact.

## Provenance / build metadata

Every SBOM ships with a `*.meta.json` file, written by
[`scripts/sbom/write-meta.mjs`](../scripts/sbom/write-meta.mjs). It contains
only non-secret fields:

```json
{
  "component": "contracts",
  "lockfile": "Cargo.lock",
  "lockfileSha256": "<sha256 of the lockfile at generation time>",
  "commit": "<git commit SHA the SBOM was built from>",
  "ref": "<git ref, e.g. refs/tags/v1.4.0 or a branch name>",
  "generatedAt": "<commit timestamp, ISO 8601 — NOT wall-clock build time>",
  "workflowRunUrl": "<link to the GitHub Actions run, when run in CI>"
}
```

`generatedAt` is deliberately the **commit's** timestamp
(`git log -1 --format=%cI`), not the time the workflow happened to run.
Re-running SBOM generation against the same commit therefore produces the
same `generatedAt`, which is what "reproducible generation" means here —
the SBOM's provenance record is a function of the commit, not of when CI
happened to execute.

**Tracing a package back to its source**: pick the `.meta.json` next to the
SBOM that contains it → `lockfile` field gives you the exact lockfile path →
`lockfileSha256` lets you confirm you're looking at the same lockfile
content the SBOM was generated from (recompute with `sha256sum <lockfile>`
and compare) → `commit` pins the exact repository state.

**Tracing a package back to its image layer**: `sbom-docker-indexer.cdx.json`
is generated by syft directly against the built image, so each component
syft finds already carries its origin layer in the raw syft output; the
CycloneDX conversion preserves package-level metadata (name, version, type
— e.g. `apk`, `npm`, or binary). For layer-level detail beyond what
CycloneDX JSON carries, re-run `syft` locally against the same image
(`docker build ... && syft <image>` — see `scripts/sbom/generate-all.sh`)
with `-o syft-json` for the full layer-attributed report.

## Staleness / freshness check (CI gate)

[`scripts/sbom/check-freshness.mjs`](../scripts/sbom/check-freshness.mjs)
takes a lockfile path and a `*.meta.json` path, recomputes the lockfile's
sha256, and fails if it doesn't match `lockfileSha256` recorded in the meta
file. The `sbom-attach-and-check` job in `sbom.yml` runs this for all four
SBOM/lockfile pairs on every PR and tag push (plus an additional check that
every SBOM has at least one `components` entry).

Because SBOMs are regenerated fresh in the same workflow run, this doesn't
detect drift across time so much as it validates that generation actually
ran, wrote metadata against the lockfile that's checked out, and didn't
silently produce an empty or mismatched file — i.e. it's an integrity
self-check on the pipeline itself, not just a diff against a historical
SBOM. If this check fails, treat it as "SBOM generation is broken," not as
something to bypass.

## Running locally

```bash
./scripts/sbom/generate-all.sh
```

This mirrors every step the workflow runs (same tool invocations, same
scripts) and writes `sbom-*.cdx.json` / `sbom-*.meta.json` to the repo root
(gitignored — see `.gitignore`). Requires `node`, `npm`, and `cargo`.
`syft` is optional locally (install from
https://github.com/anchore/syft#installation) — without it, the docker SBOM
step is skipped with a note that CI generates it via `anchore/sbom-action`.

## Review guidance for exceptions

Some components genuinely can't be resolved to a public registry entry, and
that is expected — not a sign of broken tooling. The one that currently
applies in this repo:

**`patches/soroban-env-host-25.0.1`** — this crate is vendored locally and
pulled in via `[patch.crates-io]` in the root `Cargo.toml` (see the comment
there) because `soroban-env-host`'s declared `ed25519-dalek >= 2.0.0` range
resolves to an incompatible v3 on crates.io. It has no independently
resolvable crates.io source at the version/commit actually built.

In `sbom-contracts.cdx.json`, this component (and any other component
resolved from a path under `patches/`) carries these properties:

```json
{
  "properties": [
    { "name": "provenance", "value": "vendored-patch" },
    { "name": "provenance:upstream-repository", "value": "https://github.com/stellar/rs-soroban-env" },
    { "name": "provenance:manifest-path", "value": "./patches/soroban-env-host-25.0.1/Cargo.toml" }
  ]
}
```

**When reviewing an SBOM (or a diff to one):**

- A component with `"provenance": "vendored-patch"` is expected and does
  **not** indicate a missing/incomplete SBOM entry. Its `purl` is still
  populated (`pkg:cargo/soroban-env-host@25.0.1`) for tooling that needs a
  package identifier, but that purl won't resolve against crates.io — that
  mismatch is the point of the marker.
- If a *new* component appears without a `licenses` field and without a
  `vendored-patch` marker, that's worth flagging — it usually means the
  upstream crate's `Cargo.toml` doesn't declare a `license`/`license_file`
  field, which is a legitimate (if less common) upstream gap, not a
  generation bug. Check the crate's repository directly before approving.
- If you add a new vendored/patched dependency under `patches/`, no workflow
  change is needed — `scripts/sbom/cargo-metadata-to-cyclonedx.mjs` detects
  any component whose `manifest_path` contains `/patches/` and marks it
  automatically.
