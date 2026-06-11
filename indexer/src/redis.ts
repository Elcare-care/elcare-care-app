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

export default redis;
