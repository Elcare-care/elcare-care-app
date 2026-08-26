#!/usr/bin/env bash
# generate-all.sh
#
# Local reproduction of everything `.github/workflows/sbom.yml` does, minus
# the release-upload / GitHub Actions plumbing. Run this from the repo root
# to regenerate all SBOMs and their build-metadata files the same way CI
# does, for local iteration or debugging a failing sbom-*/check-freshness
# job.
#
# Outputs (repo root, gitignored — see .gitignore):
#   sbom-frontend.cdx.json / sbom-frontend.meta.json
#   sbom-indexer.cdx.json  / sbom-indexer.meta.json
#   sbom-contracts.cdx.json / sbom-contracts.meta.json
#   sbom-docker-indexer.cdx.json / sbom-docker-indexer.meta.json  (only if syft is installed)
#
# Requirements: node (>=18), npm, cargo. Optional: syft (for the docker job;
# https://github.com/anchore/syft#installation) — skipped with a warning if
# absent, since it isn't part of this repo's normal dev toolchain.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "== SBOM generation (local) — repo root: $ROOT_DIR =="

# ── frontend ─────────────────────────────────────────────────────────────
echo
echo "-- sbom-frontend --"
npx --yes @cyclonedx/cyclonedx-npm@^1 \
  --output-format json \
  --output-reproducible \
  --output-file "$ROOT_DIR/sbom-frontend.cdx.json" \
  "$ROOT_DIR/frontend/elcarehub-app/package.json"
node scripts/sbom/write-meta.mjs \
  --component frontend \
  --lockfile frontend/elcarehub-app/package-lock.json \
  --out sbom-frontend.meta.json

# ── indexer ──────────────────────────────────────────────────────────────
echo
echo "-- sbom-indexer --"
npx --yes @cyclonedx/cyclonedx-npm@^1 \
  --output-format json \
  --output-reproducible \
  --output-file "$ROOT_DIR/sbom-indexer.cdx.json" \
  "$ROOT_DIR/indexer/package.json"
node scripts/sbom/write-meta.mjs \
  --component indexer \
  --lockfile indexer/package-lock.json \
  --out sbom-indexer.meta.json

# ── contracts (Rust workspace) ──────────────────────────────────────────
echo
echo "-- sbom-contracts --"
cargo metadata --format-version=1 --locked > cargo-metadata.json
node scripts/sbom/cargo-metadata-to-cyclonedx.mjs cargo-metadata.json sbom-contracts.cdx.json
rm -f cargo-metadata.json
node scripts/sbom/write-meta.mjs \
  --component contracts \
  --lockfile Cargo.lock \
  --out sbom-contracts.meta.json

# ── docker (indexer image) ──────────────────────────────────────────────
echo
echo "-- sbom-docker-indexer --"
if command -v syft >/dev/null 2>&1; then
  syft dir:"$ROOT_DIR/indexer" \
    --output cyclonedx-json="$ROOT_DIR/sbom-docker-indexer.cdx.json"
  node scripts/sbom/write-meta.mjs \
    --component docker-indexer \
    --lockfile indexer/package-lock.json \
    --out sbom-docker-indexer.meta.json
else
  echo "syft not found on PATH — skipping sbom-docker-indexer."
  echo "Install: https://github.com/anchore/syft#installation"
  echo "CI generates this one against the built indexer:latest image via anchore/sbom-action."
fi

echo
echo "== Done. Generated files: =="
ls -1 sbom-*.json 2>/dev/null || true
