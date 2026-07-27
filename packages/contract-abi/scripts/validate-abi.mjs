#!/usr/bin/env node
/**
 * validate-abi.mjs — Validates that abi.json is internally consistent.
 *
 * Checks:
 *   1. schemaVersion is present.
 *   2. Both "marketplace" and "launchpad" contracts are defined.
 *   3. Marketplace version matches MARKETPLACE_CONTRACT_VERSION in src/marketplace.ts.
 *   4. Every error code is a positive integer and there are no duplicates.
 *   5. Every event has at least one topic.
 *   6. Every method has "name", "args", and "returns" fields.
 *
 * Run: node scripts/validate-abi.mjs
 * Exit 0 on success, 1 on failure.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const abiPath = join(__dir, '..', 'abi.json');
const marketplaceSrcPath = join(__dir, '..', 'src', 'marketplace.ts');

let errors = 0;

function fail(msg) {
  console.error(`[FAIL] ${msg}`);
  errors++;
}

function ok(msg) {
  console.log(`[ OK ] ${msg}`);
}

// ── Load and parse abi.json ───────────────────────────────────────────────────

let abi;
try {
  abi = JSON.parse(readFileSync(abiPath, 'utf8'));
} catch (err) {
  console.error(`Cannot read abi.json: ${err.message}`);
  process.exit(1);
}

// ── 1. Schema version ─────────────────────────────────────────────────────────

if (abi.schemaVersion) {
  ok(`schemaVersion: ${abi.schemaVersion}`);
} else {
  fail('Missing schemaVersion in abi.json');
}

// ── 2. Both contracts present ─────────────────────────────────────────────────

for (const name of ['marketplace', 'launchpad']) {
  if (abi.contracts?.[name]) {
    ok(`Contract "${name}" present`);
  } else {
    fail(`Missing contract "${name}" in abi.json`);
  }
}

// ── 3. Marketplace version matches TypeScript source ─────────────────────────

const mktVersion = abi.contracts?.marketplace?.version;
let tsVersion = null;
try {
  const src = readFileSync(marketplaceSrcPath, 'utf8');
  const match = src.match(/MARKETPLACE_CONTRACT_VERSION\s*=\s*'([^']+)'/);
  if (match) tsVersion = match[1];
} catch {}

if (!mktVersion) {
  fail('Missing marketplace.version in abi.json');
} else if (!tsVersion) {
  fail('Cannot extract MARKETPLACE_CONTRACT_VERSION from src/marketplace.ts');
} else if (mktVersion !== tsVersion) {
  fail(`Version mismatch: abi.json has "${mktVersion}", marketplace.ts has "${tsVersion}"`);
} else {
  ok(`Marketplace version consistent: ${mktVersion}`);
}

// ── 4. Error codes — no duplicates, all positive integers ─────────────────────

const errors_obj = abi.contracts?.marketplace?.errors ?? {};
const codesSeen = new Set();
let errorCheckOk = true;

for (const [name, code] of Object.entries(errors_obj)) {
  if (typeof code !== 'number' || !Number.isInteger(code) || code <= 0) {
    fail(`Error "${name}" has invalid code: ${code}`);
    errorCheckOk = false;
  } else if (codesSeen.has(code)) {
    fail(`Duplicate error code ${code} (at least two errors share this value)`);
    errorCheckOk = false;
  } else {
    codesSeen.add(code);
  }
}
if (errorCheckOk) ok(`Error codes: ${codesSeen.size} unique codes, all positive integers`);

// ── 5. Events have topics ─────────────────────────────────────────────────────

for (const contractName of ['marketplace', 'launchpad']) {
  const evts = abi.contracts?.[contractName]?.events ?? {};
  let evtOk = true;
  for (const [evtName, evt] of Object.entries(evts)) {
    if (!evt.topic || evt.topic.length === 0) {
      fail(`Event "${contractName}/${evtName}" has no topics`);
      evtOk = false;
    }
  }
  if (evtOk) ok(`Events for "${contractName}": all have topics`);
}

// ── 6. Methods have required fields ──────────────────────────────────────────

for (const contractName of ['marketplace', 'launchpad']) {
  const methods = abi.contracts?.[contractName]?.methods ?? [];
  let methodOk = true;
  for (const method of methods) {
    if (!method.name || method.args === undefined || !method.returns) {
      fail(`Method in "${contractName}" missing name/args/returns: ${JSON.stringify(method)}`);
      methodOk = false;
    }
  }
  if (methodOk) ok(`Methods for "${contractName}": ${methods.length} methods, all valid`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

if (errors === 0) {
  console.log('\nABI validation passed ✓');
  process.exit(0);
} else {
  console.error(`\nABI validation FAILED with ${errors} error(s)`);
  process.exit(1);
}
