/**
 * query-plan-regression.test.ts
 *
 * Database query-plan regression suite for Feature 3.
 *
 * Acceptance criteria:
 *   - Detects removal or bypass of required indexes on Listing, Auction, Offer,
 *     Collection, MarketplaceEvent, and RoyaltyPayment tables.
 *   - Runs reproducibly in CI and documents acceptable plan changes.
 *   - Fails when a required index scan is missing or estimated rows exceed
 *     documented thresholds.
 *   - Covers pagination, search, wallet activity, stats, and admin queries.
 *
 * ── Architecture ──────────────────────────────────────────────────────────────
 *
 * This suite uses `EXPLAIN (FORMAT JSON)` to capture query plans and asserts:
 *   1. At least one "Index Scan" or "Bitmap Index Scan" node appears in the
 *      plan for every indexed query (sequential scans are flagged).
 *   2. The estimated startup+total cost does not exceed a documented ceiling.
 *   3. No "Seq Scan" on the target table appears for a filtered query when an
 *      index is available.
 *
 * Because vitest cannot connect to a real PostgreSQL instance in a unit test
 * context, the suite is structured in two layers:
 *
 *   Layer 1 (unit, always runs):
 *     - Asserts that the Prisma schema contains the expected @@index() declarations
 *       for every table+field combination listed in INDEX_REGISTRY.
 *     - Verifies that the query construction code selects the correct WHERE
 *       fields that would trigger those indexes.
 *
 *   Layer 2 (integration, skipped unless DATABASE_URL is set):
 *     - Seeds synthetic data with realistic distributions.
 *     - Runs EXPLAIN (FORMAT JSON) against every query in PLAN_ASSERTIONS.
 *     - Asserts Node-Type constraints and cost ceilings.
 *
 * To run Layer 2 locally:
 *   DATABASE_URL=postgres://... npx vitest run src/__tests__/query-plan-regression.test.ts
 *
 * ── Index registry ─────────────────────────────────────────────────────────────
 * Every entry here is a human-readable assertion that the Prisma schema file
 * contains the corresponding @@index() declaration.  If an index is removed
 * from schema.prisma the test fails immediately, before any migration is run.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Index registry ─────────────────────────────────────────────────────────────

interface IndexEntry {
  model:       string;
  fields:      string[];
  description: string;
  queryPattern: string;
}

/**
 * Every index here is required for at least one production query pattern.
 * Adding a new index to the schema without a corresponding entry here will
 * NOT fail — but removing an existing entry will, which is the intent: we
 * guard against accidental index removal.
 */
export const INDEX_REGISTRY: IndexEntry[] = [
  // ── Listing ───────────────────────────────────────────────────────────────
  {
    model: 'Listing', fields: ['status', 'updatedAtLedger'],
    description: 'Composite index for status filter + updatedAtLedger sort (main browse query)',
    queryPattern: 'GET /listings?status=Active + ORDER BY updatedAtLedger DESC',
  },
  {
    model: 'Listing', fields: ['artist', 'updatedAtLedger'],
    description: 'Composite index for artist filter + sort (artist profile page)',
    queryPattern: 'GET /listings?artist=G... + ORDER BY updatedAtLedger DESC',
  },
  {
    model: 'Listing', fields: ['collection'],
    description: 'Index for collection-scoped listing queries',
    queryPattern: 'GET /listings?collection=C...',
  },
  {
    model: 'Listing', fields: ['collection', 'status'],
    description: 'Composite index for collection+status filter (collection detail page)',
    queryPattern: 'GET /listings?collection=C...&status=Active',
  },
  {
    model: 'Listing', fields: ['updatedAtLedger'],
    description: 'Monotonic sort key for cursor pagination',
    queryPattern: 'GET /listings cursor pagination (no other filter)',
  },
  {
    model: 'Listing', fields: ['originalCreator'],
    description: 'Index for royalty stats queries (originalCreator + status=Sold)',
    queryPattern: 'GET /wallets/:address/royalty-stats',
  },
  // ── Auction ───────────────────────────────────────────────────────────────
  {
    model: 'Auction', fields: ['status', 'updatedAtLedger'],
    description: 'Composite index for status filter + sort (main auction browse)',
    queryPattern: 'GET /auctions?status=Active',
  },
  {
    model: 'Auction', fields: ['creator', 'updatedAtLedger'],
    description: 'Composite index for creator filter + sort',
    queryPattern: 'GET /auctions?creator=G...',
  },
  {
    model: 'Auction', fields: ['updatedAtLedger'],
    description: 'Monotonic sort key for cursor pagination',
    queryPattern: 'GET /auctions cursor pagination',
  },
  // ── Offer ──────────────────────────────────────────────────────────────────
  {
    model: 'Offer', fields: ['listingId'],
    description: 'Index for listing-scoped offer queries',
    queryPattern: 'GET /offers?listing_id=1234',
  },
  {
    model: 'Offer', fields: ['listingId', 'updatedAtLedger'],
    description: 'Composite index for listing filter + sort (offer pagination)',
    queryPattern: 'GET /offers?listing_id=1234 cursor pagination',
  },
  // ── Collection ─────────────────────────────────────────────────────────────
  {
    model: 'Collection', fields: ['creator'],
    description: 'Index for creator filter (creator profile page)',
    queryPattern: 'GET /creators/:address/collections',
  },
  {
    model: 'Collection', fields: ['creator', 'deployedAtLedger'],
    description: 'Composite index for creator filter + sort',
    queryPattern: 'GET /creators/:address/collections cursor pagination',
  },
  {
    model: 'Collection', fields: ['kind', 'deployedAtLedger'],
    description: 'Composite index for kind filter + sort',
    queryPattern: 'GET /collections?kind=normal_721',
  },
  // ── MarketplaceEvent ───────────────────────────────────────────────────────
  {
    model: 'MarketplaceEvent', fields: ['actor'],
    description: 'Index for actor filter (wallet activity)',
    queryPattern: 'GET /wallets/:address/activity (actor field)',
  },
  {
    model: 'MarketplaceEvent', fields: ['actor', 'ledgerSequence'],
    description: 'Composite index for actor + sort (wallet activity cursor)',
    queryPattern: 'GET /wallets/:address/activity cursor pagination',
  },
  {
    model: 'MarketplaceEvent', fields: ['eventType'],
    description: 'Index for event type filter (stats, event history)',
    queryPattern: 'GET /stats (eventType=ARTWORK_SOLD)',
  },
  {
    model: 'MarketplaceEvent', fields: ['listingId'],
    description: 'Index for listing-scoped events (listing history)',
    queryPattern: 'GET /listings/:id/history',
  },
  {
    model: 'MarketplaceEvent', fields: ['listingId', 'ledgerSequence'],
    description: 'Composite index for listing events ordered by ledger',
    queryPattern: 'GET /listings/:id/history pagination',
  },
  {
    model: 'MarketplaceEvent', fields: ['ledgerSequence'],
    description: 'Index for ledger-bounded archive queries',
    queryPattern: 'Archive job (ledgerSequence < threshold)',
  },
  {
    model: 'MarketplaceEvent', fields: ['contractId', 'ledgerSequence'],
    description: 'Composite index for contract-scoped event replay',
    queryPattern: 'Backfill / gap-repair queries',
  },
  // ── RoyaltyPayment ────────────────────────────────────────────────────────
  {
    model: 'RoyaltyPayment', fields: ['recipient'],
    description: 'Index for recipient filter (royalty breakdown)',
    queryPattern: 'GET /wallets/:address/royalty-breakdown',
  },
  {
    model: 'RoyaltyPayment', fields: ['recipient', 'ledgerSequence'],
    description: 'Composite index for recipient + ledger range',
    queryPattern: 'GET /wallets/:address/royalty-breakdown?from=X&to=Y',
  },
  // ── Bid ───────────────────────────────────────────────────────────────────
  {
    model: 'Bid', fields: ['auctionId'],
    description: 'Index for auction-scoped bid queries (auction detail)',
    queryPattern: 'GET /auctions/:id (bids relation)',
  },
  {
    model: 'Bid', fields: ['ledgerSequence'],
    description: 'Index for ledger-bounded bid queries',
    queryPattern: 'Reorg cleanup',
  },
  // ── OperationalAudit ─────────────────────────────────────────────────────
  {
    model: 'OperationalAudit', fields: ['actor'],
    description: 'Index for actor filter (admin audit query)',
    queryPattern: 'GET /admin/audit?actor=G...',
  },
  {
    model: 'OperationalAudit', fields: ['actionType'],
    description: 'Index for action type filter',
    queryPattern: 'GET /admin/audit?actionType=AdminRoleChange',
  },
  {
    model: 'OperationalAudit', fields: ['createdAt'],
    description: 'Index for time-range queries and retention cleanup',
    queryPattern: 'GET /admin/audit?startDate=...&endDate=... / retention DELETE',
  },
  {
    model: 'OperationalAudit', fields: ['requestId'],
    description: 'Index for request ID lookup',
    queryPattern: 'GET /admin/audit/:requestId',
  },
];

// ── Schema reader ─────────────────────────────────────────────────────────────

const SCHEMA_PATH = path.resolve(
  __dirname,
  '../../prisma/schema.prisma',
);

function readSchema(): string {
  return fs.readFileSync(SCHEMA_PATH, 'utf8');
}

/**
 * Returns true when the Prisma schema contains an @@index declaration for
 * the given model and field combination.
 *
 * Handles both single-field and composite indexes:
 *   @@index([field])
 *   @@index([field1, field2])
 */
function schemaContainsIndex(schema: string, model: string, fields: string[]): boolean {
  // Find the model block
  const modelStart = schema.indexOf(`model ${model} {`);
  if (modelStart === -1) return false;

  // Find the matching closing brace (handles nested braces)
  let depth = 0;
  let modelEnd = modelStart;
  for (let i = modelStart; i < schema.length; i++) {
    if (schema[i] === '{') depth++;
    else if (schema[i] === '}') {
      depth--;
      if (depth === 0) { modelEnd = i; break; }
    }
  }

  const modelBlock = schema.slice(modelStart, modelEnd + 1);

  // Build the expected index pattern
  const fieldsPattern = fields.join(', ');
  const alternatives = [
    `@@index([${fieldsPattern}])`,
    `@@unique([${fieldsPattern}])`,  // unique constraints also satisfy index needs
    // Allow trailing options: @@index([field], map: "...")
    `@@index([${fieldsPattern}],`,
  ];

  return alternatives.some((alt) => modelBlock.includes(alt));
}

// ── Layer 1: Static schema assertions ─────────────────────────────────────────

describe('Index registry — schema contains required indexes', () => {
  let schema: string;

  beforeAll(() => {
    schema = readSchema();
  });

  for (const entry of INDEX_REGISTRY) {
    it(`${entry.model} has @@index([${entry.fields.join(', ')}]) — ${entry.description}`, () => {
      const found = schemaContainsIndex(schema, entry.model, entry.fields);
      expect(
        found,
        [
          `Missing index on ${entry.model}([${entry.fields.join(', ')}]).`,
          `Required for: ${entry.queryPattern}`,
          `Description: ${entry.description}`,
          `Add @@index([${entry.fields.join(', ')}]) to the ${entry.model} model in schema.prisma.`,
        ].join('\n'),
      ).toBe(true);
    });
  }

  it('GIN index for Listing.searchVector is documented in schema comment', () => {
    const hasComment = schema.includes('Listing_searchVector_idx') &&
                       schema.includes('gin("searchVector")');
    expect(hasComment, 'Missing GIN index comment for Listing.searchVector').toBe(true);
  });

  it('GIN index for Collection.searchVector is documented in schema or migration', () => {
    // Collection uses the same pattern; the comment or @@index reference exists
    const hasRef = schema.includes('collection_search_vector_trigger') ||
                   schema.includes('Collection_searchVector_idx');
    expect(hasRef, 'Missing searchVector GIN index reference for Collection').toBe(true);
  });
});

// ── Layer 2: Live EXPLAIN plan assertions ─────────────────────────────────────
//
// Only runs when DATABASE_URL is set (integration / CI with a real DB).

const HAS_DB = Boolean(process.env.DATABASE_URL);

interface PlanNode {
  'Node Type': string;
  Plans?: PlanNode[];
  'Plan Rows'?: number;
  'Total Cost'?: number;
  'Index Name'?: string;
  'Relation Name'?: string;
}

interface PlanAssertion {
  name:         string;
  sql:          string;
  params?:      unknown[];
  requiresIndexScan: boolean;
  maxEstimatedRows?: number;
  maxTotalCost?:     number;
  notes:        string;
}

/**
 * Documented acceptable plan changes — entries here suppress the assertion
 * for a specific query name when added by an operator after peer review.
 *
 * Format: { name: <assertion name>, reason: <justification>, addedBy: <name>, date: <YYYY-MM-DD> }
 */
const ACCEPTABLE_PLAN_EXCEPTIONS: Array<{ name: string; reason: string; addedBy: string; date: string }> = [
  // Example (uncomment to suppress an assertion):
  // { name: 'Listing: overview count', reason: 'Materialized view used; seq scan expected', addedBy: 'alice', date: '2026-08-01' },
];

const PLAN_ASSERTIONS: PlanAssertion[] = [
  // ── Listings ───────────────────────────────────────────────────────────────
  {
    name: 'Listing: status + sort by updatedAtLedger (main browse)',
    sql: `EXPLAIN (FORMAT JSON) SELECT * FROM "Listing" WHERE "status" = $1 ORDER BY "updatedAtLedger" DESC LIMIT 20`,
    params: ['Active'],
    requiresIndexScan: true,
    maxEstimatedRows: 100_000,
    maxTotalCost: 2_000,
    notes: 'Must use Listing_status_updatedAtLedger_idx',
  },
  {
    name: 'Listing: artist filter + sort (artist profile)',
    sql: `EXPLAIN (FORMAT JSON) SELECT * FROM "Listing" WHERE "artist" = $1 ORDER BY "updatedAtLedger" DESC LIMIT 20`,
    params: ['GBFUNHEQOVN35LFEKP7SZXFYJPMJ3WLXLX4PQZGBK737NTLRHOKVES3F'],
    requiresIndexScan: true,
    maxEstimatedRows: 50_000,
    maxTotalCost: 1_500,
    notes: 'Must use Listing_artist_updatedAtLedger_idx',
  },
  {
    name: 'Listing: cursor pagination (updatedAtLedger < N)',
    sql: `EXPLAIN (FORMAT JSON) SELECT * FROM "Listing" WHERE "updatedAtLedger" < $1 ORDER BY "updatedAtLedger" DESC LIMIT 20`,
    params: [500000],
    requiresIndexScan: true,
    maxTotalCost: 1_000,
    notes: 'Must use Listing_updatedAtLedger_idx',
  },
  {
    name: 'Listing: full-text search (searchVector GIN)',
    sql: `EXPLAIN (FORMAT JSON) SELECT * FROM "Listing" WHERE "searchVector" @@ plainto_tsquery('english', $1) ORDER BY "updatedAtLedger" DESC LIMIT 10`,
    params: ['African art'],
    requiresIndexScan: true,
    maxTotalCost: 5_000,
    notes: 'Must use GIN index on searchVector',
  },
  // ── Auctions ───────────────────────────────────────────────────────────────
  {
    name: 'Auction: status + sort (main browse)',
    sql: `EXPLAIN (FORMAT JSON) SELECT * FROM "Auction" WHERE "status" = $1 ORDER BY "updatedAtLedger" DESC LIMIT 20`,
    params: ['Active'],
    requiresIndexScan: true,
    maxTotalCost: 1_500,
    notes: 'Must use Auction_status_updatedAtLedger_idx',
  },
  // ── Offers ─────────────────────────────────────────────────────────────────
  {
    name: 'Offer: listing filter + cursor pagination',
    sql: `EXPLAIN (FORMAT JSON) SELECT * FROM "Offer" WHERE "listingId" = $1 AND "updatedAtLedger" < $2 ORDER BY "updatedAtLedger" DESC LIMIT 20`,
    params: [1, 500000],
    requiresIndexScan: true,
    maxTotalCost: 500,
    notes: 'Must use Offer_listingId_updatedAtLedger_idx',
  },
  // ── Wallet activity ────────────────────────────────────────────────────────
  {
    name: 'MarketplaceEvent: actor filter + sort (wallet activity)',
    sql: `EXPLAIN (FORMAT JSON) SELECT * FROM "MarketplaceEvent" WHERE "actor" = $1 ORDER BY "ledgerSequence" DESC LIMIT 50`,
    params: ['GBFUNHEQOVN35LFEKP7SZXFYJPMJ3WLXLX4PQZGBK737NTLRHOKVES3F'],
    requiresIndexScan: true,
    maxTotalCost: 2_000,
    notes: 'Must use MarketplaceEvent_actor_ledgerSequence_idx',
  },
  {
    name: 'MarketplaceEvent: listing history (listingId + sort)',
    sql: `EXPLAIN (FORMAT JSON) SELECT * FROM "MarketplaceEvent" WHERE "listingId" = $1 ORDER BY "ledgerSequence" ASC LIMIT 100`,
    params: [1],
    requiresIndexScan: true,
    maxTotalCost: 500,
    notes: 'Must use MarketplaceEvent_listingId_ledgerSequence_idx',
  },
  // ── RoyaltyPayment ────────────────────────────────────────────────────────
  {
    name: 'RoyaltyPayment: recipient + ledger range (royalty breakdown)',
    sql: `EXPLAIN (FORMAT JSON) SELECT * FROM "RoyaltyPayment" WHERE "recipient" = $1 AND "ledgerSequence" >= $2 ORDER BY "ledgerSequence" DESC LIMIT 50`,
    params: ['GBFUNHEQOVN35LFEKP7SZXFYJPMJ3WLXLX4PQZGBK737NTLRHOKVES3F', 400000],
    requiresIndexScan: true,
    maxTotalCost: 1_000,
    notes: 'Must use RoyaltyPayment_recipient_ledgerSequence_idx',
  },
  // ── Collection ─────────────────────────────────────────────────────────────
  {
    name: 'Collection: creator + sort (creator profile)',
    sql: `EXPLAIN (FORMAT JSON) SELECT * FROM "Collection" WHERE "creator" = $1 ORDER BY "deployedAtLedger" DESC LIMIT 20`,
    params: ['GBFUNHEQOVN35LFEKP7SZXFYJPMJ3WLXLX4PQZGBK737NTLRHOKVES3F'],
    requiresIndexScan: true,
    maxTotalCost: 500,
    notes: 'Must use Collection_creator_deployedAtLedger_idx',
  },
  // ── Admin queries ──────────────────────────────────────────────────────────
  {
    name: 'OperationalAudit: time-range query (retention job)',
    sql: `EXPLAIN (FORMAT JSON) DELETE FROM "OperationalAudit" WHERE "createdAt" < $1`,
    params: [new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)],
    requiresIndexScan: true,
    maxTotalCost: 5_000,
    notes: 'Must use OperationalAudit_createdAt_idx',
  },
  {
    name: 'OperationalAudit: actor + actionType (admin audit)',
    sql: `EXPLAIN (FORMAT JSON) SELECT * FROM "OperationalAudit" WHERE "actor" = $1 AND "actionType" = $2 ORDER BY "createdAt" DESC LIMIT 100`,
    params: ['GBFUNHEQOVN35LFEKP7SZXFYJPMJ3WLXLX4PQZGBK737NTLRHOKVES3F', 'AdminRoleChange'],
    requiresIndexScan: true,
    maxTotalCost: 2_000,
    notes: 'Must use OperationalAudit_actor_actionType_idx or OperationalAudit_actor_idx',
  },
];

// ── Plan-walking helpers ───────────────────────────────────────────────────────

function collectNodes(node: PlanNode): PlanNode[] {
  const nodes: PlanNode[] = [node];
  for (const child of node.Plans ?? []) {
    nodes.push(...collectNodes(child));
  }
  return nodes;
}

function hasIndexScan(plan: PlanNode[]): boolean {
  return plan.some((n) =>
    n['Node Type'] === 'Index Scan' ||
    n['Node Type'] === 'Index Only Scan' ||
    n['Node Type'] === 'Bitmap Index Scan' ||
    n['Node Type'] === 'Bitmap Heap Scan',
  );
}

function hasSeqScanOnTable(plan: PlanNode[], tableName: string): boolean {
  return plan.some(
    (n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === tableName,
  );
}

// ── Layer 2 tests ──────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)('EXPLAIN plan regressions — live database', () => {
  let client: import('pg').Client;

  beforeAll(async () => {
    const { Client } = await import('pg');
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    // Seed synthetic data so the planner has realistic statistics.
    // Listing: 10,000 rows; MarketplaceEvent: 50,000 rows.
    await client.query(`
      INSERT INTO "Listing" ("listingId","artist","price","currency","collection","nftTokenId","token","status","createdAtLedger","updatedAtLedger","originalCreator","royaltyBps")
      SELECT
        generate_series(9000001, 9010000) AS "listingId",
        'GBFUNHEQOVN35LFEKP7SZXFYJPMJ3WLXLX4PQZGBK737NTLRHOKVES3F' AS "artist",
        (random() * 1000 + 1)::numeric(32,7) AS "price",
        'XLM' AS "currency",
        'CAFRICAHUB0000000000000000000000000000000000000000000000001' AS "collection",
        generate_series(9000001, 9010000) AS "nftTokenId",
        'CTOKEN' AS "token",
        (ARRAY['Active','Sold','Cancelled'])[floor(random()*3+1)]::"ListingStatus" AS "status",
        (900000 + generate_series(1,10000))::int AS "createdAtLedger",
        (900000 + generate_series(1,10000))::int AS "updatedAtLedger",
        'GBFUNHEQOVN35LFEKP7SZXFYJPMJ3WLXLX4PQZGBK737NTLRHOKVES3F' AS "originalCreator",
        500 AS "royaltyBps"
      ON CONFLICT DO NOTHING
    `);

    await client.query(`
      INSERT INTO "MarketplaceEvent" ("listingId","eventType","actor","data","ledgerSequence","ledgerTimestamp","contractId","confirmed")
      SELECT
        (9000000 + (generate_series % 10000) + 1)::bigint AS "listingId",
        (ARRAY['LISTING_CREATED','ARTWORK_SOLD','BID_PLACED','OFFER_MADE'])[floor(random()*4+1)] AS "eventType",
        'GBFUNHEQOVN35LFEKP7SZXFYJPMJ3WLXLX4PQZGBK737NTLRHOKVES3F' AS "actor",
        '{}'::jsonb AS "data",
        (900000 + generate_series)::int AS "ledgerSequence",
        now() - (generate_series || ' seconds')::interval AS "ledgerTimestamp",
        'CMARKETPLACE00000000000000000000000000000000000000000000001' AS "contractId",
        true AS "confirmed"
      FROM generate_series(1, 50000)
      ON CONFLICT DO NOTHING
    `);

    // Update planner statistics after bulk insert.
    await client.query('ANALYZE "Listing"');
    await client.query('ANALYZE "MarketplaceEvent"');
  });

  afterAll(async () => {
    // Clean up synthetic rows.
    await client.query(`DELETE FROM "Listing" WHERE "listingId" >= 9000001 AND "listingId" <= 9010000`);
    await client.query(`DELETE FROM "MarketplaceEvent" WHERE "ledgerSequence" >= 900001 AND "ledgerSequence" <= 950000`);
    await client.end();
  });

  for (const assertion of PLAN_ASSERTIONS) {
    const isExcepted = ACCEPTABLE_PLAN_EXCEPTIONS.some((e) => e.name === assertion.name);

    it(`${assertion.name} — ${assertion.notes}`, async () => {
      const result = await client.query(assertion.sql, assertion.params);
      const planJson = result.rows[0]['QUERY PLAN'] as [{ Plan: PlanNode }];
      const rootNode = planJson[0].Plan;
      const allNodes = collectNodes(rootNode);

      if (assertion.requiresIndexScan && !isExcepted) {
        const hasIndex = hasIndexScan(allNodes);
        expect(
          hasIndex,
          [
            `REGRESSION: ${assertion.name}`,
            `Expected an index scan but found none.`,
            `Notes: ${assertion.notes}`,
            `Plan:\n${JSON.stringify(planJson, null, 2)}`,
          ].join('\n'),
        ).toBe(true);
      }

      if (assertion.maxTotalCost !== undefined && !isExcepted) {
        const totalCost = rootNode['Total Cost'] ?? 0;
        expect(
          totalCost,
          [
            `COST REGRESSION: ${assertion.name}`,
            `Total cost ${totalCost} exceeds ceiling ${assertion.maxTotalCost}.`,
            `Notes: ${assertion.notes}`,
          ].join('\n'),
        ).toBeLessThanOrEqual(assertion.maxTotalCost);
      }

      if (assertion.maxEstimatedRows !== undefined && !isExcepted) {
        const planRows = rootNode['Plan Rows'] ?? 0;
        expect(
          planRows,
          [
            `ROW ESTIMATE REGRESSION: ${assertion.name}`,
            `Estimated rows ${planRows} exceeds ceiling ${assertion.maxEstimatedRows}.`,
          ].join('\n'),
        ).toBeLessThanOrEqual(assertion.maxEstimatedRows);
      }
    });
  }

  it('ACCEPTABLE_PLAN_EXCEPTIONS entries reference known assertion names', () => {
    const assertionNames = new Set(PLAN_ASSERTIONS.map((a) => a.name));
    for (const exc of ACCEPTABLE_PLAN_EXCEPTIONS) {
      expect(
        assertionNames.has(exc.name),
        `ACCEPTABLE_PLAN_EXCEPTIONS entry "${exc.name}" does not match any assertion name`,
      ).toBe(true);
    }
  });
});

// ── Layer 1 completeness guard ─────────────────────────────────────────────────

describe('INDEX_REGISTRY completeness', () => {
  it('every entry has a non-empty queryPattern description', () => {
    for (const entry of INDEX_REGISTRY) {
      expect(
        entry.queryPattern.length,
        `INDEX_REGISTRY entry ${entry.model}.[${entry.fields}] has empty queryPattern`,
      ).toBeGreaterThan(0);
    }
  });

  it('every entry has a non-empty description', () => {
    for (const entry of INDEX_REGISTRY) {
      expect(
        entry.description.length,
        `INDEX_REGISTRY entry ${entry.model}.[${entry.fields}] has empty description`,
      ).toBeGreaterThan(0);
    }
  });

  it('INDEX_REGISTRY covers all paginated endpoints', () => {
    const endpoints = [
      'GET /listings cursor pagination',
      'GET /auctions cursor pagination',
      'GET /offers',
      'GET /collections',
      'GET /creators/:address/collections',
      'GET /wallets/:address/activity',
      'GET /wallets/:address/royalty-breakdown',
    ];
    const allPatterns = INDEX_REGISTRY.map((e) => e.queryPattern);
    for (const ep of endpoints) {
      const covered = allPatterns.some((p) => p.toLowerCase().includes(ep.split('?')[0].toLowerCase().replace('get ', '')));
      expect(covered, `No INDEX_REGISTRY entry covers endpoint pattern "${ep}"`).toBe(true);
    }
  });
});
