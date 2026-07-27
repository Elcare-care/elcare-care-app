#!/usr/bin/env bash
# ============================================================
# scripts/docker/update-image-digests.sh
#
# Prints the current SHA256 digests for the base images used in
# the indexer Dockerfile so an operator can pin them.
#
# Usage:
#   ./scripts/docker/update-image-digests.sh
#
# Output: the FROM lines to paste into indexer/Dockerfile, e.g.:
#   FROM node:20-alpine@sha256:<digest> AS builder
#   FROM node:20-alpine@sha256:<digest> AS runtime
#
# Schedule: run this at least monthly and after any CVE disclosure
# that affects node or alpine. Commit the updated Dockerfile lines
# and let the container-scan CI job verify the new image is clean.
# ============================================================
set -euo pipefail

IMAGES=("node:20-alpine")

echo "Fetching current digests (docker pull required for up-to-date results)..."
echo ""

for IMAGE in "${IMAGES[@]}"; do
  docker pull --quiet "$IMAGE" >/dev/null 2>&1 || true
  DIGEST=$(docker inspect "$IMAGE" --format '{{index .RepoDigests 0}}' 2>/dev/null || echo "")
  if [[ -z "$DIGEST" ]]; then
    echo "ERROR: could not resolve digest for $IMAGE. Is docker running?"
    exit 1
  fi
  echo "# Paste into indexer/Dockerfile:"
  echo "FROM ${DIGEST} AS builder"
  echo "FROM ${DIGEST} AS runtime"
  echo ""
done

echo "Steps:"
echo "  1. Copy the FROM lines above into indexer/Dockerfile."
echo "  2. Rebuild:  docker build ./indexer"
echo "  3. Scan:     git push  (triggers container-scan CI job)"
echo "  4. Commit the updated Dockerfile once CI passes."
