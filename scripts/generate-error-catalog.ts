#!/usr/bin/env ts-node
/**
 * generate-error-catalog.ts
 *
 * Bootstrap script that reads Rust source files and generates error-catalog.json.
 * Run: npx ts-node scripts/generate-error-catalog.ts
 *
 * For each contract it parses the #[contracterror] enum, extracts all variants
 * with their discriminants, and writes the result to error-catalog.json at the
 * project root.
 */

import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");

interface ContractSource {
  name: string;
  enumName: string;
  sourcePath: string;
}

const CONTRACTS: ContractSource[] = [
  {
    name: "soroban-marketplace",
    enumName: "MarketplaceError",
    sourcePath: "contracts/soroban-marketplace/src/types.rs",
  },
  {
    name: "collection-nft-erc721",
    enumName: "Error",
    sourcePath: "contracts/collection_nft_erc721/src/lib.rs",
  },
  {
    name: "collection-nft-erc1155",
    enumName: "Error",
    sourcePath: "contracts/collection_nft_erc1155/src/lib.rs",
  },
  {
    name: "lazy-mint-erc721",
    enumName: "Error",
    sourcePath: "contracts/lazy_mint_erc721/src/lib.rs",
  },
  {
    name: "lazy-mint-erc1155",
    enumName: "Error",
    sourcePath: "contracts/lazy_mint_erc1155/src/lib.rs",
  },
  {
    name: "launchpad",
    enumName: "Error",
    sourcePath: "contracts/launchpad/src/types.rs",
  },
];

/**
 * Parse a Rust source file for a `#[contracterror]` enum and return a map of
 * variant → discriminant.  Handles:
 *   - `Variant = N,`
 *   - inline comments (// ...)
 *   - doc comments (/// ...)
 */
function parseErrorEnum(
  source: string,
  enumName: string
): Record<string, number> {
  // Find the enum block — look for `pub enum EnumName {` preceded by
  // `#[contracterror]` somewhere above it (within 10 lines).
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

  if (Object.keys(errors).length === 0) {
    throw new Error(
      `Parsed zero variants from enum '${enumName}' — check the regex`
    );
  }

  return errors;
}

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

function main(): void {
  const catalog: Catalog = {
    version: "1.0.0",
    generated_at: new Date().toISOString(),
    contracts: {},
  };

  for (const contract of CONTRACTS) {
    const absPath = path.join(ROOT, contract.sourcePath);
    if (!fs.existsSync(absPath)) {
      console.error(`ERROR: Source file not found: ${absPath}`);
      process.exit(1);
    }

    const source = fs.readFileSync(absPath, "utf-8");
    let errors: Record<string, number>;
    try {
      errors = parseErrorEnum(source, contract.enumName);
    } catch (e) {
      console.error(`ERROR parsing ${contract.name}: ${(e as Error).message}`);
      process.exit(1);
    }

    catalog.contracts[contract.name] = {
      enum: contract.enumName,
      source: contract.sourcePath,
      errors,
    };

    const count = Object.keys(errors).length;
    console.log(`  ✓  ${contract.name}  →  ${count} variants`);
  }

  const outPath = path.join(ROOT, "error-catalog.json");
  fs.writeFileSync(outPath, JSON.stringify(catalog, null, 2) + "\n");
  console.log(`\nWrote ${outPath}`);
}

main();
