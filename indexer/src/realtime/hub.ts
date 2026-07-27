/**
 * RealtimeHub — multi-instance SSE fan-out over Redis (issue #192).
 *
 * Publish path (emitSSEEvent → hub.publish):
 *   1. XADD the event to a capped Redis Stream (durable replay window), then
 *      PUBLISH it on a pub/sub channel so every API instance fans it out to
 *      its local clients.
 *   2. When Redis is unavailable (or either call fails), fall back to the
 *      legacy single-process path: assign a local counter id, keep the event
 *      in an in-memory ring buffer, and deliver directly to local clients.
 *
 * Subscribe path: each instance runs one subscriber connection; incoming
 * messages are fanned out to that instance's SSE clients.
 *
 * Client lifecycle: per-client bounded send queue (drop-oldest when a slow
 * client falls behind), hub-level heartbeat, connection cap, and a close()
 * that fits the poller's graceful-shutdown hooks.
 *
 * The hub is instantiable (no module-level state) so tests can run two
 * instances against a shared in-memory Redis substitute.
 */

import {
  sseConnectedClientsGauge,
  sseEventsDeliveredTotal,
  sseEventsDroppedTotal,
  sseReplayRequestsTotal,
  sseRedisPublishFailuresTotal,
  sseDegradedFallbackTotal,
  sseSubscriberReconnectsTotal,
} from '../metrics.js';
import { logger } from '../logger.js';
import { compareEventIds, exclusiveRangeStart, isValidEventId } from './stream-ids.js';

// Minimal writable-response surface the hub needs; satisfied by Express's
// Response and by lightweight fakes in tests.
export interface SseSink {
  write(chunk: string): boolean;
  end(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface ClientFilter {
  types?: Set<string>;
  listingId?: string;
}

interface ClientState {
  sink: SseSink;
  filter: ClientFilter;
  queue: string[];        // pending frames (already serialized)
  writing: boolean;       // a flush pump is active
  replaying: boolean;     // initial replay still in progress
  lastSentId: string;     // highest id written during replay/flush
  closed: boolean;
}

export interface PublishedMessage {
  id: string;
  data: string;                 // JSON payload for the data: line
  eventType?: string;
  listingId?: string | null;
}

export interface RealtimeHubOptions {
  /** Shared node-redis client (commands); null forces permanent degraded mode. */
  redis?: any | null;
  /** Factory for the pub/sub connection; defaults to redis.duplicate(). */
  createSubscriber?: () => any;
  streamKey?: string;
  channel?: string;
  /** XADD MAXLEN ~ cap — this bounds the durable replay horizon. */
  streamMaxLen?: number;
  maxConnections?: number;
  heartbeatMs?: number;
  /** Per-client queue cap; overflow drops the oldest queued frames. */
  clientQueueMax?: number;
  /** Degraded-mode in-memory ring size. */
  localBufferSize?: number;
  /** Delay between subscriber reconnect attempts. */
  reconnectDelayMs?: number;
}

interface BufferedEvent {
  id: string;
  data: string;
  eventType?: string;
  listingId?: string | null;
}

const bigintReplacer = (_k: string, v: unknown) =>
  typeof v === 'bigint' ? v.toString() : v;

export class RealtimeHub {
  private readonly redis: any | null;
  private readonly createSubscriber?: () => any;
  readonly streamKey: string;
  readonly channel: string;
  private readonly streamMaxLen: number;
  private readonly maxConnections: number;
  private readonly heartbeatMs: number;
  private readonly clientQueueMax: number;
  private readonly localBufferSize: number;
  private readonly reconnectDelayMs: number;

  private clients = new Map<SseSink, ClientState>();
  private localBuffer: BufferedEvent[] = [];
  private localCounter = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private subscriber: any | null = null;
  private subscriberAttached = false;
  private closed = false;
  /** True while the last publish had to use the in-memory fallback. */
  degraded = false;

  constructor(opts: RealtimeHubOptions = {}) {
    this.redis = opts.redis ?? null;
    this.createSubscriber = opts.createSubscriber;
    this.streamKey = opts.streamKey ?? 'sse:events';
    this.channel = opts.channel ?? 'sse:events:pub';
    this.streamMaxLen = opts.streamMaxLen ?? 1000;
    this.maxConnections = opts.maxConnections ?? 100;
    this.heartbeatMs = opts.heartbeatMs ?? 30_000;
    this.clientQueueMax = opts.clientQueueMax ?? 100;
    this.localBufferSize = opts.localBufferSize ?? 200;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 1_000;
  }

  // ── Publisher ───────────────────────────────────────────────────────────────

  /**
   * Publishes one event. Never throws — realtime delivery must not break the
   * poller's ingestion transaction path.
   */
  async publish(event: any): Promise<void> {
    const data = JSON.stringify(event, bigintReplacer);
    const eventType: string | undefined = event?.eventType;
    const listingId: string | null =
      event?.listingId != null ? String(event.listingId) : null;

    if (this.redisUsable()) {
      try {
        const id: string = await this.redis.xAdd(
          this.streamKey,
          '*',
          {
            data,
            ...(eventType ? { eventType } : {}),
            ...(listingId != null ? { listingId } : {}),
          },
          { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: this.streamMaxLen } },
        );

        const message: PublishedMessage = { id, data, eventType, listingId };
        await this.redis.publish(this.channel, JSON.stringify(message));
        this.degraded = false;
        return;
      } catch (err) {
        sseRedisPublishFailuresTotal.inc();
        logger.warn('realtime: redis publish failed — falling back to local delivery', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Degraded single-process path
    this.degraded = true;
    sseDegradedFallbackTotal.inc();
    const id = String(++this.localCounter);
    const buffered: BufferedEvent = { id, data, eventType, listingId };
    this.localBuffer.push(buffered);
    if (this.localBuffer.length > this.localBufferSize) this.localBuffer.shift();
    this.fanOut(buffered, /*applySkip*/ false);
  }

  private redisUsable(): boolean {
    return !!(
      this.redis &&
      this.redis.isReady !== false &&
      typeof this.redis.xAdd === 'function' &&
      typeof this.redis.publish === 'function'
    );
  }

  // ── Subscriber ──────────────────────────────────────────────────────────────

  /** Starts the pub/sub subscriber with a reconnect loop. Safe to call once. */
  async start(): Promise<void> {
    if (this.closed || this.subscriberAttached) return;
    if (!this.redis || (!this.createSubscriber && typeof this.redis.duplicate !== 'function')) {
      return; // permanent degraded mode
    }
    await this.attachSubscriber(false);
  }

  private async attachSubscriber(isReconnect: boolean): Promise<void> {
    if (this.closed) return;
    try {
      const sub = this.createSubscriber
        ? this.createSubscriber()
        : this.redis.duplicate();
      this.subscriber = sub;

      if (typeof sub.on === 'function') {
        sub.on('error', () => { /* handled by reconnect scheduling below */ });
        // node-redis emits 'end' when the connection is permanently closed
        sub.on('end', () => this.scheduleResubscribe());
      }
      if (typeof sub.connect === 'function' && sub.isOpen !== true) {
        await sub.connect();
      }
      await sub.subscribe(this.channel, (raw: string) => this.onMessage(raw));
      this.subscriberAttached = true;
      if (isReconnect) sseSubscriberReconnectsTotal.inc();
    } catch (err) {
      this.subscriberAttached = false;
      logger.warn('realtime: subscriber attach failed — retrying', {
        err: err instanceof Error ? err.message : String(err),
      });
      this.scheduleResubscribe();
    }
  }

  private resubscribeTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleResubscribe(): void {
    if (this.closed || this.resubscribeTimer) return;
    this.subscriberAttached = false;
    this.resubscribeTimer = setTimeout(() => {
      this.resubscribeTimer = null;
      void this.attachSubscriber(true);
    }, this.reconnectDelayMs);
  }

  private onMessage(raw: string): void {
    let msg: PublishedMessage;
    try {
      msg = JSON.parse(raw);
      if (typeof msg?.id !== 'string' || typeof msg?.data !== 'string') return;
    } catch {
      return; // ignore malformed broadcast payloads
    }
    this.fanOut(msg, /*applySkip*/ true);
  }

  // ── Client registry ─────────────────────────────────────────────────────────

  get connectionCount(): number {
    return this.clients.size;
  }

  get atCapacity(): boolean {
    return this.clients.size >= this.maxConnections;
  }

  /**
   * Registers a connected SSE client and, when `lastEventId` is provided,
   * replays the missed window before switching to live tail. Live events that
   * arrive during replay are queued and flushed afterwards; the monotonic
   * id-skip rule removes any overlap, so the client sees exactly-once,
   * in-order delivery across the resume boundary.
   */
  async attachClient(
    sink: SseSink,
    opts: { filter?: ClientFilter; lastEventId?: string | null } = {},
  ): Promise<void> {
    const state: ClientState = {
      sink,
      filter: opts.filter ?? {},
      queue: [],
      writing: false,
      replaying: false,
      lastSentId: '',
      closed: false,
    };
    this.clients.set(sink, state);
    sseConnectedClientsGauge.set(this.clients.size);

    if (this.heartbeatTimer === null && this.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
      // Never keep the process alive just for heartbeats
      (this.heartbeatTimer as any).unref?.();
    }

    sink.on('close', () => this.detachClient(sink));
    sink.on('error', () => this.detachClient(sink));

    if (this.degraded || !this.redisUsable()) {
      this.safeWrite(state, `: resume-not-durable\n\n`);
    }

    const lastEventId = opts.lastEventId ?? null;
    if (lastEventId !== null && isValidEventId(lastEventId)) {
      state.replaying = true;
      sseReplayRequestsTotal.inc();
      try {
        await this.replay(state, lastEventId);
      } catch (err) {
        logger.warn('realtime: replay failed — continuing with live tail', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
      state.replaying = false;
      // Flush live frames queued during replay (skip already-replayed ids)
      this.flush(state);
    }
  }

  detachClient(sink: SseSink): void {
    const state = this.clients.get(sink);
    if (!state) return;
    state.closed = true;
    this.clients.delete(sink);
    sseConnectedClientsGauge.set(this.clients.size);
    if (this.clients.size === 0 && this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Replays the missed window: Redis Stream when available, local ring otherwise. */
  private async replay(state: ClientState, lastEventId: string): Promise<void> {
    if (this.redisUsable() && typeof this.redis.xRange === 'function') {
      const start = exclusiveRangeStart(lastEventId);
      if (start === null) return;
      // The stream is capped at streamMaxLen entries — that cap is the
      // documented replay horizon; older events are gone.
      const entries: Array<{ id: string; message: Record<string, string> }> =
        await this.redis.xRange(this.streamKey, start, '+', { COUNT: this.streamMaxLen });
      for (const entry of entries) {
        if (compareEventIds(entry.id, lastEventId) <= 0) continue;
        this.deliverTo(state, {
          id: entry.id,
          data: entry.message.data ?? '',
          eventType: entry.message.eventType,
          listingId: entry.message.listingId ?? null,
        }, true);
      }
      return;
    }

    // Degraded: replay from the in-memory ring buffer
    for (const ev of this.localBuffer) {
      if (compareEventIds(ev.id, lastEventId) <= 0) continue;
      this.deliverTo(state, ev, true);
    }
  }

  // ── Delivery ────────────────────────────────────────────────────────────────

  private fanOut(msg: PublishedMessage | BufferedEvent, applySkip: boolean): void {
    for (const state of this.clients.values()) {
      this.deliverTo(state, msg, applySkip);
    }
  }

  private matchesFilter(state: ClientState, msg: PublishedMessage | BufferedEvent): boolean {
    const { types, listingId } = state.filter;
    if (types && (!msg.eventType || !types.has(msg.eventType))) return false;
    if (listingId !== undefined && String(msg.listingId ?? '') !== listingId) return false;
    return true;
  }

  private deliverTo(
    state: ClientState,
    msg: PublishedMessage | BufferedEvent,
    applySkip: boolean,
  ): void {
    if (state.closed) return;
    if (!this.matchesFilter(state, msg)) return;
    // Monotonic skip: during replay (and its live-overlap flush) never resend
    // an id the client already has.
    if (applySkip && state.lastSentId && compareEventIds(msg.id, state.lastSentId) <= 0) {
      return;
    }

    const frame = `id: ${msg.id}\ndata: ${msg.data}\n\n`;
    state.queue.push(frame);

    // Backpressure: a slow client's queue is bounded; the oldest frames are
    // dropped first so the client converges on the live tail.
    while (state.queue.length > this.clientQueueMax) {
      state.queue.shift();
      sseEventsDroppedTotal.inc();
    }

    if (compareEventIds(msg.id, state.lastSentId || '0') > 0) {
      state.lastSentId = msg.id;
    }

    if (!state.replaying) this.flush(state);
  }

  /** Drains the client queue, respecting socket backpressure via 'drain'. */
  private flush(state: ClientState): void {
    if (state.writing || state.closed) return;
    state.writing = true;
    while (state.queue.length > 0) {
      const frame = state.queue.shift()!;
      let ok: boolean;
      try {
        ok = state.sink.write(frame);
        sseEventsDeliveredTotal.inc();
      } catch {
        this.detachClient(state.sink);
        return;
      }
      if (!ok) {
        // Socket buffer full — stay "writing" until drain fires; further
        // frames queue up (bounded by clientQueueMax) in the meantime.
        // `once` avoids accumulating a listener per stalled write. Do NOT
        // reset state.writing here — that would let a second, concurrent
        // flush() start draining the same queue.
        const resume = () => {
          state.writing = false;
          this.flush(state);
        };
        const sink = state.sink as SseSink & { once?: SseSink['on'] };
        if (typeof sink.once === 'function') sink.once('drain', resume);
        else sink.on('drain', resume);
        return;
      }
    }
    state.writing = false;
  }

  private safeWrite(state: ClientState, chunk: string): void {
    try {
      state.sink.write(chunk);
    } catch {
      this.detachClient(state.sink);
    }
  }

  heartbeat(): void {
    for (const state of this.clients.values()) {
      this.safeWrite(state, `: heartbeat\n\n`);
    }
  }

  // ── Shutdown / test hooks ───────────────────────────────────────────────────

  /** Ends every client stream and stops timers/subscriber. Fast and idempotent. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.resubscribeTimer !== null) {
      clearTimeout(this.resubscribeTimer);
      this.resubscribeTimer = null;
    }
    for (const [sink, state] of this.clients) {
      state.closed = true;
      try { sink.end(); } catch { /* ignore */ }
    }
    this.clients.clear();
    sseConnectedClientsGauge.set(0);

    const sub = this.subscriber;
    this.subscriber = null;
    this.subscriberAttached = false;
    if (sub) {
      try {
        if (typeof sub.unsubscribe === 'function') await sub.unsubscribe(this.channel);
        if (typeof sub.destroy === 'function') sub.destroy();
        else if (typeof sub.disconnect === 'function') await sub.disconnect();
        else if (typeof sub.quit === 'function') await sub.quit();
      } catch { /* best-effort */ }
    }
  }

  // Exposed for tests and the legacy routes.ts test helpers
  _localBuffer(): Array<{ id: string; data: string }> {
    return this.localBuffer;
  }
  _localCounter(): number {
    return this.localCounter;
  }
  _reset(): void {
    this.localBuffer = [];
    this.localCounter = 0;
    this.degraded = false;
    for (const [sink] of this.clients) this.detachClient(sink);
  }
}
