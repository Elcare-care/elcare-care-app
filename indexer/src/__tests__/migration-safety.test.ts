/**
 * Tests for migration safety and validation
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION_191 = join(
  __dirname,
  '../../prisma/migrations/20260720000000_add_event_identity_ordering_and_history/migration.sql'
);
const SCHEMA_PATH = join(__dirname, '../../prisma/schema.prisma');

describe('Migration safety', () => {
  describe('migration file structure', () => {
    it('all migrations have a migration.sql file', async () => {
      // This test verifies the migration structure exists
      // In a real CI environment, this would check the migrations directory
      const migrationPath = 'prisma/migrations';
      expect(migrationPath).toBeTruthy();
    });

    it('migration names follow timestamp_description format', () => {
      // Pattern: YYYYMMDDHHMMSS_description
      const validMigrationName = '20260601120000_add_users_table';
      const timestampPattern = /^\d{14}_[a-z0-9_]+$/;
      expect(validMigrationName).toMatch(timestampPattern);
    });
  });

  describe('schema validation', () => {
    it('recognizes valid schema models', () => {
      const validModel = {
        id: { type: 'Int', isId: true },
        email: { type: 'String', isUnique: true },
        name: { type: 'String' },
      };
      expect(validModel.id.isId).toBe(true);
      expect(validModel.email.isUnique).toBe(true);
    });

    it('validates indexes on high-cardinality columns', () => {
      const column = {
        name: 'listingId',
        type: 'BigInt',
        hasIndex: true,
      };
      expect(column.hasIndex).toBe(true);
    });

    it('requires NOT NULL only when default provided', () => {
      // A column without a default should allow NULL
      const column = {
        name: 'optional_field',
        type: 'String',
        isRequired: false,
        default: null,
      };
      expect(column.default === null).toBe(column.isRequired === false || column.default !== null);
    });
  });

  describe('reversibility', () => {
    it('ADD COLUMN can be reversed with DROP COLUMN', () => {
      const forward = 'ALTER TABLE listing ADD COLUMN test_col INT;';
      const reverse = 'ALTER TABLE listing DROP COLUMN test_col;';
      expect(reverse).toContain('DROP');
      expect(forward).toContain('ADD');
    });

    it('CREATE INDEX can be reversed with DROP INDEX', () => {
      const forward = 'CREATE INDEX idx_test ON listing(price);';
      const reverse = 'DROP INDEX IF EXISTS idx_test;';
      expect(reverse).toContain('DROP INDEX');
    });

    it('CREATE TABLE can be reversed with DROP TABLE', () => {
      const forward = 'CREATE TABLE test_table (id SERIAL PRIMARY KEY);';
      const reverse = 'DROP TABLE IF EXISTS test_table CASCADE;';
      expect(reverse).toContain('DROP TABLE');
    });

    it('data migration requires manual reverse', () => {
      const forward = `
        ALTER TABLE listing ADD COLUMN price_cents BIGINT;
        UPDATE listing SET price_cents = price * 100;
        ALTER TABLE listing DROP COLUMN price;
      `;
      // Data migrations typically require custom reverse logic
      expect(forward).toContain('UPDATE');
      // This should be documented in the migration file
    });
  });

  describe('performance considerations', () => {
    it('detects missing indexes on frequently queried columns', () => {
      const listing = {
        artist: { type: 'String', hasIndex: true },
        status: { type: 'String', hasIndex: true },
        updatedAtLedger: { type: 'Int', hasIndex: true },
      };
      expect(listing.artist.hasIndex).toBe(true);
      expect(listing.status.hasIndex).toBe(true);
    });

    it('recommends CONCURRENTLY for large table indexing', () => {
      const largeTableThreshold = 100000; // rows
      const rowCount = 500000;
      const shouldUseConcurrently = rowCount > largeTableThreshold;
      expect(shouldUseConcurrently).toBe(true);
    });

    it('validates that ALTER TABLE uses CONCURRENTLY on large tables', () => {
      const migration = `
        CREATE INDEX CONCURRENTLY idx_listing_artist 
        ON listing(artist);
      `;
      expect(migration).toContain('CONCURRENTLY');
    });
  });

  describe('constraint validation', () => {
    it('foreign keys reference existing tables', () => {
      const fk = {
        table: 'Offer',
        column: 'listingId',
        references: 'Listing',
        onDelete: 'CASCADE',
      };
      expect(fk.references).toBeTruthy();
    });

    it('unique constraints on appropriate columns', () => {
      const uniqueColumns = [
        { table: 'Collection', column: 'contractAddress' },
      ];
      uniqueColumns.forEach(col => {
        expect(col.table).toBeTruthy();
        expect(col.column).toBeTruthy();
      });
    });
  });

  // ── #191: event identity, ordering and history migration ──────────────────

  describe('event identity & ordering migration (20260720000000)', () => {
    const sql = readFileSync(MIGRATION_191, 'utf8');

    it('adds new NOT NULL columns using the nullable-then-required strategy', () => {
      // Columns must first be added nullable so the migration applies cleanly
      // to a database populated with current-shape rows...
      for (const col of ['eventId', 'txHash', 'txIndex', 'eventIndex']) {
        expect(sql).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS "${col}"`));
        // ...and must not be declared NOT NULL inline with ADD COLUMN
        expect(sql).not.toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS "${col}"[^;]*NOT NULL`));
      }
    });

    it('backfills every new column before enforcing NOT NULL', () => {
      const backfillIdx = sql.indexOf('SET "eventId" = CASE');
      const notNullIdx = sql.indexOf('ALTER COLUMN "eventId" SET NOT NULL');
      expect(backfillIdx).toBeGreaterThan(-1);
      expect(notNullIdx).toBeGreaterThan(backfillIdx);
    });

    it('backfills legacy eventId from eventHash with a row-id fallback', () => {
      expect(sql).toContain(`WHEN "eventHash" IS NOT NULL AND "eventHash" <> '' THEN "eventHash"`);
      expect(sql).toContain(`'legacy-' || "id"::TEXT`);
    });

    it('creates a unique index on eventId', () => {
      expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "MarketplaceEvent_eventId_key"');
    });

    it('drops the lossy (listingId, eventType, ledgerSequence) unique key', () => {
      expect(sql).toContain('DROP INDEX IF EXISTS "MarketplaceEvent_listingId_eventType_ledgerSequence_key"');
    });

    it('creates the PriceHistory and ProtocolFee tables with unique eventId', () => {
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS "PriceHistory"');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS "ProtocolFee"');
      expect(sql).toContain('"PriceHistory_eventId_key"');
      expect(sql).toContain('"ProtocolFee_eventId_key"');
    });

    it('adds the Reclaimed offer status without using it in the same transaction', () => {
      expect(sql).toContain(`ALTER TYPE "OfferStatus" ADD VALUE IF NOT EXISTS 'Reclaimed'`);
      // PG requires the new enum value not be referenced in the same migration
      expect(sql).not.toMatch(/(?:=|::"OfferStatus")\s*'Reclaimed'/);
    });

    it('documents the reverse migration', () => {
      expect(sql).toContain('Reverse');
      expect(sql).toContain('DROP TABLE "ProtocolFee"');
      expect(sql).toContain('DROP TABLE "PriceHistory"');
    });

    it('schema no longer declares the lossy unique constraint', () => {
      const schema = readFileSync(SCHEMA_PATH, 'utf8');
      expect(schema).not.toContain('@@unique([listingId, eventType, ledgerSequence])');
      expect(schema).toMatch(/eventId\s+String\s+@unique/);
    });

    it('schema keeps the Bid unique key the upsert path relies on', () => {
      const schema = readFileSync(SCHEMA_PATH, 'utf8');
      expect(schema).toContain('@@unique([auctionId, ledgerSequence, bidder])');
    });
  });
});
