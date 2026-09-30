#!/usr/bin/env ts-node
/**
 * validate-error-catalog.ts
 *
 * CI gate script: parses every Rust error enum listed in error-catalog.json,
 * compares the live source against the catalog, and exits non-zero with a
 * descriptive message on any mismatch.
 *
 * Run: npx ts-node scripts/validate-error-catalog.ts
 *
 * Exit codes:
 *   0 — catalog is in sync with all Rust sources
 *   1 — one or more mismatches detected (error message printed to stderr)
 */

import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");
const CATALOG_PATH = path.join(ROOT, "error-catalog.json");

interface CatalogEntry {
  enum: string;
  source: string;
  errors: Record<string, number>;
}

interface Catalog {
  version: string;
  generated_at: string;
  contracts: Record<string, CatalogEntry>;
}

/**
 * Parse a Rust source file for a `#[contracterror]` enum and return a map of
 * variant → discriminant.  Identical logic to generate-error-catalog.ts.
 */
function parseErrorEnum(
  source: string,
  enumName: string
): Record<string, number> {
  const enumBlockRe = new RegExp(
    `#\\[contracterror\\][\\s\\S]{0,500}?pub enum ${enumName}\\s*\\{([^}]+)\\}`,
    "m"
  );
  const match = enumBlockRe.exec(source);
  if (!match) {
    throw new Error(`Could not find #[contracterror] enum '${enumName}'`);
  }

  const body = match[1];
  const variantRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)\s*,/gm;
  const errors: Record<string, number> = {};

  let vm: RegExpExecArray | null;
  while ((vm = variantRe.exec(body)) !== null) {
    errors[vm[1]] = parseInt(vm[2], 10);
  }

  return errors;
}

function sortedKeys(obj: Record<string, number>): string[] {
  return Object.keys(obj).sort();
}

function validate(): boolean {
  if (!fs.existsSync(CATALOG_PATH)) {
    console.error(
      `ERROR: error-catalog.json not found at ${CATALOG_PATH}\n` +
        `       Run: npx ts-node scripts/generate-error-catalog.ts`
    );
    return false;
  }

  const catalog: Catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf-8"));
  let allOk = true;

  for (const [contractName, entry] of Object.entries(catalog.contracts)) {
    const absPath = path.join(ROOT, entry.source);

    if (!fs.existsSync(absPath)) {
      console.error(
        `[${contractName}] MISSING source file: ${entry.source}\n` +
          `  The file listed in error-catalog.json no longer exists.\n` +
          `  Either restore the file or regenerate the catalog.`
      );
      allOk = false;
      continue;
    }

    const source = fs.readFileSync(absPath, "utf-8");
    let live: Record<string, number>;
    try {
      live = parseErrorEnum(source, entry.enum);
    } catch (e) {
      console.error(
        `[${contractName}] PARSE ERROR: ${(e as Error).message}\n` +
          `  Could not find enum '${entry.enum}' in ${entry.source}.\n` +
          `  If the enum was renamed, update error-catalog.json accordingly.`
      );
      allOk = false;
      continue;
    }

    const catalogKeys = sortedKeys(entry.errors);
    const liveKeys = sortedKeys(live);
    let contractOk = true;

    // Check for variants present in source but missing from catalog
    for (const variant of liveKeys) {
      if (!(variant in entry.errors)) {
        console.error(
          `[${contractName}] NEW VARIANT not in catalog: '${variant} = ${live[variant]}'\n` +
            `  Add it to error-catalog.json and re-run generate-error-catalog.ts.\n` +
            `  IMPORTANT: Never change an existing discriminant — it is a breaking ABI change.`
        );
        contractOk = false;
        allOk = false;
      } else if (live[variant] !== entry.errors[variant]) {
        console.error(
          `[${contractName}] DISCRIMINANT CHANGED for '${variant}':\n` +
            `  catalog says ${entry.errors[variant]}, source says ${live[variant]}\n` +
            `  Changing a discriminant is a breaking ABI change. Assign a new unused number instead.`
        );
        contractOk = false;
        allOk = false;
      }
    }

    // Check for variants in catalog but removed from source
    for (const variant of catalogKeys) {
      if (!(variant in live)) {
        console.error(
          `[${contractName}] REMOVED VARIANT still in catalog: '${variant} = ${entry.errors[variant]}'\n` +
            `  Removing a variant is a breaking ABI change.\n` +
            `  If intentional, remove it from error-catalog.json and document the breaking change.`
        );
        contractOk = false;
        allOk = false;
      }
    }

    if (contractOk) {
      console.log(
        `  ✓  ${contractName}  (${liveKeys.length} variants — catalog in sync)`
      );
    }
  }

  return allOk;
}

const ok = validate();
if (!ok) {
  console.error(
    "\n─────────────────────────────────────────────────────────────────────────\n" +
      "ERROR: error-catalog.json is out of sync with the Rust sources.\n" +
      "Fix the issues above, then run:\n" +
      "  npx ts-node scripts/generate-error-catalog.ts\n" +
      "and commit the updated catalog.\n" +
      "─────────────────────────────────────────────────────────────────────────"
  );
  process.exit(1);
} else {
  console.log("\n✅  error-catalog.json is in sync with all Rust sources.");
}
