#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/lint-event-schemas.mjs
//
// CI gate: Event Schema Coverage Lint (Issue #488)
//
// Enforces the versioning policy from contracts/soroban-marketplace/src/events.rs:
//
//   Every Rust event struct that carries a `schema_version: u32` field MUST
//   have a corresponding entry in the indexer schema registry
//   (indexer/src/event-schemas.ts) that:
//     1. Exists in SUPPORTED_SCHEMA_VERSIONS (so future-version events are
//        version-gated rather than silently accepted or generically failed).
//     2. Has a `schema_version` field entry in its ContractEventSchema.data
//        array with `optional: true` (so pre-upgrade events missing the field
//        continue to decode without error).
//
// The script parses both files with simple, comment-stripping regex patterns
// to avoid needing a full Rust/TS parser in CI.
//
// Exit codes:
//   0 — all checks passed
//   1 — one or more violations found (details printed to stdout)
//
// Usage:
//   node scripts/lint-event-schemas.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// ── File paths ────────────────────────────────────────────────────────────────

const EVENTS_RS   = join(REPO_ROOT, 'contracts', 'soroban-marketplace', 'src', 'events.rs');
const SCHEMAS_TS  = join(REPO_ROOT, 'indexer', 'src', 'event-schemas.ts');

// ── Step 1: Extract versioned Rust struct names from events.rs ────────────────
//
// A "versioned struct" is any #[contracttype] struct that contains a field
// named `schema_version`.  We extract struct names by finding every `pub
// struct Foo {` block that has a `pub schema_version:` field inside it.
//
// The parse is intentionally line-by-line rather than a full AST parse because:
//   • The Rust file is under our control and follows consistent formatting.
//   • Avoiding a Rust parser dependency keeps CI fast and dependency-free.
//   • A false-positive (struct without schema_version detected as having one)
//     is impossible because we require the field to appear between the struct's
//     opening and closing braces.

function extractVersionedStructNames(src) {
  const lines = src.split('\n');
  const structs = [];
  let currentStruct = null;
  let braceDepth = 0;
  let hasSchemaVersion = false;

  for (const line of lines) {
    // Strip inline comments for matching purposes
    const stripped = line.replace(/\/\/.*$/, '').trim();

    // Detect struct opening
    const structMatch = stripped.match(/^pub\s+struct\s+(\w+)/);
    if (structMatch && stripped.endsWith('{')) {
      currentStruct = structMatch[1];
      braceDepth = 1;
      hasSchemaVersion = false;
      continue;
    }

    if (currentStruct) {
      braceDepth += (stripped.match(/\{/g) || []).length;
      braceDepth -= (stripped.match(/\}/g) || []).length;

      if (stripped.includes('pub schema_version:') || stripped.includes('pub schema_version :')) {
        hasSchemaVersion = true;
      }

      if (braceDepth <= 0) {
        if (hasSchemaVersion) {
          structs.push(currentStruct);
        }
        currentStruct = null;
        braceDepth = 0;
        hasSchemaVersion = false;
      }
    }
  }

  return structs;
}

// ── Step 2: Map Rust struct name → indexer eventType ─────────────────────────
//
// The mapping is maintained here as the authoritative cross-reference between
// the Rust struct name and the indexer's SCREAMING_SNAKE_CASE eventType key.
// When a new versioned event is added to events.rs, both this map AND the
// schema registry must be updated — the lint script enforces the latter.
//
// Format: RustStructName → SCHEMA_REGISTRY_KEY

const STRUCT_TO_EVENT_TYPE = {
  ListingCreatedEvent:       'LISTING_CREATED',
  ArtworkSoldEvent:          'ARTWORK_SOLD',
  AuctionCreatedEvent:       'AUCTION_CREATED',
  AuctionFinalizedEvent:     'AUCTION_RESOLVED',
  OfferMadeEvent:            'OFFER_MADE',
  OfferAcceptedEvent:        'OFFER_ACCEPTED',
  ProtocolFeeCollectedEvent: 'PROTOCOL_FEE_COLLECTED',
  RoyaltySettlementEvent:    'ROYALTY_SETTLEMENT',
  AuctionBidRefundedEvent:   'AUCTION_BID_REFUNDED',
  AuctionAdminCancelledEvent:'AUCTION_ADMIN_CANCELLED',
  AuctionCancelledEvent:     'AUCTION_CANCELLED',
  FeeAttributionEvent:       'FEE_ATTRIBUTION',
};

// ── Step 3: Parse SUPPORTED_SCHEMA_VERSIONS from event-schemas.ts ─────────────

function extractSupportedVersionKeys(src) {
  // Find the SUPPORTED_SCHEMA_VERSIONS object body
  const match = src.match(/SUPPORTED_SCHEMA_VERSIONS[^=]*=\s*\{([^}]+)\}/s);
  if (!match) return new Set();
  const body = match[1];
  const keys = new Set();
  for (const m of body.matchAll(/['"]?([A-Z_0-9]+)['"]?\s*:/g)) {
    keys.add(m[1]);
  }
  return keys;
}

// ── Step 4: Parse SCHEMA_REGISTRY entries and check schema_version field ──────
//
// For each registered event type, we check that its ContractEventSchema has
// a field entry with name 'schema_version' and optional: true.
// We do this by locating the const <TYPE>_SCHEMA block and checking it contains
// both 'schema_version' and 'optional: true' in the same proximity.

function extractSchemaRegistryKeys(src) {
  // Match all ['KEY', SOMETHING] entries in the SCHEMA_REGISTRY Map
  const match = src.match(/SCHEMA_REGISTRY[^=]*=\s*new Map\(\[([^\]]*\])\s*\)/s);
  if (!match) return new Set();
  const body = match[1];
  const keys = new Set();
  for (const m of body.matchAll(/\[\s*['"]([A-Z_0-9]+)['"]/g)) {
    keys.add(m[1]);
  }
  return keys;
}

function schemaHasOptionalSchemaVersionField(src, eventType) {
  // Locate the const block for this schema, e.g. LISTING_CREATED_SCHEMA
  // Then check that within its data array there is a schema_version field
  // entry with optional: true.
  const schemaConstName = eventType + '_SCHEMA';
  // Find the schema constant declaration
  const schemaStart = src.indexOf(`const ${schemaConstName}`);
  if (schemaStart === -1) return false;

  // Find the data array by scanning forward from schemaStart
  const dataStart = src.indexOf('data:', schemaStart);
  if (dataStart === -1) return false;

  // Find the closing bracket of the data array — we count brackets
  let depth = 0;
  let dataEnd = -1;
  for (let i = dataStart; i < src.length; i++) {
    if (src[i] === '[') depth++;
    if (src[i] === ']') {
      depth--;
      if (depth === 0) {
        dataEnd = i;
        break;
      }
    }
  }
  if (dataEnd === -1) return false;

  const dataBody = src.slice(dataStart, dataEnd + 1);

  // Check the data body contains a field entry for schema_version with
  // optional: true.  We look for the pattern:
  //   { name: 'schema_version', ... optional: true }  (in any order)
  // by finding the { ... } block that contains 'schema_version' and
  // checking it also contains 'optional'.
  const fieldBlocks = [];
  let blockStart = -1;
  let bd = 0;
  for (let i = 0; i < dataBody.length; i++) {
    if (dataBody[i] === '{') {
      if (bd === 0) blockStart = i;
      bd++;
    } else if (dataBody[i] === '}') {
      bd--;
      if (bd === 0 && blockStart !== -1) {
        fieldBlocks.push(dataBody.slice(blockStart, i + 1));
        blockStart = -1;
      }
    }
  }

  for (const block of fieldBlocks) {
    const hasName = /['"]?name['"]?\s*:\s*['"]schema_version['"]/.test(block);
    const hasOptional = /['"]?optional['"]?\s*:\s*true/.test(block);
    if (hasName && hasOptional) return true;
  }
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const eventsSrc  = readFileSync(EVENTS_RS, 'utf8');
const schemasSrc = readFileSync(SCHEMAS_TS, 'utf8');

const versionedStructs   = extractVersionedStructNames(eventsSrc);
const supportedVersions  = extractSupportedVersionKeys(schemasSrc);
const registryKeys       = extractSchemaRegistryKeys(schemasSrc);

let violations = 0;

console.log('');
console.log('Event Schema Coverage Lint');
console.log('══════════════════════════════════════════════════════════════');
console.log(`Found ${versionedStructs.length} versioned struct(s) in events.rs:`);
for (const s of versionedStructs) console.log(`  • ${s}`);
console.log('');

for (const structName of versionedStructs) {
  const eventType = STRUCT_TO_EVENT_TYPE[structName];

  if (!eventType) {
    console.error(
      `✗ [UNMAPPED] ${structName} — add an entry to STRUCT_TO_EVENT_TYPE in ` +
      `scripts/lint-event-schemas.mjs and a corresponding schema in event-schemas.ts`
    );
    violations++;
    continue;
  }

  let ok = true;

  // Check 1: SUPPORTED_SCHEMA_VERSIONS entry
  if (!supportedVersions.has(eventType)) {
    console.error(
      `✗ [MISSING SUPPORTED_VERSION] ${structName} → ${eventType}: ` +
      `add "${eventType}" to SUPPORTED_SCHEMA_VERSIONS in indexer/src/event-schemas.ts`
    );
    ok = false;
    violations++;
  }

  // Check 2: SCHEMA_REGISTRY entry
  if (!registryKeys.has(eventType)) {
    console.error(
      `✗ [MISSING SCHEMA_REGISTRY] ${structName} → ${eventType}: ` +
      `register the schema in SCHEMA_REGISTRY in indexer/src/event-schemas.ts`
    );
    ok = false;
    violations++;
  }

  // Check 3: schema_version field is optional in the schema data array
  if (registryKeys.has(eventType) && !schemaHasOptionalSchemaVersionField(schemasSrc, eventType)) {
    console.error(
      `✗ [MISSING OPTIONAL schema_version] ${structName} → ${eventType}: ` +
      `add { name: 'schema_version', type: 'number', optional: true } to ` +
      `${eventType}_SCHEMA.data in indexer/src/event-schemas.ts`
    );
    ok = false;
    violations++;
  }

  if (ok) {
    console.log(`✓ ${structName} → ${eventType}`);
  }
}

console.log('');
if (violations === 0) {
  console.log(`All ${versionedStructs.length} versioned event struct(s) correctly registered. ✓`);
  process.exit(0);
} else {
  console.error(
    `Found ${violations} violation(s). ` +
    `See docs/guides/event-parsing.md §5 for the versioning policy.`
  );
  process.exit(1);
}
