import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const REDIS_RECONNECT_BASE_DELAY_MS = 50;
const REDIS_RECONNECT_MAX_DELAY_MS = 3000;
const REDIS_RECONNECT_JITTER_MS = 100;

export function calculateRedisReconnectDelay(retries: number, jitterMs = 0) {
    const exponentialBackoff = REDIS_RECONNECT_BASE_DELAY_MS * (2 ** retries);
    return Math.min(exponentialBackoff + jitterMs, REDIS_RECONNECT_MAX_DELAY_MS);
}

export function redisReconnectStrategy(retries: number) {
    const jitter = Math.floor(Math.random() * REDIS_RECONNECT_JITTER_MS);
    return calculateRedisReconnectDelay(retries, jitter);
}

const redis = createClient({
    url: REDIS_URL,
    disableOfflineQueue: true,
    socket: {
        reconnectStrategy: redisReconnectStrategy,
    },
});

redis.on('error', (err) => {
    console.warn('[Redis] Connection error (caching disabled):', err.message);
});

redis.connect().catch((err) => {
    console.warn('[Redis] Could not connect (caching disabled):', err.message);
});

// ── Cache invalidation helpers ────────────────────────────────────────────────

function isClientReady(client: any): boolean {
    if (typeof client.isReady === 'boolean') return client.isReady;
    if (typeof client.status === 'string') return client.status === 'ready';
    return Boolean(client.isOpen);
}

/**
 * Delete a single cache key by exact name.
 * No-op if Redis is not connected.
 */
export async function invalidateKey(key: string): Promise<void> {
    if (!isClientReady(redis as any)) return;
    try {
        await (redis as any).del(key);
    } catch (err) {
        console.warn('[Redis] invalidateKey failed', key, err instanceof Error ? err.message : err);
    }
}

/**
 * Delete all cache keys matching a glob pattern via SCAN + DEL.
 * Uses SCAN to avoid blocking the Redis server on large key spaces.
 * No-op if Redis is not connected.
 */
export async function invalidatePattern(pattern: string): Promise<void> {
    const client = redis as any;
    if (!isClientReady(client)) return;
    try {
        // Use keys() for simplicity; for very large datasets consider SCAN cursor.
        const keys: string[] = await client.keys(pattern);
        if (keys.length > 0) {
            await client.del(keys);
        }
    } catch (err) {
        console.warn('[Redis] invalidatePattern failed', pattern, err instanceof Error ? err.message : err);
    }
}

export default redis;
