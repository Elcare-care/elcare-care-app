#!/usr/bin/env bash
set -euo pipefail

# Generate openapi.json and diff against committed version.
# Fails if the generated spec differs from what is in git.

echo "==> Generating OpenAPI spec..."
npx tsx indexer/src/generate-openapi.ts

echo "==> Diffing against committed openapi.json..."
if git diff --quiet openapi.json; then
  echo "==> OpenAPI spec is up to date."
else
  echo "FAIL: openapi.json is out of sync with route definitions." >&2
  echo "     Run 'npx tsx indexer/src/generate-openapi.ts' and commit the updated file." >&2
  exit 1
fi
