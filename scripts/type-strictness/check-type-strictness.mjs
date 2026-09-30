#!/usr/bin/env node
/**
 * check-type-strictness.mjs — TypeScript strictness ratchet.
 *
 * All packages already compile with `strict: true`. This gate prevents
 * silent erosion of that strictness: it counts escape hatches (`any`,
 * `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, disabled lint rules)
 * across first-party sources and FAILS when the count grows beyond the
 * committed baseline in `baseline.json`.
 *
 * Ratchet process (see docs/COVERAGE_POLICY.md for the analogous test
 * coverage ratchet):
 *   1. Fix some escapes → counts drop → optionally lower the baseline
 *      in the same PR (`node scripts/type-strictness/check-type-strictness.mjs --update-baseline`).
 *   2. New code introducing NEW escapes pushes the count above baseline
 *      → CI fails → fix the types or justify + raise the baseline in review.
 *
 * Usage:
 *   node scripts/type-strictness/check-type-strictness.mjs                  # check (CI)
 *   node scripts/type-strictness/check-type-strictness.mjs --update-baseline # refresh baseline
 *   node scripts/type-strictness/check-type-strictness.mjs --verbose        # list every hit
 *
 * Exit codes: 0 = within baseline, 1 = regression detected, 2 = usage error.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname, normalize } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(__dir, 'baseline.json');
const REPO_ROOT = join(__dir, '..', '..');

// ── Scan targets ──────────────────────────────────────────────────────────────
// First-party source directories, one entry per package.
const SCAN_ROOTS = [
  { label: 'frontend', root: 'frontend/elcarehub-app/src' },
  { label: 'indexer', root: 'indexer/src' },
  { label: 'contract-abi', root: 'packages/contract-abi/src' },
];

const EXTENSIONS = new Set(['.ts', '.tsx']);

// Directories never scanned anywhere under a scan root.
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '__tests__',
  '__mocks__',
  'snapshots',
]);

// A file is skipped if its path contains any of these segments.
const EXCLUDED_FILE_PARTS = ['.test.', '.spec.', '.stories.', '.d.ts'];

// ── Escape-hatch rules ────────────────────────────────────────────────────────
// Each rule: name → regex. Counts are per occurrence.
const RULES = {
  'ts-ignore': /@ts-ignore/g,
  'ts-nocheck': /@ts-nocheck/g,
  'ts-expect-error': /@ts-expect-error/g,
  // `as any` casts
  'as-any': /\bas\s+any\b/g,
  // Explicit `any` annotations: `: any`, `: any[]`, `Array<any>`, `Promise<any>`,
  // `<any, ...>` generics (e.g. useState<any>). Word-boundary guarded so
  // identifiers like "company" or "AnyComponent" don't match.
  'explicit-any': /(?<![\w.])(?:any)(?![\w])(?=\s*[\])>,;=]|any\[\])/g,
  // Disabling the explicit-any lint rule itself
  'eslint-disable-explicit-any': /@typescript-eslint\/no-explicit-any/g,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing directory — package may not exist yet
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function shouldSkip(relPath) {
  const norm = normalize(relPath).toLowerCase();
  return EXCLUDED_FILE_PARTS.some((part) => norm.includes(part));
}

function countHits(content) {
  const hits = [];
  const lines = content.split('\n');
  for (const [rule, regex] of Object.entries(RULES)) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(content)) !== null) {
      const lineNo = content.slice(0, m.index).split('\n').length;
      hits.push({ rule, line: lineNo, text: lines[lineNo - 1]?.trim().slice(0, 120) ?? '' });
    }
  }
  return hits;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const updateBaseline = args.includes('--update-baseline');
const verbose = args.includes('--verbose');
if (args.some((a) => !a.startsWith('--'))) {
  console.error('Usage: node scripts/type-strictness/check-type-strictness.mjs [--update-baseline] [--verbose]');
  process.exit(2);
}

let baseline = { updated: null, totals: {} };
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
} catch {
  // First run — baseline will be created with --update-baseline.
}

const counts = {};
const allHits = [];

for (const { label, root } of SCAN_ROOTS) {
  const absRoot = join(REPO_ROOT, root);
  for (const filePath of walk(absRoot)) {
    if (!EXTENSIONS.has(filePath.slice(filePath.lastIndexOf('.')))) continue;
    const rel = filePath.slice(REPO_ROOT.length + 1);
    if (shouldSkip(rel)) continue;
    const content = readFileSync(filePath, 'utf8');
    for (const hit of countHits(content)) {
      allHits.push({ pkg: label, file: rel, ...hit });
      counts[hit.rule] = (counts[hit.rule] ?? 0) + 1;
    }
  }
}

for (const rule of Object.keys(RULES)) {
  counts[rule] = counts[rule] ?? 0;
}

if (updateBaseline) {
  const payload = { updated: new Date().toISOString().slice(0, 10), totals: counts };
  writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n');
  console.log(`Baseline updated at ${BASELINE_PATH}`);
  console.log(JSON.stringify(counts, null, 2));
  process.exit(0);
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  TypeScript strictness ratchet');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

let regressions = 0;
for (const [rule, current] of Object.entries(counts)) {
  const allowed = baseline.totals?.[rule];
  if (allowed === undefined) {
    console.log(`  NEW   ${rule.padEnd(28)} current: ${String(current).padStart(4)}  baseline: (unset — run --update-baseline to adopt)`);
    if (current > 0) regressions += current;
    continue;
  }
  const delta = current - allowed;
  const mark = delta > 0 ? 'FAIL' : delta < 0 ? 'IMPROVED' : 'ok  ';
  console.log(
    `  ${mark}  ${rule.padEnd(24)} current: ${String(current).padStart(4)}  baseline: ${String(allowed).padStart(4)}` +
      (delta < 0 ? `  (can lower baseline by ${-delta})` : '')
  );
  if (delta > 0) regressions += delta;
}

if (verbose) {
  console.log('\nAll occurrences:');
  for (const h of allHits.sort((a, b) => a.file.localeCompare(b.file))) {
    console.log(`  [${h.rule}] ${h.pkg}:${h.file}:${h.line}  ${h.text}`);
  }
}

if (regressions > 0) {
  console.error(`\nRESULT: FAIL — ${regressions} new type-system escape(s) above baseline.`);
  console.error('Fix the types, or (with reviewer approval) re-baseline:');
  console.error('  node scripts/type-strictness/check-type-strictness.mjs --update-baseline');
  process.exit(1);
}

console.log('\nRESULT: PASS — no new type-system escapes. Strictness held.');
process.exit(0);