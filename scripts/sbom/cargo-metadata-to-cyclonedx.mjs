#!/usr/bin/env node
/**
 * cargo-metadata-to-cyclonedx.mjs
 *
 * Transforms `cargo metadata --format-version=1 --locked` output into a
 * minimal, valid CycloneDX 1.5 JSON SBOM for the Rust/Soroban workspace
 * (root Cargo.toml, covering every crate under contracts/* plus the
 * vendored `patches/soroban-env-host-25.0.1` patch crate pulled in via
 * [patch.crates-io]).
 *
 * We use `cargo metadata` (built into cargo, no extra install, always
 * available on the Rust toolchain already installed for `cargo build`)
 * rather than `cargo-cyclonedx`, so this generation step has no external
 * tool dependency and no version drift to pin/maintain. See docs/SBOM.md
 * for the rationale.
 *
 * Every resolved package becomes a `component`. Components whose manifest
 * lives under `patches/` (i.e. resolved via a `[patch.crates-io]` path
 * override rather than a registry) get an explicit
 *   { "name": "provenance", "value": "vendored-patch" }
 * entry in their CycloneDX `properties` array, plus the upstream
 * repository/version it was vendored from when derivable from the
 * manifest. Reviewers should treat that marker as "this component is
 * intentionally not resolvable to a crates.io registry entry" rather than
 * a missing/broken SBOM entry — see docs/SBOM.md "Review guidance for
 * exceptions".
 *
 * Usage:
 *   cargo metadata --format-version=1 --locked > cargo-metadata.json
 *   node scripts/sbom/cargo-metadata-to-cyclonedx.mjs \
 *     cargo-metadata.json sbom-contracts.cdx.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const [, , metadataPath, outPath] = process.argv;

if (!metadataPath || !outPath) {
  console.error(
    "Usage: node scripts/sbom/cargo-metadata-to-cyclonedx.mjs <cargo-metadata.json> <out.cdx.json>",
  );
  process.exit(2);
}

const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
const workspaceRoot = metadata.workspace_root || "";
const workspaceMembers = new Set(metadata.workspace_members || []);

function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function purl(name, version) {
  return `pkg:cargo/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function licensesFor(pkg) {
  if (pkg.license) {
    // CycloneDX accepts a single SPDX id or a compound SPDX expression
    // (e.g. "MIT OR Apache-2.0") interchangeably under `expression`.
    return [{ expression: pkg.license }];
  }
  if (pkg.license_file) {
    return [{ license: { name: `See ${pkg.license_file}` } }];
  }
  return undefined;
}

function isVendoredPatch(pkg) {
  return typeof pkg.manifest_path === "string" && pkg.manifest_path.includes("/patches/");
}

const components = (metadata.packages || [])
  // Skip build/dev-only synthetic entries with no version (shouldn't occur,
  // but keep the transform defensive).
  .filter((pkg) => pkg && pkg.name && pkg.version)
  .map((pkg) => {
    const isWorkspaceMember = workspaceMembers.has(pkg.id);
    const vendoredPatch = isVendoredPatch(pkg);

    const properties = [
      { name: "cdx:cargo:packageId", value: pkg.id },
      {
        name: "cdx:cargo:source",
        value: pkg.source || (vendoredPatch ? "vendored-patch-path" : "workspace-path"),
      },
    ];

    if (vendoredPatch) {
      properties.push({ name: "provenance", value: "vendored-patch" });
      properties.push({
        name: "provenance:upstream-repository",
        value: pkg.repository || "https://github.com/stellar/rs-soroban-env",
      });
      properties.push({
        name: "provenance:manifest-path",
        value: pkg.manifest_path.replace(workspaceRoot, "."),
      });
    }

    return {
      type: isWorkspaceMember && !vendoredPatch ? "application" : "library",
      "bom-ref": `${pkg.name}@${pkg.version}`,
      name: pkg.name,
      version: pkg.version,
      purl: purl(pkg.name, pkg.version),
      licenses: licensesFor(pkg),
      description: pkg.description || undefined,
      properties,
    };
  });

const commit = process.env.GITHUB_SHA || git("rev-parse", "HEAD");
const generatedAt = git("log", "-1", "--format=%cI", commit || "HEAD");

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: generatedAt || new Date().toISOString(),
    component: {
      type: "application",
      "bom-ref": "elcare-contracts-workspace",
      name: "elcare-care-app-contracts",
      version: commit ? commit.slice(0, 12) : "unknown",
    },
    tools: [
      {
        vendor: "elcare-care-app",
        name: "scripts/sbom/cargo-metadata-to-cyclonedx.mjs",
        version: "1.0.0",
      },
    ],
  },
  components,
};

writeFileSync(outPath, JSON.stringify(bom, null, 2) + "\n");

const vendoredCount = components.filter((c) =>
  c.properties.some((p) => p.name === "provenance" && p.value === "vendored-patch"),
).length;

console.log(
  `[cargo-metadata-to-cyclonedx] wrote ${outPath} with ${components.length} components ` +
    `(${vendoredCount} marked provenance:vendored-patch)`,
);
