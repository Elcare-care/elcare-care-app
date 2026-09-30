#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/abi/check-abi-compatibility.mjs
//
// Contract ABI compatibility gate.
//
// Extracts ground truth directly from the Rust contract sources and verifies
// that packages/contract-abi/abi.json stays in lockstep:
//
//   1. Version sync      — abi.json <contract>.version === CONTRACT_VERSION
//                          compiled into the Rust source.
//   2. Error coverage    — every #[contracterror] variant appears in abi.json
//                          with the same name and discriminant, and vice versa.
//   3. Method coverage   — every `pub fn` exported from a #[contractimpl] block
//                          appears in abi.json <contract>.methods (by name).
//
// Drift policy (ratchet):
//   Deviations listed in abi-baseline.json are *known* drift and pass with a
//   warning. ANY deviation not in the baseline fails the gate, so new contract
//   changes cannot silently desync the published ABI artifact. Baseline entries
//   that no longer deviate are reported so the ratchet can be tightened with
//   `--update-baseline`.
//
// Usage:
//   node scripts/abi/check-abi-compatibility.mjs                  # gate
//   node scripts/abi/check-abi-compatibility.mjs --update-baseline # rewrite baseline
//   node scripts/abi/check-abi-compatibility.mjs --strict          # baseline = failure too
//
// Exit 0 = compatible (or only known/baselined drift), exit 1 = new drift or
// parse failure.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const ABI_JSON_PATH = join(REPO_ROOT, 'packages', 'contract-abi', 'abi.json');
const BASELINE_PATH = join(__dirname, 'abi-baseline.json');

const UPDATE_BASELINE = process.argv.includes('--update-baseline');
const STRICT = process.argv.includes('--strict');

/**
 * Contracts under gate: abi.json key → Rust source files.
 *
 * Multiple files are scanned per contract because the artefacts live in
 * different places: `CONTRACT_VERSION` and `#[contractimpl]` entry points in
 * contract.rs, `#[contracterror]` enums in types.rs.
 */
const CONTRACTS = [
  {
    key: 'marketplace',
    rustFiles: [
      'contracts/soroban-marketplace/src/contract.rs',
      'contracts/soroban-marketplace/src/types.rs',
    ],
  },
  {
    key: 'launchpad',
    rustFiles: ['contracts/launchpad/src/contract.rs', 'contracts/launchpad/src/types.rs'],
  },
];

let failed = false;

function fail(msg) {
  console.error(`[FAIL] ${msg}`);
  failed = true;
}

function ok(msg) {
  console.log(`[ OK ] ${msg}`);
}

function warn(msg) {
  console.warn(`[WARN] ${msg}`);
}

// ── Rust extraction ───────────────────────────────────────────────────────────

/**
 * Finds the matching close brace for the brace at `openIdx`.
 * Returns the index of the closing brace, or -1.
 */
function findMatchingBrace(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Extracts CONTRACT_VERSION string constant from Rust source. */
function extractRustContractVersion(src, rustFile) {
  const match = src.match(/const\s+CONTRACT_VERSION\s*:\s*&str\s*=\s*"([^"]+)"/);
  if (!match) {
    throw new Error(`No CONTRACT_VERSION constant found in ${rustFile}`);
  }
  return match[1];
}

/**
 * Extracts { name, code } pairs from the `#[contracterror]` enum.
 * Same proven shape-assumption as scripts/contract-errors/validate-error-coverage.mjs:
 * flat enum body, `Variant = N,` per line.
 */
function extractRustErrorVariants(src, rustFile) {
  const attrIdx = src.indexOf('#[contracterror]');
  if (attrIdx === -1) {
    // A contract with zero errors legitimately has no #[contracterror] enum.
    return [];
  }
  const enumKeywordIdx = src.indexOf('pub enum', attrIdx);
  const braceOpenIdx = src.indexOf('{', enumKeywordIdx);
  if (enumKeywordIdx === -1 || braceOpenIdx === -1) {
    throw new Error(`Could not locate enum body after #[contracterror] in ${rustFile}`);
  }
  const closeIdx = findMatchingBrace(src, braceOpenIdx);
  if (closeIdx === -1) {
    throw new Error(`Unbalanced braces scanning #[contracterror] enum in ${rustFile}`);
  }

  const body = src.slice(braceOpenIdx + 1, closeIdx);
  const variantPattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)\s*,?/gm;
  const variants = [];
  let match;
  while ((match = variantPattern.exec(body)) !== null) {
    variants.push({ name: match[1], code: Number.parseInt(match[2], 10) });
  }
  return variants;
}

/**
 * Extracts the names of all `pub fn`s declared at the top level of any
 * `#[contractimpl]` block. Depth-aware so nested helper fns inside method
 * bodies are not counted.
 */
function extractRustContractMethods(src, rustFile) {
  const methods = [];
  let searchFrom = 0;

  for (;;) {
    const attrIdx = src.indexOf('#[contractimpl]', searchFrom);
    if (attrIdx === -1) break;
    searchFrom = attrIdx + '#[contractimpl]'.length;

    // Find the `impl` keyword then its opening brace.
    const implIdx = src.indexOf('impl', searchFrom);
    if (implIdx === -1) break;
    const braceOpenIdx = src.indexOf('{', implIdx);
    if (braceOpenIdx === -1) break;
    const closeIdx = findMatchingBrace(src, braceOpenIdx);
    if (closeIdx === -1) {
      throw new Error(`Unbalanced braces scanning #[contractimpl] block in ${rustFile}`);
    }

    const body = src.slice(braceOpenIdx + 1, closeIdx);
    // Walk lines tracking brace depth; capture `pub fn name(` at depth 1.
    const fnPattern = /^\s*pub\s+fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
    let match;
    while ((match = fnPattern.exec(body)) !== null) {
      // Ensure the match sits at depth 1 (direct child of the impl block),
      // ignoring anything nested deeper inside method bodies.
      const prefix = body.slice(0, match.index);
      let depth = 1;
      for (const ch of prefix) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (depth === 1) {
        methods.push(match[1]);
      }
    }

    searchFrom = closeIdx + 1;
  }

  return [...new Set(methods)].sort();
}

// ── Comparison ────────────────────────────────────────────────────────────────

function diffSets(rustNames, abiNames) {
  const abiSet = new Set(abiNames);
  const rustSet = new Set(rustNames);
  return {
    missingInAbi: rustNames.filter((n) => !abiSet.has(n)),
    staleInAbi: abiNames.filter((n) => !rustSet.has(n)),
  };
}

function main() {
  // ── Load abi.json ───────────────────────────────────────────────────────────
  let abi;
  try {
    abi = JSON.parse(readFileSync(ABI_JSON_PATH, 'utf8'));
  } catch (err) {
    fail(`Cannot read/parse ${ABI_JSON_PATH}: ${err.message}`);
    process.exit(1);
  }

  // ── Load baseline ───────────────────────────────────────────────────────────
  let baseline = {};
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    warn('No readable abi-baseline.json found — treating all deviations as NEW.');
  }
  delete baseline._comment;

  /** Collected deviations per contract, for baseline writing. */
  const actualDeviations = {};

  console.log('━━━ check-abi-compatibility ━━━\n');

  for (const contract of CONTRACTS) {
    const { key, rustFiles } = contract;

    // Concatenate every declared source file so version/errors/methods are
    // found wherever they live. Extraction functions are position-independent,
    // so concatenation is safe and keeps per-file plumbing minimal.
    let rustSrc = '';
    try {
      for (const rustFile of rustFiles) {
        rustSrc += readFileSync(join(REPO_ROOT, rustFile), 'utf8');
        rustSrc += '\n';
      }
    } catch (err) {
      fail(`${key}: cannot read contract sources: ${err.message}`);
      continue;
    }

    let rustVersion;
    let rustErrors;
    let rustMethods;
    try {
      rustVersion = extractRustContractVersion(rustSrc, rustFiles[0]);
      rustErrors = extractRustErrorVariants(rustSrc, rustFiles.join(', '));
      rustMethods = extractRustContractMethods(rustSrc, rustFiles.join(', '));
    } catch (err) {
      fail(`${key}: Rust extraction failed — ${err.message}`);
      continue;
    }

    const abiContract = abi.contracts?.[key];
    if (!abiContract) {
      fail(`${key}: missing from abi.json contracts`);
      continue;
    }

    const deviations = {
      missingMethodsInAbi: [],
      staleMethodsInAbi: [],
      missingErrorsInAbi: [],
      staleErrorsInAbi: [],
      mismatchedErrors: [],
    };
    actualDeviations[key] = deviations;

    // ── 1. Version sync ───────────────────────────────────────────────────────
    if (abiContract.version !== rustVersion) {
      fail(
        `${key}: version drift — abi.json=${abiContract.version}, ` +
          `Rust CONTRACT_VERSION=${rustVersion}`
      );
    } else {
      ok(`${key}: version in sync (${rustVersion})`);
    }

    // Baseline sets for this contract — deviations already recorded here are
    // *known* drift (warn-only unless --strict); anything else is NEW and fails.
    const base = baseline[key] ?? {};
    const baseMissingMethods = new Set(base.missingMethodsInAbi ?? []);
    const baseStaleMethods = new Set(base.staleMethodsInAbi ?? []);
    const baseMissingErrors = new Set(base.missingErrorsInAbi ?? []);
    const baseStaleErrors = new Set(base.staleErrorsInAbi ?? []);
    const baseMismatchedErrors = new Set(base.mismatchedErrors ?? []);

    /** Report one deviation: warn if baselined, fail otherwise. */
    const reportDeviation = (baselinedSet, item, message) => {
      if (baselinedSet.has(item)) {
        if (STRICT) {
          fail(`${message} [known drift, strict mode]`);
        } else {
          warn(`${message} [known drift, baselined]`);
        }
      } else {
        fail(`${message} [NEW drift]`);
      }
    };

    // ── 2. Error coverage ─────────────────────────────────────────────────────
    // abi.json keys errors by VARIANT NAME with the numeric discriminant as
    // the value: { "InvalidCid": 1, ... }.
    const abiErrors = abiContract.errors ?? {};
    const rustErrorNames = new Set(rustErrors.map((e) => e.name));

    for (const { name, code } of rustErrors) {
      const abiCode = abiErrors[name];
      if (abiCode === undefined) {
        deviations.missingErrorsInAbi.push(`${name}=${code}`);
      } else if (abiCode !== code) {
        deviations.mismatchedErrors.push(`${name}: rust=${code} abi=${abiCode}`);
      }
    }
    for (const [name, code] of Object.entries(abiErrors)) {
      if (!rustErrorNames.has(name)) {
        deviations.staleErrorsInAbi.push(`${name}=${code}`);
      }
    }

    if (
      deviations.missingErrorsInAbi.length === 0 &&
      deviations.staleErrorsInAbi.length === 0 &&
      deviations.mismatchedErrors.length === 0
    ) {
      ok(`${key}: error codes fully covered (${rustErrors.length} variants)`);
    } else {
      for (const m of deviations.missingErrorsInAbi) {
        reportDeviation(baseMissingErrors, m, `${key}: error missing from abi.json: ${m}`);
      }
      for (const m of deviations.staleErrorsInAbi) {
        reportDeviation(
          baseStaleErrors,
          m,
          `${key}: error in abi.json not in contract (stale): ${m}`
        );
      }
      for (const m of deviations.mismatchedErrors) {
        reportDeviation(baseMismatchedErrors, m, `${key}: error code mismatch: ${m}`);
      }
    }

    // ── 3. Method coverage ────────────────────────────────────────────────────
    const abiMethodNames = (abiContract.methods ?? []).map((m) => m.name);
    const { missingInAbi, staleInAbi } = diffSets(rustMethods, abiMethodNames);
    deviations.missingMethodsInAbi = missingInAbi;
    deviations.staleMethodsInAbi = staleInAbi;

    if (missingInAbi.length === 0 && staleInAbi.length === 0) {
      ok(`${key}: methods fully covered (${rustMethods.length} entry points)`);
    } else {
      for (const m of missingInAbi) {
        reportDeviation(
          baseMissingMethods,
          m,
          `${key}: contract method missing from abi.json: ${m}()`
        );
      }
      for (const m of staleInAbi) {
        reportDeviation(baseStaleMethods, m, `${key}: abi.json method not in contract (stale): ${m}()`);
      }
    }

    // ── Ratchet bookkeeping ───────────────────────────────────────────────────
    const newlyDrifted =
      deviations.missingMethodsInAbi.some((m) => !baseMissingMethods.has(m)) ||
      deviations.staleMethodsInAbi.some((m) => !baseStaleMethods.has(m)) ||
      deviations.missingErrorsInAbi.some((m) => !baseMissingErrors.has(m)) ||
      deviations.staleErrorsInAbi.some((m) => !baseStaleErrors.has(m)) ||
      deviations.mismatchedErrors.some((m) => !baseMismatchedErrors.has(m));

    if (newlyDrifted) {
      fail(
        `${key}: NEW ABI drift detected (not present in abi-baseline.json). ` +
          `Update packages/contract-abi/abi.json (+ src/*.ts) alongside the contract, ` +
          `or consciously refresh the baseline with --update-baseline.`
      );
    }

    const tightened =
      [...baseMissingMethods].some((m) => !deviations.missingMethodsInAbi.includes(m)) ||
      [...baseStaleMethods].some((m) => !deviations.staleMethodsInAbi.includes(m)) ||
      [...baseMissingErrors].some((m) => !deviations.missingErrorsInAbi.includes(m)) ||
      [...baseStaleErrors].some((m) => !deviations.staleErrorsInAbi.includes(m)) ||
      [...baseMismatchedErrors].some((m) => !deviations.mismatchedErrors.includes(m));

    if (tightened && !UPDATE_BASELINE) {
      warn(
        `${key}: baseline contains entries that no longer deviate — ` +
          `run with --update-baseline to tighten the ratchet.`
      );
    }
  }

  // ── Summary / actions ───────────────────────────────────────────────────────
  console.log('');

  if (UPDATE_BASELINE) {
    const payload = {
      _comment:
        'Known ABI deviations accepted by scripts/abi/check-abi-compatibility.mjs. ' +
        'New deviations fail CI; shrink this file as abi.json catches up.',
      ...actualDeviations,
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`Baseline written to ${BASELINE_PATH}`);
    console.log('Review the diff, then re-run the gate WITHOUT --update-baseline.');
    process.exit(0);
  }

  if (failed) {
    console.error('\nABI compatibility gate FAILED.');
    console.error(
      'Fix by updating packages/contract-abi/abi.json (+ src/*.ts) alongside the contract.'
    );
    process.exit(1);
  }

  console.log('ABI compatibility gate passed ✓');
  process.exit(0);
}

main();