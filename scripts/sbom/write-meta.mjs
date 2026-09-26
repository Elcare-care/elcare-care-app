#!/usr/bin/env node
/**
 * write-meta.mjs
 *
 * Emits the non-secret build-metadata JSON that accompanies every SBOM
 * produced by `.github/workflows/sbom.yml` (and by `generate-all.sh` for
 * local runs). This is the provenance record that lets a reviewer trace a
 * generated SBOM back to:
 *   - the exact lockfile it was built from (path + sha256),
 *   - the git commit and ref it was built at,
 *   - the CI run that produced it (when run in CI).
 *
 * No secrets or environment dumps are written here — only the specific,
 * documented fields below.
 *
 * Usage:
 *   node scripts/sbom/write-meta.mjs \
 *     --component frontend \
 *     --lockfile frontend/elcarehub-app/package-lock.json \
 *     --out sbom-frontend.meta.json
 *
 * Fields written:
 *   component        - logical name of the artifact this SBOM covers
 *   lockfile          - path (relative to repo root) to the lockfile used
 *   lockfileSha256    - sha256 of that lockfile's contents at generation time
 *   commit            - git commit SHA (GITHUB_SHA if set, else `git rev-parse HEAD`)
 *   ref               - git ref (GITHUB_REF if set, else current branch)
 *   generatedAt       - commit timestamp of `commit`, via `git log -1 --format=%cI`
 *                        (deliberately NOT wall-clock time, so re-generating
 *                        the SBOM from the same commit is reproducible)
 *   workflowRunUrl    - link to the CI run, when GITHUB_* env vars are present
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function git(...cmdArgs) {
  try {
    return execFileSync("git", cmdArgs, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const args = parseArgs(process.argv.slice(2));

for (const required of ["component", "lockfile", "out"]) {
  if (!args[required]) {
    console.error(`Missing required --${required} argument`);
    process.exit(2);
  }
}

const lockfilePath = resolve(args.lockfile);
const lockfileSha256 = sha256File(lockfilePath);

const commit = process.env.GITHUB_SHA || git("rev-parse", "HEAD");
const ref =
  process.env.GITHUB_REF ||
  git("symbolic-ref", "-q", "--short", "HEAD") ||
  git("rev-parse", "--abbrev-ref", "HEAD");

// Reproducible timestamp: the commit time of the commit being built, not
// wall-clock "now". Re-running generation against the same commit produces
// the same generatedAt value.
const generatedAt = git("log", "-1", "--format=%cI", commit || "HEAD");

let workflowRunUrl = null;
if (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID) {
  workflowRunUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
}

const meta = {
  component: args.component,
  lockfile: args.lockfile,
  lockfileSha256,
  commit: commit || null,
  ref: ref || null,
  generatedAt: generatedAt || null,
  workflowRunUrl,
};

writeFileSync(args.out, JSON.stringify(meta, null, 2) + "\n");
console.log(`[write-meta] wrote ${args.out}`);
console.log(JSON.stringify(meta, null, 2));
