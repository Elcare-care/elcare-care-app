#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// scripts/contract-errors/validate-error-coverage.mjs
//
// Fails CI when a contract exports an error code/variant that the frontend's
// client-error catalog (frontend/elcarehub-app/src/lib/contractErrors/catalog.ts)
// doesn't know about. This is the enforcement half of the fixture library:
// the catalog can drift out of date the moment someone adds a new
// `#[contracterror]` variant to a contract without touching the frontend —
// this script is what turns that into a loud, immediate CI failure instead
// of a silent "generic failure" shown to a real user months later.
//
// Usage:
//   node scripts/contract-errors/validate-error-coverage.mjs
//
// Exit code 0 = every exported contract error has a client mapping with a
// matching name. Exit code 1 = coverage gap found (see printed report).
// ─────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

/** contract key (must match ContractName in catalog.ts) → Rust source + TS catalog const name */
const CONTRACTS = [
  {
    key: "marketplace",
    rustFile: "contracts/soroban-marketplace/src/types.rs",
    catalogConst: "MARKETPLACE_ERRORS",
  },
  {
    key: "launchpad",
    rustFile: "contracts/launchpad/src/types.rs",
    catalogConst: "LAUNCHPAD_ERRORS",
  },
  {
    key: "collection_nft_erc721",
    rustFile: "contracts/collection_nft_erc721/src/lib.rs",
    catalogConst: "COLLECTION_NFT_ERC721_ERRORS",
  },
  {
    key: "collection_nft_erc1155",
    rustFile: "contracts/collection_nft_erc1155/src/lib.rs",
    catalogConst: "COLLECTION_NFT_ERC1155_ERRORS",
  },
  {
    key: "lazy_mint_erc721",
    rustFile: "contracts/lazy_mint_erc721/src/lib.rs",
    catalogConst: "LAZY_MINT_ERC721_ERRORS",
  },
  {
    key: "lazy_mint_erc1155",
    rustFile: "contracts/lazy_mint_erc1155/src/lib.rs",
    catalogConst: "LAZY_MINT_ERC1155_ERRORS",
  },
];

const CATALOG_TS_PATH = join(
  REPO_ROOT,
  "frontend/elcarehub-app/src/lib/contractErrors/catalog.ts"
);

/**
 * Extracts { name, code } pairs from the `#[contracterror]`-annotated enum
 * in a Rust source file. Assumes the conventional shape used across this
 * repo's contracts: `#[contracterror]` immediately precedes a `#[derive...]`
 * `#[repr(u32)]` `pub enum <Name> { Variant = N, ... }` block with no nested
 * braces inside variants (true for every contract error enum today).
 */
function extractRustErrorVariants(rustSource, rustFile) {
  const attrIdx = rustSource.indexOf("#[contracterror]");
  if (attrIdx === -1) {
    throw new Error(`No #[contracterror] attribute found in ${rustFile}`);
  }

  const enumKeywordIdx = rustSource.indexOf("pub enum", attrIdx);
  const braceOpenIdx = rustSource.indexOf("{", enumKeywordIdx);
  if (enumKeywordIdx === -1 || braceOpenIdx === -1) {
    throw new Error(`Could not locate enum body after #[contracterror] in ${rustFile}`);
  }

  // Simple brace-depth scan to find the matching close brace — variants in
  // every contract error enum today are flat (no nested braces), but this
  // stays correct even if that ever changes.
  let depth = 0;
  let closeIdx = -1;
  for (let i = braceOpenIdx; i < rustSource.length; i++) {
    if (rustSource[i] === "{") depth++;
    else if (rustSource[i] === "}") {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) {
    throw new Error(`Unbalanced braces scanning enum body in ${rustFile}`);
  }

  const body = rustSource.slice(braceOpenIdx + 1, closeIdx);
  const variantPattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)\s*,?/gm;
  const variants = [];
  let match;
  while ((match = variantPattern.exec(body)) !== null) {
    variants.push({ name: match[1], code: Number.parseInt(match[2], 10) });
  }
  return variants;
}

/**
 * Extracts { name, code } pairs from a `const XXX_ERRORS: ContractErrorDefinition[] = [...]`
 * block in catalog.ts using the same "no nested braces per entry" assumption.
 */
function extractCatalogEntries(catalogSource, constName) {
  const declPattern = new RegExp(`const\\s+${constName}\\s*:\\s*ContractErrorDefinition\\[\\]\\s*=\\s*\\[`);
  const declMatch = catalogSource.match(declPattern);
  if (!declMatch) {
    throw new Error(`Could not find catalog const ${constName} in catalog.ts`);
  }

  const arrayStart = declMatch.index + declMatch[0].length - 1; // position of the "["
  let depth = 0;
  let closeIdx = -1;
  for (let i = arrayStart; i < catalogSource.length; i++) {
    if (catalogSource[i] === "[") depth++;
    else if (catalogSource[i] === "]") {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) {
    throw new Error(`Unbalanced brackets scanning ${constName} in catalog.ts`);
  }

  const body = catalogSource.slice(arrayStart + 1, closeIdx);
  const entryPattern = /\{\s*code:\s*(\d+),\s*name:\s*"([^"]+)"/g;
  const entries = [];
  let match;
  while ((match = entryPattern.exec(body)) !== null) {
    entries.push({ code: Number.parseInt(match[1], 10), name: match[2] });
  }
  return entries;
}

function main() {
  const catalogSource = readFileSync(CATALOG_TS_PATH, "utf8");
  let hasFailure = false;
  const report = [];

  for (const contract of CONTRACTS) {
    const rustPath = join(REPO_ROOT, contract.rustFile);
    let rustVariants;
    try {
      const rustSource = readFileSync(rustPath, "utf8");
      rustVariants = extractRustErrorVariants(rustSource, contract.rustFile);
    } catch (err) {
      hasFailure = true;
      report.push(`✗ ${contract.key}: failed to read/parse ${contract.rustFile} — ${err.message}`);
      continue;
    }

    let catalogEntries;
    try {
      catalogEntries = extractCatalogEntries(catalogSource, contract.catalogConst);
    } catch (err) {
      hasFailure = true;
      report.push(`✗ ${contract.key}: failed to parse catalog.ts — ${err.message}`);
      continue;
    }

    const catalogByCode = new Map(catalogEntries.map((e) => [e.code, e.name]));
    const missing = [];
    const mismatched = [];

    for (const variant of rustVariants) {
      const catalogName = catalogByCode.get(variant.code);
      if (catalogName === undefined) {
        missing.push(variant);
      } else if (catalogName !== variant.name) {
        mismatched.push({ ...variant, catalogName });
      }
    }

    const rustCodes = new Set(rustVariants.map((v) => v.code));
    const stale = catalogEntries.filter((e) => !rustCodes.has(e.code));

    if (missing.length === 0 && mismatched.length === 0) {
      report.push(`✓ ${contract.key}: ${rustVariants.length} contract errors, all mapped`);
    } else {
      hasFailure = true;
      report.push(`✗ ${contract.key}: coverage gap found`);
      for (const m of missing) {
        report.push(`    MISSING client mapping: ${m.name} = ${m.code}`);
      }
      for (const m of mismatched) {
        report.push(
          `    NAME MISMATCH at code ${m.code}: contract says "${m.name}", catalog says "${m.catalogName}"`
        );
      }
    }

    if (stale.length > 0) {
      report.push(`  ⚠ ${contract.key}: ${stale.length} catalog entr${stale.length === 1 ? "y" : "ies"} no longer present in the contract (safe to remove): ${stale.map((s) => `${s.name}=${s.code}`).join(", ")}`);
    }
  }

  console.log(report.join("\n"));

  if (hasFailure) {
    console.error(
      "\nContract error coverage validation FAILED. Add the missing entries to " +
        "frontend/elcarehub-app/src/lib/contractErrors/catalog.ts before merging.\n"
    );
    process.exit(1);
  }

  console.log("\nContract error coverage validation passed.\n");
}

main();
