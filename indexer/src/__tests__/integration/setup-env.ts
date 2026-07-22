if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL must be set by the integration global setup (Testcontainers) before tests run.'
  );
}

if (!process.env.REDIS_URL) {
  throw new Error(
    'REDIS_URL must be set by the integration global setup (Testcontainers) before tests run.'
  );
}
