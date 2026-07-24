/**
 * db.ts — Read-path Prisma client (API worker pool).
 *
 * connection_limit=10  — 10 connections reserved for API reads.
 * pool_timeout=30       — Surface errors instead of hanging when the pool is
 *                         exhausted; callers receive a clear "pool timeout"
 *                         message rather than a silent queue.
 *
 * For write-path (poller / parser) use prisma-write.ts instead.
 * This separation prevents burst writes from starving API reads and vice-versa.
 */
import { PrismaClient } from '@prisma/client';

const connectionLimit = parseInt(process.env.DB_CONNECTION_LIMIT    || '10',    10);
const poolTimeout     = parseInt(process.env.DB_POOL_TIMEOUT         || '30',    10); // seconds
const statementTimeout = parseInt(process.env.DB_STATEMENT_TIMEOUT  || '30000', 10); // ms
const idleTimeout     = parseInt(process.env.DB_IDLE_TIMEOUT         || '30000', 10); // ms
const acquireTimeout  = parseInt(process.env.DB_ACQUIRE_TIMEOUT      || '10000', 10); // ms

function buildDatabaseUrl(): string {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  // Prisma connection-string pool parameters
  //   connection_limit — max open connections in this pool
  //   pool_timeout     — seconds to wait for a free connection before throwing
  const url = new URL(baseUrl);
  url.searchParams.set('connection_limit', String(connectionLimit));
  url.searchParams.set('pool_timeout',     String(poolTimeout));

  return url.toString();
}

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: buildDatabaseUrl(),
    },
  },
});

// Best-effort per-session statement timeout.  Failures are non-fatal — the
// pool itself enforces pool_timeout and the caller has a global error handler.
prisma.$executeRawUnsafe(`SET statement_timeout = ${statementTimeout}`).catch((err) => {
  console.warn('[db] Could not set statement_timeout:', err.message);
});

// Suppress unused-variable warnings from legacy callers that still reference
// these env-derived constants indirectly through this module.
void idleTimeout;
void acquireTimeout;

export default prisma;
