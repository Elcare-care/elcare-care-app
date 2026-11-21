#!/usr/bin/env node
/**
 * check-contract-network-consistency.mjs
 *
 * Read-only cross-file consistency check for Stellar contract IDs and network
 * settings across the committed templates and the deployment scripts:
 *   - frontend/elcarehub-app/.env.example   (NEXT_PUBLIC_* prefixed)
 *   - indexer/.env.example
 *   - packages/config/.env.example
 *   - scripts/deploy/deploy_contract.sh, deploy_launchpad.sh (hardcoded
 *     --network-passphrase, which must match the network declared in the
 *     templates — the classic "frontend says mainnet, deploy script still
 *     says testnet" drift this check exists to catch)
 *
 * Never loads real environment, never writes, contains no secrets — it parses
 * only committed placeholder templates + the deploy shell scripts. Empty
 * values mean "not yet deployed / derived"; the check only flags *conflicting*
 * non-empty values.
 *
 * Exit 0 = consistent, 1 = mismatch found.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const ENV_FILES = {
  frontend: join(REPO_ROOT, 'frontend', 'elcarehub-app', '.env.example'),
  indexer: join(REPO_ROOT, 'indexer', '.env.example'),
  config: join(REPO_ROOT, 'packages', 'config', '.env.example'),
};

const DEPLOY_SCRIPTS = [
  join(REPO_ROOT, 'scripts', 'deploy', 'deploy_contract.sh'),
  join(REPO_ROOT, 'scripts', 'deploy', 'deploy_launchpad.sh'),
];

// field -> per-file key name (null = not applicable in that file)
const FIELDS = {
  STELLAR_NETWORK: { frontend: 'NEXT_PUBLIC_STELLAR_NETWORK', indexer: 'STELLAR_NETWORK', config: 'STELLAR_NETWORK' },
  STELLAR_NETWORK_PASSPHRASE: { frontend: 'NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE', indexer: 'STELLAR_NETWORK_PASSPHRASE', config: 'STELLAR_NETWORK_PASSPHRASE' },
  STELLAR_RPC_URL: { frontend: 'NEXT_PUBLIC_STELLAR_RPC_URL', indexer: 'STELLAR_RPC_URL', config: 'STELLAR_RPC_URL' },
  STELLAR_HORIZON_URL: { frontend: 'NEXT_PUBLIC_STELLAR_HORIZON_URL', indexer: 'STELLAR_HORIZON_URL', config: 'STELLAR_HORIZON_URL' },
  MARKETPLACE_CONTRACT_ID: { frontend: 'NEXT_PUBLIC_CONTRACT_ID', indexer: 'MARKETPLACE_CONTRACT_ID', config: 'MARKETPLACE_CONTRACT_ID' },
  LAUNCHPAD_CONTRACT_ID: { frontend: 'NEXT_PUBLIC_LAUNCHPAD_CONTRACT_ID', indexer: 'LAUNCHPAD_CONTRACT_ID', config: 'LAUNCHPAD_CONTRACT_ID' },
  INDEXER_URL: { frontend: 'NEXT_PUBLIC_INDEXER_URL', indexer: null, config: 'INDEXER_URL' },
};

const NETWORK_PASSPHRASE = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
};

const errors = [];
const warnings = [];
const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

function parseEnvFile(path) {
  if (!existsSync(path)) return null;
  const map = {}; // key -> Set<distinct values>
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    (map[m[1]] ||= new Set()).add(val);
  }
  return map;
}

const parsed = {};
for (const [name, path] of Object.entries(ENV_FILES)) {
  parsed[name] = parseEnvFile(path);
  if (parsed[name] === null) fail(`missing template: ${path}`);
}

// Check A: a key with conflicting values within the same file
for (const [file, map] of Object.entries(parsed)) {
  if (!map) continue;
  for (const [key, set] of Object.entries(map)) {
    if (set.size > 1) fail(`${file}: ${key} defined with conflicting values (${[...set].map((v) => JSON.stringify(v)).join(', ')})`);
  }
}

function valueOf(file, key) {
  const map = parsed[file];
  if (!map || !key) return undefined;
  const set = map[key];
  if (!set || set.size === 0) return undefined;
  return [...set][0];
}

// Check B: cross-file consistency (non-empty values must agree)
for (const [field, keys] of Object.entries(FIELDS)) {
  const seen = {}; // value -> [locations]
  for (const [file, key] of Object.entries(keys)) {
    if (!key) continue;
    const v = valueOf(file, key);
    if (v === undefined || v === '') continue;
    (seen[v] ||= []).push(`${file}:${key}`);
  }
  const distinct = Object.keys(seen);
  if (distinct.length > 1) {
    fail(`${field}: conflicting values across templates → ${distinct.map((v) => `${JSON.stringify(v)} (in ${seen[v].join(', ')})`).join('  |  ')}`);
  }
  if (field.endsWith('_CONTRACT_ID')) {
    for (const v of distinct) {
      if (v.length !== 56 || !v.startsWith('C')) {
        fail(`${field}: ${JSON.stringify(v)} is not a valid contract address (56 chars starting with 'C')`);
      }
    }
  }
}

// Check C: passphrase <-> network coherence (where both are explicitly set)
for (const file of Object.keys(ENV_FILES)) {
  const net = valueOf(file, FIELDS.STELLAR_NETWORK[file]);
  const pass = valueOf(file, FIELDS.STELLAR_NETWORK_PASSPHRASE[file]);
  if (net && pass) {
    const expected = NETWORK_PASSPHRASE[net.toLowerCase()];
    if (!expected) fail(`${file}: STELLAR_NETWORK=${JSON.stringify(net)} is not 'testnet' or 'mainnet'`);
    else if (pass !== expected) fail(`${file}: passphrase does not match STELLAR_NETWORK=${net} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(pass)})`);
  }
}

// Check D: deploy scripts' hardcoded --network-passphrase must agree with the
// network declared in the templates (catches frontend/config flipped to
// mainnet while the deploy script still hardcodes the testnet passphrase).
const templateNetworks = Object.keys(ENV_FILES)
  .map((f) => valueOf(f, FIELDS.STELLAR_NETWORK[f]))
  .filter(Boolean);
const templatePassphrases = new Set(templateNetworks.map((n) => NETWORK_PASSPHRASE[n.toLowerCase()]).filter(Boolean));

for (const script of DEPLOY_SCRIPTS) {
  if (!existsSync(script)) { warn(`deploy script not found: ${script.replace(/\\/g, '/')}`); continue; }
  const src = readFileSync(script, 'utf8');
  const matches = [...src.matchAll(/--network-passphrase\s+["']([^"']+)["']/g)];
  if (matches.length === 0) { warn(`${script.replace(/\\/g, '/').split('/').slice(-3).join('/')}: no --network-passphrase found (verify network handling)`); continue; }
  for (const mm of matches) {
    const pp = mm[1];
    if (templatePassphrases.size > 0 && !templatePassphrases.has(pp)) {
      const rel = script.replace(/\\/g, '/').split('/').slice(-3).join('/');
      fail(`${rel}: --network-passphrase ${JSON.stringify(pp)} does not match the network declared in the .env.example templates (${[...templatePassphrases].map((s) => JSON.stringify(s)).join(' or ')})`);
    }
  }
}

// report
if (warnings.length) {
  console.log('warnings:');
  for (const w of warnings) console.log('  ⚠ ' + w);
}
if (errors.length) {
  console.error('\nerrors:');
  for (const e of errors) console.error('  ✗ ' + e);
  console.error(`\n${errors.length} error(s) — contract IDs / network settings are inconsistent across frontend, indexer, config, and/or deploy scripts.`);
  process.exit(1);
}
console.log(`✓ contract IDs & network settings consistent across frontend/indexer/config templates and deploy scripts${warnings.length ? ` (${warnings.length} warning(s))` : ''}.`);
process.exit(0);
