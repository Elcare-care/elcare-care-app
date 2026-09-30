/**
 * Process-wide realtime singleton (issue #192).
 *
 * Wires the shared redis client and validated config into one RealtimeHub.
 * routes.ts keeps exporting emitSSEEvent/closeSSEClients with their existing
 * signatures, delegating here, so poller.ts and index.ts call sites are
 * unchanged.
 */

import redis from '../redis.js';
import { loadRealtimeConfig } from '../config.js';
import { RealtimeHub } from './hub.js';

const cfg = loadRealtimeConfig();

export const hub = new RealtimeHub({
  redis,
  streamMaxLen: cfg.sseStreamMaxLen,
  maxConnections: cfg.sseMaxConnections,
  heartbeatMs: cfg.sseHeartbeatMs,
  clientQueueMax: cfg.sseClientQueueMax,
  localBufferSize: cfg.sseLocalBufferSize,
});

// Attach the pub/sub subscriber lazily and non-fatally: when Redis is down
// the hub simply operates in the degraded single-process mode.
let started = false;
export function ensureRealtimeStarted(): void {
  if (started) return;
  started = true;
  void hub.start();
}

/**
 * Publisher entry point — same signature as the legacy in-memory
 * implementation; fire-and-forget so ingestion never blocks on delivery.
 */
export function emitSSEEvent(event: any): void {
  ensureRealtimeStarted();
  void hub.publish(event);
}

/** Graceful-shutdown hook: ends all client streams and stops the subscriber. */
export function closeSSEClients(): void {
  void hub.close();
}
