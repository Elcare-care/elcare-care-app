#!/usr/bin/env node
/**
 * check-event-schemas.mjs
 *
 * CI parity gate between the contract-side event structs and the indexer's
 * schema registry (Issue #846).
 *
 * Rule: every struct in `contracts/soroban-marketplace/src/events.rs` that
 * carries a `schema_version: u32` field must have a schema entry in
 * `indexer/src/event-schemas.ts` whose `schema_version` field is marked
 * `optional: true`. Marking it optional is what lets one decoder handle both
 * the historical (implicit version 0, field absent) and the post-upgrade
 * (field present) shapes of the same event.
 *
 * The check reads source text deliberately: the contract is Rust and the
 * registry is TypeScript, so there is no shared type to lean on. It fails with
 * the exact struct to fix and exits non-zero, so CI gates on it
 * (`event-schema-lint` job).
 *
 * Run locally: node scripts/check-event-schemas.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const EVENTS_RS = resolve(here, '../contracts/soroban-marketplace/src/events.rs');
const SCHEMAS_TS = resolve(here, '../indexer/src/event-schemas.ts');

/** Extract `pub struct Name { ... }` blocks with brace-aware scanning. */
function structBlocks(source) {
  const out = [];
  const re = /pub struct\s+(\w+)\s*\{/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    out.push({ name: m[1], body: source.slice(re.lastIndex, i) });
    re.lastIndex = i;
  }
  return out;
}

/** `pub const NAME: &str = "value";` declarations in the contract module. */
function topicConstants(source) {
  const map = new Map();
  const re = /pub const\s+([A-Z][A-Z0-9_]*)\s*:\s*&str\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(source)) !== null) map.set(m[1], m[2]);
  return map;
}

/** Structs carrying `schema_version: u32` plus the symbol their `impl` publishes under. */
function versionedEvents(source, constants) {
  return structBlocks(source)
    .filter(({ body }) => /\bschema_version\s*:\s*u32/.test(body))
    .map(({ name }) => {
      const implRe = new RegExp(`impl\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm');
      const impl = implRe.exec(source)?.[1] ?? '';
      const symbol =
        /soroban_sdk::Symbol::new\(\s*env\s*,\s*([A-Z][A-Z0-9_]*)\s*\)/.exec(impl)?.[1] ?? null;
      return { struct: name, symbol, topic: symbol ? constants.get(symbol) ?? null : null };
    });
}

/** Registry map literal: `['LISTING_CREATED', LISTING_CREATED_SCHEMA]`. */
function registryEntries(schemasSource) {
  const map = new Map();
  const re = /\[\s*'([A-Z][A-Z0-9_]*)'\s*,\s*([A-Za-z0-9_]+)\s*\]/g;
  let m;
  while ((m = re.exec(schemasSource)) !== null) map.set(m[1], m[2]);
  return map;
}

/** The object literal body of `const <name>: ContractEventSchema = {...}`. */
function schemaBody(schemasSource, constName) {
  const re = new RegExp(
    `(?:export\\s+)?const\\s+${constName}\\s*:\\s*ContractEventSchema\\s*=\\s*\\{`,
  );
  const m = re.exec(schemasSource);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  while (i < schemasSource.length && depth > 0) {
    const ch = schemasSource[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return schemasSource.slice(m.index + m[0].length, i);
}

function main() {
  const eventsSource = readFileSync(EVENTS_RS, 'utf8');
  const schemasSource = readFileSync(SCHEMAS_TS, 'utf8');

  const constants = topicConstants(eventsSource);
  const versioned = versionedEvents(eventsSource, constants);
  const registry = registryEntries(schemasSource);
  const problems = [];

  if (versioned.length === 0) {
    problems.push(
      `No struct with a \`schema_version: u32\` field found in ${EVENTS_RS} — ` +
        'the versioning policy defines at least one versioned event, so the parse is broken.',
    );
  }

  for (const { struct, symbol, topic } of versioned) {
    const label = symbol ? `${symbol} (${struct})` : struct;

    if (!symbol || !topic) {
      problems.push(
        `${label}: cannot determine the published topic symbol. Its \`impl\` must call ` +
          '`soroban_sdk::Symbol::new(env, <CONST>)`.',
      );
      continue;
    }

    const schemaConst = registry.get(symbol);
    if (!schemaConst) {
      problems.push(
        `${label}: no entry for '${symbol}' in SCHEMA_REGISTRY (indexer/src/event-schemas.ts). ` +
          'Without one the indexer cannot decode this event at all.',
      );
      continue;
    }

    const body = schemaBody(schemasSource, schemaConst);
    if (body === null) {
      problems.push(
        `${label}: the registry maps '${symbol}' to ${schemaConst}, but that schema is not defined.`,
      );
      continue;
    }

    const field = /\{\s*name:\s*'schema_version'\s*,[^}]*\}/.exec(body)?.[0];
    if (!field) {
      problems.push(
        `${label}: schema ${schemaConst} has no 'schema_version' field. Add ` +
          "`{ name: 'schema_version', type: 'number', optional: true }` so historical " +
          '(version 0, field absent) events keep decoding.',
      );
      continue;
    }
    if (!/optional\s*:\s*true/.test(field)) {
      problems.push(
        `${label}: schema ${schemaConst} declares 'schema_version' without \`optional: true\`. ` +
          'Historical events emitted before the field existed would fail to decode.',
      );
    }
  }

  if (problems.length > 0) {
    console.error(`event-schema-lint: ${problems.length} problem(s) found\n`);
    for (const p of problems) console.error(`  x ${p}`);
    console.error(
      '\nEvery struct in events.rs carrying `schema_version: u32` needs a schema entry whose ' +
        '`schema_version` field is optional — see the versioning policy at the top of events.rs.',
    );
    process.exit(1);
  }

  console.log(
    `event-schema-lint: ok — ${versioned.length} versioned event struct(s) verified against ` +
      'indexer/src/event-schemas.ts',
  );
  for (const { symbol, struct } of versioned) console.log(`  ok ${symbol} (${struct})`);
}

main();
