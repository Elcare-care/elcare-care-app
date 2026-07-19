import { execSync } from 'node:child_process';
import path from 'node:path';

const indexerRoot = path.resolve(__dirname, '../../..');

export default async function globalSetup() {
  const databaseUrl =
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5432/marketplace_indexer_test?schema=public';

  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
  };

  execSync('npx prisma migrate deploy', { cwd: indexerRoot, env, stdio: 'inherit' });
  execSync('npx prisma db seed', { cwd: indexerRoot, env, stdio: 'inherit' });
}
