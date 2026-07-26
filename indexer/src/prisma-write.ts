/**
 * prisma-write.ts — Write-path Prisma client (poller / parser pool).
 *
 * connection_limit=3  — Small, dedicated pool for the write path.
 *                       Burst writes during event processing get their own
 *                       connections and never compete with API reads.
 * pool_timeout=30      — Surface exhaustion as a clear error, not a hang.
 *
 * Usage:
 *   import prismaWrite from './prisma-write.js';
 *
 * All poller.ts and backfill.ts DB writes should use this client.
 * Read-heavy API routes should continue to use the default db.ts client.
 */
import { PrismaClient } from '@prisma/client';

const writeConnectionLimit = parseInt(process.env.DB_WRITE_CONNECTION_LIMIT || '3',  10);
const poolTimeout          = parseInt(process.env.DB_POOL_TIMEOUT           || '30', 10); // seconds
const statementTimeout     = parseInt(process.env.DB_STATEMENT_TIMEOUT      || '30000', 10); // ms

function buildWriteDatabaseUrl(): string {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const url = new URL(baseUrl);
  url.searchParams.set('connection_limit', String(writeConnectionLimit));
  url.searchParams.set('pool_timeout',     String(poolTimeout));

  return url.toString();
}

const prismaWrite = new PrismaClient({
  datasources: {
    db: {
      url: buildWriteDatabaseUrl(),
    },
  },
});

// Best-effort per-session statement timeout for write operations.
prismaWrite.$executeRawUnsafe(`SET statement_timeout = ${statementTimeout}`).catch((err) => {
  console.warn('[prisma-write] Could not set statement_timeout:', err.message);
});

export default prismaWrite;
