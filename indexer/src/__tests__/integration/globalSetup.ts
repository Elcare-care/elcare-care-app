import { execSync } from 'node:child_process';
import path from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';

const indexerRoot = path.resolve(__dirname, '../../..');

const containers: { postgres?: StartedPostgreSqlContainer; redis?: StartedRedisContainer } = {};

async function startContainers() {
  const postgres = await new PostgreSqlContainer('postgres:15-alpine')
    .withDatabase('marketplace_indexer_test')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  const redis = await new RedisContainer('redis:7-alpine').start();

  containers.postgres = postgres;
  containers.redis = redis;

  process.env.DATABASE_URL = `${postgres.getConnectionUri()}?schema=public`;
  process.env.REDIS_URL = redis.getConnectionUrl();
}

function runMigrations() {
  execSync('npx prisma migrate deploy', {
    cwd: indexerRoot,
    env: process.env,
    stdio: 'inherit',
  });
}

async function stopContainers() {
  try { await containers.redis?.stop(); } catch { /* ignore */ }
  try { await containers.postgres?.stop(); } catch { /* ignore */ }
}

export default async function globalSetup() {
  await startContainers();
  try {
    runMigrations();
  } catch (err) {
    await stopContainers();
    throw err;
  }

  return async function globalTeardown() {
    await stopContainers();
  };
}
