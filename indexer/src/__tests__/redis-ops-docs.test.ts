/**
 * redis-ops-docs.test.ts — keeps operator docs consistent with source
 * (Issues #1060, #1061, #1062, #1063).
 *
 * Static only: reads source files and markdown, imports no runtime modules,
 * and needs no Redis or PostgreSQL.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const indexerRoot = path.resolve(here, '..', '..');
const repoRoot = path.resolve(indexerRoot, '..');

const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');
const src = (rel: string) => read(indexerRoot, 'src', rel);
const runbook = (name: string) => read(repoRoot, 'docs', 'runbooks', name);

/** Parse `export const TTL = { NAME: 60, ... }` from cache-warmer.ts. */
function parseTtlConstants(): Record<string, number> {
  const block = src('cache-warmer.ts').match(/export const TTL = \{([\s\S]*?)\};/);
  if (!block) throw new Error('TTL block not found in cache-warmer.ts');
  const out: Record<string, number> = {};
  for (const m of block[1].matchAll(/([A-Z_]+):\s*(\d+)/g)) out[m[1]] = Number(m[2]);
  return out;
}

/** Map of route path → TTL seconds for every router.get(...cacheMiddleware(X)...). */
function parseCachedRoutes(): Map<string, number> {
  const ttl = parseTtlConstants();
  const routes = new Map<string, number>();
  const re = /router\.get\('([^']+)'[^\n]*?cacheMiddleware\(([^)]+)\)/g;
  for (const m of src('api/routes.ts').matchAll(re)) {
    const arg = m[2].trim();
    const seconds = /^\d+$/.test(arg) ? Number(arg) : ttl[arg.replace(/^TTL\./, '')];
    if (seconds === undefined) throw new Error(`Unresolved TTL ${arg} for ${m[1]}`);
    // Express serves the first registration; ignore later duplicates.
    if (!routes.has(m[1])) routes.set(m[1], seconds);
  }
  return routes;
}

function parseDocTtlTable(): Map<string, number> {
  const doc = runbook('cache-ttl-reference.md');
  const table = doc.split('<!-- ttl-table:start -->')[1]?.split('<!-- ttl-table:end -->')[0];
  if (!table) throw new Error('ttl-table markers missing');
  const rows = new Map<string, number>();
  for (const m of table.matchAll(/^\|\s*`([^`]+)`\s*\|\s*(\d+)\s*\|/gm)) rows.set(m[1], Number(m[2]));
  return rows;
}

describe('#1062 cache TTL reference matches code', () => {
  it('documents exactly the cached routes with their real TTLs', () => {
    const code = Object.fromEntries(parseCachedRoutes());
    const doc = Object.fromEntries(parseDocTtlTable());
    expect(Object.keys(code).length).toBeGreaterThan(0);
    expect(doc).toEqual(code);
  });

  it('README TTL table agrees with code for the routes it lists', () => {
    const readme = read(indexerRoot, 'README.md');
    const section = readme.split('## Redis Caching')[1]?.split('\n## ')[0] ?? '';
    const code = parseCachedRoutes();
    const rows = [...section.matchAll(/^\|\s*`([^`]+)`\s*\|\s*(\d+)\s*s\s*\|/gm)];
    expect(rows.length).toBeGreaterThan(0);
    for (const [, route, secs] of rows) {
      expect(code.get(route), `README row ${route}`).toBe(Number(secs));
    }
  });

  it('flags REDIS_CACHE_TTL_SECONDS as not consumed (it is parsed but unused)', () => {
    const routes = src('api/routes.ts');
    const uses = routes.match(/\bCACHE_TTL_SECONDS\b/g) ?? [];
    // Only the declaration. If this fails, the env var now has an effect:
    // update cache-ttl-reference.md and indexer/.env.example.
    expect(uses.length).toBe(1);
    expect(read(indexerRoot, '.env.example')).toMatch(/REDIS_CACHE_TTL_SECONDS — currently NOT consumed/);
  });
});

describe('#1061 Redis key registry covers every prefix in source', () => {
  const registry = runbook('redis-key-registry.md');
  const prefixes: Array<[file: string, literal: string, documented: string]> = [
    ['api/cache-middleware.ts', '`cache:${', '`cache:<request path + query>`'],
    ['api/cache-service.ts', '`lock:${key}`', '`lock:<cache key>`'],
    ['api/routes.ts', "getCached('activity:recent'", '`activity:recent`'],
    ['api/routes.ts', '`collection_fee:${address}`', '`collection_fee:<collection address>`'],
    ['api/abuse-detection.ts', "QUOTA_PREFIX = 'abuse:quota'", '`abuse:quota:<family>:<subject>`'],
    ['api/abuse-detection.ts', "BLOCK_PREFIX = 'abuse:block'", '`abuse:block:<subject>`'],
    ['realtime/hub.ts', "'sse:events'", '`sse:events`'],
    ['realtime/hub.ts', "'sse:events:pub'", '`sse:events:pub`'],
  ];

  it.each(prefixes)('%s defines %s and the registry documents it', (file, literal, documented) => {
    expect(src(file)).toContain(literal);
    expect(registry).toContain(documented);
  });
});

describe('#1063 poller health checklist thresholds match code', () => {
  const checklist = runbook('poller-health-checklist.md');

  it('sync-lag thresholds', () => {
    const health = src('health.ts');
    expect(health).toMatch(/SYNC_LAG_DEGRADED = 100\b/);
    expect(health).toMatch(/SYNC_LAG_DOWN\s+= 1_000\b/);
    expect(checklist).toContain('101 – 1000');
  });

  it('stall thresholds and rollback depth defaults', () => {
    const cfg = src('config.ts');
    expect(cfg).toMatch(/'STALL_WARNING_MS',\s+process\.env\.STALL_WARNING_MS,\s+30_000/);
    expect(cfg).toMatch(/'STALL_CRITICAL_MS',\s+process\.env\.STALL_CRITICAL_MS,\s+120_000/);
    expect(cfg).toMatch(/'STALL_FATAL_MS',\s+process\.env\.STALL_FATAL_MS,\s+300_000/);
    expect(cfg).toMatch(/'MAX_ROLLBACK_DEPTH',\s+process\.env\.MAX_ROLLBACK_DEPTH,\s+100/);
    expect(src('stall.ts')).toMatch(/RPC_FAILURE_WARNING_THRESHOLD = 5;/);
    expect(src('stall.ts')).toMatch(/MAX_RESTART_ATTEMPTS = 3;/);
  });

  it('documented log lines exist verbatim in the poller', () => {
    const poller = src('poller.ts');
    for (const line of ['Chain re-org detected', 'Reorg: rolling back', 'halting poller']) {
      expect(poller).toContain(line);
      expect(checklist).toContain(line);
    }
  });

  it('links to the stalled-ingestion runbook', () => {
    expect(checklist).toContain('](./stalled-ingestion.md)');
  });
});

describe('#1060 stale-cache diagnostic stays read-only', () => {
  const script = read(repoRoot, 'scripts', 'diagnostics', 'compare-cache-vs-db.sh');

  it('uses the same key shape the poller invalidates', () => {
    expect(src('poller.ts')).toContain('invalidateKey(`cache:/listings/${');
    expect(script).toContain('CACHE_KEY="cache:/${PATH_SEG}/${ID}"');
  });

  it('issues no mutating Redis or SQL commands', () => {
    const code = script.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(code).not.toMatch(/\b(DEL|FLUSHDB|FLUSHALL|EXPIRE|SETEX|UNLINK)\b/);
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i);
    expect(code).toContain('default_transaction_read_only=on');
  });
});
