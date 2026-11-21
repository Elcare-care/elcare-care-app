#!/usr/bin/env node
/**
 * check-advisory-exceptions.mjs
 *
 * Validates docs/advisory-exceptions.md against the time-bound exception
 * policy and reconciles it with .cargo/audit.toml. Read-only: no network,
 * no writes, no secrets — it parses advisory IDs, package names, owners, and
 * dates only.
 *
 * Checks:
 *   1. Every open exception row has: id, package, scope, severity, owner,
 *      opened, expiry, status, and the dates are YYYY-MM-DD.
 *   2. No Open exception is past its expiry (time-bound, hard gate).
 *   3. Expiry honours the severity tier (warns if a window exceeds the tier).
 *   4. Every id in .cargo/audit.toml [advisories].ignore has a matching
 *      cargo-scoped register row (no undocumented/silent suppressions).
 *
 * Exit 0 = pass, 1 = fail.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const REGISTER = join(REPO_ROOT, 'docs', 'advisory-exceptions.md');
const AUDIT_TOML = join(REPO_ROOT, '.cargo', 'audit.toml');

const NOW = new Date();
const toDate = (s) => new Date(s + 'T00:00:00Z');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^(RUSTSEC-\d{4}-\d{3,4}|GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4,}|npm:[A-Za-z0-9][\w.\-/]*)$/i;

const errors = [];
const warnings = [];
const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

// --- read register -------------------------------------------------------
let md = '';
if (existsSync(REGISTER)) md = readFileSync(REGISTER, 'utf8');
else fail(`register not found: ${REGISTER}`);

const lines = md ? md.split(/\r?\n/) : [];

// Find the register table header: first '|' line containing the required
// column names. Ignore lines inside fenced code blocks.
let headerIdx = -1;
{
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (/^\|\s*Advisory ID/.test(lines[i]) && /Expiry/.test(lines[i]) && /Status/.test(lines[i])) {
      headerIdx = i; break;
    }
  }
}

const rowCells = (line) => line.split('|').slice(1, -1).map((s) => s.trim());
const headers = headerIdx >= 0 ? rowCells(lines[headerIdx]) : [];
const col = (name) => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());

const need = ['advisory id', 'package', 'scope', 'severity', 'owner', 'opened', 'expiry', 'status'];
const cols = {};
for (const n of need) {
  cols[n] = col(n);
  if (cols[n] === -1) fail(`register missing required column "${n}"`);
}

// Collect rows from the contiguous table block only (header, separator, then
// consecutive '|' lines). Stop at the first non-'|' line so later tables in
// the document are not misread as exception rows.
const rows = [];
if (headerIdx >= 0 && errors.length === 0) {
  let i = headerIdx + 1;
  while (i < lines.length && /^\|\s*[-:\s|]+\s*$/.test(lines[i])) i++; // separator(s)
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) break; // end of table block
    if (/^\|\s*[-:\s|]+\s*$/.test(line)) continue; // stray separator
    const cells = rowCells(line);
    const id = cells[cols['advisory id']];
    if (!id || id.startsWith('<!--')) continue;
    if (!ID_RE.test(id)) { fail(`line ${i + 1}: invalid advisory id "${id}"`); continue; }
    rows.push({
      line: i + 1,
      id,
      pkg: cells[cols['package']] || '',
      scope: (cells[cols['scope']] || '').toLowerCase(),
      sev: (cells[cols['severity']] || '').toLowerCase(),
      owner: cells[cols['owner']] || '',
      opened: cells[cols['opened']] || '',
      expiry: cells[cols['expiry']] || '',
      status: (cells[cols['status']] || '').toLowerCase(),
    });
  }
}

if (rows.length === 0 && errors.length === 0) {
  warn('register has no exception rows (template-only is allowed but review)');
}

// --- tier policy (days) --------------------------------------------------
function tierDays(sev) {
  if (/critical|high/.test(sev)) return 90;
  if (/medium/.test(sev)) return 180;
  return 365; // low / unmaintained / informational
}

for (const r of rows) {
  if (!r.pkg) fail(`[${r.id}] missing package`);
  if (!r.scope) fail(`[${r.id}] missing scope (cargo | npm-frontend | npm-indexer)`);
  if (!r.owner || r.owner === '—' || r.owner === '-') fail(`[${r.id}] missing owner`);
  if (!DATE_RE.test(r.opened)) fail(`[${r.id}] opened date invalid: "${r.opened}"`);
  if (!DATE_RE.test(r.expiry)) fail(`[${r.id}] expiry date invalid: "${r.expiry}"`);
  if (!['open', 'remediated', 'retired'].includes(r.status)) {
    fail(`[${r.id}] status invalid: "${r.status}" (use Open | Remediated | Retired)`);
  }
  if (DATE_RE.test(r.opened) && DATE_RE.test(r.expiry)) {
    const span = Math.round((toDate(r.expiry) - toDate(r.opened)) / 86_400_000);
    if (span <= 0) fail(`[${r.id}] expiry is not after opened (${r.opened} → ${r.expiry})`);
    const allowed = tierDays(r.sev);
    if (span > allowed) warn(`[${r.id}] ${r.sev || 'unclassified'} exception granted ${span} days (tier max ${allowed})`);
    if (r.status === 'open' && toDate(r.expiry) < NOW) {
      fail(`[${r.id}] EXPIRED on ${r.expiry} — remediate, re-document with a new expiry, or set Status to Remediated/Retired`);
    }
  }
}

// --- reconcile with .cargo/audit.toml -----------------------------------
let ignoredIds = [];
if (existsSync(AUDIT_TOML)) {
  const audit = readFileSync(AUDIT_TOML, 'utf8');
  const block = audit.match(/ignore\s*=\s*\[([\s\S]*?)\]/);
  if (block) {
    ignoredIds = block[1].match(/RUSTSEC-\d{4}-\d{3,4}|GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4,}/gi) || [];
  }
} else {
  fail('.cargo/audit.toml not found');
}

const registeredCargoIds = new Set(rows.filter((r) => r.scope.includes('cargo')).map((r) => r.id));
for (const id of ignoredIds) {
  if (!registeredCargoIds.has(id)) {
    fail(`.cargo/audit.toml ignores "${id}" but no cargo-scoped exception row exists in the register`);
  }
}

// --- report --------------------------------------------------------------
if (warnings.length) {
  console.log('warnings:');
  for (const w of warnings) console.log('  ⚠ ' + w);
}
if (errors.length) {
  console.error('\nerrors:');
  for (const e of errors) console.error('  ✗ ' + e);
  console.error(`\n${errors.length} error(s) — see docs/advisory-exceptions.md.`);
  process.exit(1);
}
console.log(
  `✓ advisory exceptions register OK (${rows.length} row(s), ${ignoredIds.length} cargo ignore(s) reconciled` +
    (warnings.length ? `, ${warnings.length} warning(s)` : '') + ').'
);
process.exit(0);
