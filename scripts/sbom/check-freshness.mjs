#!/usr/bin/env node
/**
 * check-freshness.mjs
 *
 * Validates that a generated SBOM's build-metadata file records the SHA-256
 * hash of the lockfile it was actually generated from, and that this hash
 * matches the current on-disk lockfile.
 *
 * This is the traceability + staleness check referenced by
 * `.github/workflows/sbom.yml`: every SBOM we ship is accompanied by a
 * `*.meta.json` file (see `scripts/sbom/write-meta.mjs`) that pins the exact
 * lockfile path and its content hash. If the lockfile on disk no longer
 * matches the hash recorded at SBOM-generation time, the SBOM is stale (or
 * generation silently failed) and the job should fail before it ships an
 * artifact that no longer reflects reality.
 *
 * Usage:
 *   node scripts/sbom/check-freshness.mjs <lockfilePath> <metaJsonPath>
 *
 * Exit codes:
 *   0  - meta file exists, hash matches current lockfile
 *   1  - meta file missing, malformed, or hash mismatch
 */

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

function fail(message) {
  console.error(`[check-freshness] FAIL: ${message}`);
  process.exit(1);
}

function sha256File(path) {
  const buf = readFileSync(path);
  return createHash("sha256").update(buf).digest("hex");
}

const [, , lockfileArg, metaArg] = process.argv;

if (!lockfileArg || !metaArg) {
  console.error(
    "Usage: node scripts/sbom/check-freshness.mjs <lockfilePath> <metaJsonPath>",
  );
  process.exit(2);
}

const lockfilePath = resolve(lockfileArg);
const metaPath = resolve(metaArg);

if (!existsSync(lockfilePath)) {
  fail(`lockfile not found at ${lockfilePath}`);
}

if (!existsSync(metaPath)) {
  fail(
    `build-metadata file not found at ${metaPath} (SBOM generation step likely did not run)`,
  );
}

let meta;
try {
  meta = JSON.parse(readFileSync(metaPath, "utf8"));
} catch (err) {
  fail(`could not parse ${metaPath} as JSON: ${err.message}`);
}

if (!meta.lockfileSha256) {
  fail(`${metaPath} is missing required field "lockfileSha256"`);
}

const currentHash = sha256File(lockfilePath);

if (meta.lockfileSha256 !== currentHash) {
  fail(
    `lockfile hash mismatch for ${lockfileArg}\n` +
      `  recorded in meta:  ${meta.lockfileSha256}\n` +
      `  current on disk:   ${currentHash}\n` +
      `This means the SBOM in this run was not generated from the lockfile\n` +
      `currently checked out, i.e. it is stale. Re-run SBOM generation.`,
  );
}

console.log(
  `[check-freshness] OK: ${metaArg} matches current ${lockfileArg} (sha256=${currentHash.slice(0, 12)}...)`,
);
process.exit(0);
