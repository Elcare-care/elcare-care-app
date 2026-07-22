/**
 * realtime-hub.test.ts
 *
 * Exercises the RealtimeHub against a shared in-memory Redis substitute
 * (FakeRedisBus) so multi-instance fan-out, durable resume, and outage
 * fallback can be tested without a live Redis server.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealtimeHub, type SseSink } from '../realtime/hub';
import { FakeRedisBus, FakeRedisClient } from './helpers/fake-redis';
import {
  sseConnectedClientsGauge,
  sseEventsDeliveredTotal,
  sseEventsDroppedTotal,
  sseReplayRequestsTotal,
  sseRedisPublishFailuresTotal,
  sseDegradedFallbackTotal,
  sseSubscriberReconnectsTotal,
} from '../metrics';

// ── Test double: a minimal writable SSE sink ─────────────────────────────────

class MockSink implements SseSink {
  frames: string[] = [];
  ended = false;
  writeReturns: boolean | (() => boolean) = true;
  private listeners = new Map<string, Array<(...a: any[]) => void>>();

  write(chunk: string): boolean {
    if (this.ended) throw new Error('write after end');
    this.frames.push(chunk);
    return typeof this.writeReturns === 'function' ? this.writeReturns() : this.writeReturns;
  }

  end(): void {
    this.ended = true;
    this.emit('close');
  }

  on(event: string, listener: (...a: any[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  once(event: string, listener: (...a: any[]) => void): this {
    const wrapped = (...a: any[]) => {
      this.off(event, wrapped);
      listener(...a);
    };
    return this.on(event, wrapped);
  }

  off(event: string, listener: (...a: any[]) => void): this {
    const list = this.listeners.get(event);
    if (list) this.listeners.set(event, list.filter((l) => l !== listener));
    return this;
  }

  emit(event: string, ...args: any[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }

  /** Real event frames only — excludes comment lines (heartbeat, resume-not-durable). */
  private eventFrames(): string[] {
    return this.frames.filter((f) => f.startsWith('id: '));
  }

  /** Extracts the event ids that were actually written, in order. */
  ids(): string[] {
    return this.eventFrames().map((f) => f.split('\n')[0].slice('id: '.length));
  }

  /** Parses the JSON `data:` payload of each real event frame, in order. */
  events(): any[] {
    return this.eventFrames().map((f) => {
      const dataLine = f.split('\n').find((l) => l.startsWith('data: '))!;
      return JSON.parse(dataLine.slice('data: '.length));
    });
  }
}

async function makeConnectedHub(bus: FakeRedisBus, label = 'A') {
  const redis = new FakeRedisClient(bus, label);
  const hub = new RealtimeHub({ redis, heartbeatMs: 0, reconnectDelayMs: 5 });
  await hub.start();
  return hub;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  sseConnectedClientsGauge.set(0);
});

// ── Multi-instance fan-out ───────────────────────────────────────────────────

describe('RealtimeHub — multi-instance fan-out', () => {
  it('an event published on instance A is delivered to a client attached on instance B', async () => {
    const bus = new FakeRedisBus();
    const hubA = await makeConnectedHub(bus, 'A');
    const hubB = await makeConnectedHub(bus, 'B');

    const sinkB = new MockSink();
    await hubB.attachClient(sinkB);

    await hubA.publish({ eventType: 'BID_PLACED', listingId: 11n, data: {} });
    await flush();

    expect(sinkB.frames.some((f) => f.includes('BID_PLACED'))).toBe(true);

    await hubA.close();
    await hubB.close();
  });

  it('both instances deliver a single published event exactly once each', async () => {
    const bus = new FakeRedisBus();
    const hubA = await makeConnectedHub(bus, 'A');
    const hubB = await makeConnectedHub(bus, 'B');

    const sinkA = new MockSink();
    const sinkB = new MockSink();
    await hubA.attachClient(sinkA);
    await hubB.attachClient(sinkB);

    await hubA.publish({ eventType: 'ARTWORK_SOLD', listingId: 1n, data: {} });
    await flush();

    expect(sinkA.ids()).toHaveLength(1);
    expect(sinkB.ids()).toHaveLength(1);
    expect(sinkA.ids()).toEqual(sinkB.ids());

    await hubA.close();
    await hubB.close();
  });
});

// ── Durable resume ────────────────────────────────────────────────────────────

describe('RealtimeHub — resume via Last-Event-ID', () => {
  it('a reconnecting client receives exactly the missed events, in order, no duplicates', async () => {
    const bus = new FakeRedisBus();
    const hub = await makeConnectedHub(bus);

    const first = new MockSink();
    await hub.attachClient(first);

    await hub.publish({ eventType: 'E1', data: {} });
    await hub.publish({ eventType: 'E2', data: {} });
    await flush();
    const seenIds = first.ids();
    expect(seenIds).toHaveLength(2);

    // Client disconnects after seeing E1/E2
    hub.detachClient(first);

    await hub.publish({ eventType: 'E3', data: {} });
    await hub.publish({ eventType: 'E4', data: {} });

    // Reconnect with the last id it actually saw
    const resumed = new MockSink();
    await hub.attachClient(resumed, { lastEventId: seenIds[1] });

    expect(resumed.ids()).toHaveLength(2);
    expect(resumed.frames.join('')).toContain('E3');
    expect(resumed.frames.join('')).toContain('E4');
    expect(resumed.frames.join('')).not.toContain('"eventType":"E1"');
    expect(resumed.frames.join('')).not.toContain('"eventType":"E2"');

    await hub.close();
  });

  it('live events published during replay are appended after replay, deduplicated', async () => {
    const bus = new FakeRedisBus();
    const hub = await makeConnectedHub(bus);

    await hub.publish({ eventType: 'BEFORE', data: {} });
    const beforeId = bus.streams.get(hub.streamKey)![0].id;

    // Simulate a slow xRange that lets a live publish land mid-replay by
    // monkey-patching the client's xRange to publish first.
    const client = (hub as any).redis as FakeRedisClient;
    const originalXRange = client.xRange.bind(client);
    client.xRange = async (...args: Parameters<typeof originalXRange>) => {
      await hub.publish({ eventType: 'DURING', data: {} });
      return originalXRange(...args);
    };

    const sink = new MockSink();
    await hub.attachClient(sink, { lastEventId: beforeId });
    await flush();

    expect(sink.events().map((e) => e.eventType)).toEqual(['DURING']);

    await hub.close();
  });

  it('increments the replay-requests metric once per resumed connection', async () => {
    const bus = new FakeRedisBus();
    const hub = await makeConnectedHub(bus);
    const before = (await sseReplayRequestsTotal.get()).values.reduce((a, v) => a + v.value, 0);

    await hub.publish({ eventType: 'E', data: {} });
    const id = bus.streams.get(hub.streamKey)![0].id;
    await hub.attachClient(new MockSink(), { lastEventId: id });

    const after = (await sseReplayRequestsTotal.get()).values.reduce((a, v) => a + v.value, 0);
    expect(after - before).toBe(1);

    await hub.close();
  });

  it('an invalid lastEventId is treated as no resume (no replay attempted)', async () => {
    const bus = new FakeRedisBus();
    const hub = await makeConnectedHub(bus);
    await hub.publish({ eventType: 'PRE', data: {} });

    const sink = new MockSink();
    await hub.attachClient(sink, { lastEventId: 'not-an-id' });
    expect(sink.ids()).toHaveLength(0);

    await hub.close();
  });
});

// ── Redis outage / degraded mode ─────────────────────────────────────────────

describe('RealtimeHub — Redis outage mid-stream', () => {
  it('clients stay connected and live events still flow via the local fallback', async () => {
    const bus = new FakeRedisBus();
    const hub = await makeConnectedHub(bus);

    const sink = new MockSink();
    await hub.attachClient(sink);

    bus.down = true; // simulate outage
    await hub.publish({ eventType: 'DURING_OUTAGE', data: {} });
    await flush();

    expect(sink.ended).toBe(false);
    expect(sink.frames.some((f) => f.includes('DURING_OUTAGE'))).toBe(true);
    expect(hub.degraded).toBe(true);

    await hub.close();
  });

  it('increments the redis-publish-failures and degraded-fallback metrics', async () => {
    const bus = new FakeRedisBus();
    const hub = await makeConnectedHub(bus);
    const beforeFail = (await sseRedisPublishFailuresTotal.get()).values.reduce((a, v) => a + v.value, 0);
    const beforeDeg = (await sseDegradedFallbackTotal.get()).values.reduce((a, v) => a + v.value, 0);

    bus.down = true;
    await hub.publish({ eventType: 'X', data: {} });

    const afterFail = (await sseRedisPublishFailuresTotal.get()).values.reduce((a, v) => a + v.value, 0);
    const afterDeg = (await sseDegradedFallbackTotal.get()).values.reduce((a, v) => a + v.value, 0);
    expect(afterFail - beforeFail).toBe(1);
    expect(afterDeg - beforeDeg).toBe(1);

    await hub.close();
  });

  it('a client attached while the hub is known-degraded gets the resume-not-durable comment', async () => {
    const bus = new FakeRedisBus();
    const hub = await makeConnectedHub(bus);

    // A failed publish is how the hub discovers the outage and flips degraded.
    bus.down = true;
    await hub.publish({ eventType: 'TRIGGERS_DEGRADED', data: {} });
    expect(hub.degraded).toBe(true);

    const sink = new MockSink();
    await hub.attachClient(sink);

    expect(sink.frames.some((f) => f.includes('resume-not-durable'))).toBe(true);

    await hub.close();
  });

  it('recovery: a subsequent publish after Redis comes back uses the durable path again', async () => {
    const bus = new FakeRedisBus();
    const hub = await makeConnectedHub(bus);

    bus.down = true;
    await hub.publish({ eventType: 'DOWN', data: {} });
    expect(hub.degraded).toBe(true);

    bus.down = false;
    await hub.publish({ eventType: 'UP', data: {} });
    expect(hub.degraded).toBe(false);
    expect(bus.streams.get(hub.streamKey)!.some((e) => e.message.eventType === 'UP')).toBe(true);

    await hub.close();
  });

  it('permanent degraded mode (no redis client) delivers to local clients without throwing', async () => {
    const hub = new RealtimeHub({ redis: null, heartbeatMs: 0 });
    await hub.start(); // no-op, no redis
    const sink = new MockSink();
    await hub.attachClient(sink);

    await expect(hub.publish({ eventType: 'LOCAL_ONLY', data: {} })).resolves.not.toThrow();
    expect(sink.frames.some((f) => f.includes('LOCAL_ONLY'))).toBe(true);

    await hub.close();
  });
});

// ── Subscriber reconnect ──────────────────────────────────────────────────────

describe('RealtimeHub — subscriber reconnect loop', () => {
  it('reattaches and increments the reconnect metric after the subscriber connection ends', async () => {
    const bus = new FakeRedisBus();
    const redis = new FakeRedisClient(bus, 'A');
    const hub = new RealtimeHub({ redis, heartbeatMs: 0, reconnectDelayMs: 5 });
    await hub.start();

    const before = (await sseSubscriberReconnectsTotal.get()).values.reduce((a, v) => a + v.value, 0);

    // FakeRedisClient.on() is a no-op (doesn't emit 'end'), so the reconnect
    // path is triggered directly, as it would be by a real connection drop.
    (hub as any).scheduleResubscribe();

    await new Promise((r) => setTimeout(r, 30));

    const after = (await sseSubscriberReconnectsTotal.get()).values.reduce((a, v) => a + v.value, 0);
    expect(after - before).toBe(1);

    // Fan-out still works after the simulated reconnect
    const sink = new MockSink();
    await hub.attachClient(sink);
    await hub.publish({ eventType: 'AFTER_RECONNECT', data: {} });
    await flush();
    expect(sink.frames.some((f) => f.includes('AFTER_RECONNECT'))).toBe(true);

    await hub.close();
  });

  it('subscribe() failure schedules a retry rather than throwing', async () => {
    const bus = new FakeRedisBus();
    bus.down = true; // subscribe() rejects while down
    const redis = new FakeRedisClient(bus, 'A');
    const hub = new RealtimeHub({ redis, heartbeatMs: 0, reconnectDelayMs: 5 });

    await expect(hub.start()).resolves.not.toThrow();

    await hub.close();
  });
});

// ── Backpressure ───────────────────────────────────────────────────────────────

describe('RealtimeHub — slow-client backpressure', () => {
  it('caps the per-client queue and increments the drop counter instead of growing unboundedly', async () => {
    const bus = new FakeRedisBus();
    const hub = new RealtimeHub({ redis: new FakeRedisClient(bus), heartbeatMs: 0, clientQueueMax: 3 });
    await hub.start();

    const sink = new MockSink();
    sink.writeReturns = false; // socket buffer permanently full — nothing drains
    await hub.attachClient(sink);

    const before = (await sseEventsDroppedTotal.get()).values.reduce((a, v) => a + v.value, 0);

    for (let i = 0; i < 10; i++) {
      await hub.publish({ eventType: `E${i}`, data: {} });
    }
    await flush();

    const state = (hub as any).clients.get(sink);
    expect(state.queue.length).toBeLessThanOrEqual(3);

    const after = (await sseEventsDroppedTotal.get()).values.reduce((a, v) => a + v.value, 0);
    expect(after - before).toBeGreaterThan(0);

    await hub.close();
  });

  it('a client that throws on write is detached rather than crashing the hub', async () => {
    const bus = new FakeRedisBus();
    const hub = new RealtimeHub({ redis: new FakeRedisClient(bus), heartbeatMs: 0 });
    await hub.start();

    const sink = new MockSink();
    sink.write = () => { throw new Error('ECONNRESET'); };
    await hub.attachClient(sink);
    expect(hub.connectionCount).toBe(1);

    await expect(hub.publish({ eventType: 'E', data: {} })).resolves.not.toThrow();
    await flush();
    expect(hub.connectionCount).toBe(0);

    await hub.close();
  });
});

// ── Connection cap ────────────────────────────────────────────────────────────

describe('RealtimeHub — connection cap', () => {
  it('reports atCapacity once maxConnections clients are attached', async () => {
    const bus = new FakeRedisBus();
    const hub = new RealtimeHub({ redis: new FakeRedisClient(bus), heartbeatMs: 0, maxConnections: 2 });
    await hub.start();

    await hub.attachClient(new MockSink());
    expect(hub.atCapacity).toBe(false);
    await hub.attachClient(new MockSink());
    expect(hub.atCapacity).toBe(true);

    await hub.close();
  });
});

// ── Topic filtering ────────────────────────────────────────────────────────────

describe('RealtimeHub — topic filtering', () => {
  it('filters by eventType', async () => {
    const bus = new FakeRedisBus();
    const hub = new RealtimeHub({ redis: new FakeRedisClient(bus), heartbeatMs: 0 });
    await hub.start();

    const sink = new MockSink();
    await hub.attachClient(sink, { filter: { types: new Set(['BID_PLACED']) } });

    await hub.publish({ eventType: 'OFFER_MADE', data: {} });
    await hub.publish({ eventType: 'BID_PLACED', data: {} });
    await flush();

    expect(sink.events()).toHaveLength(1);
    expect(sink.events()[0].eventType).toBe('BID_PLACED');

    await hub.close();
  });

  it('filters by listingId', async () => {
    const bus = new FakeRedisBus();
    const hub = new RealtimeHub({ redis: new FakeRedisClient(bus), heartbeatMs: 0 });
    await hub.start();

    const sink = new MockSink();
    await hub.attachClient(sink, { filter: { listingId: '42' } });

    await hub.publish({ eventType: 'E', listingId: 7n, data: {} });
    await hub.publish({ eventType: 'E', listingId: 42n, data: {} });
    await flush();

    expect(sink.events()).toHaveLength(1);
    expect(sink.events()[0].listingId).toBe('42');

    await hub.close();
  });
});

// ── Heartbeat ─────────────────────────────────────────────────────────────────

describe('RealtimeHub — heartbeat cadence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits a heartbeat comment on the configured interval', async () => {
    const bus = new FakeRedisBus();
    const hub = new RealtimeHub({ redis: new FakeRedisClient(bus), heartbeatMs: 1000 });
    await hub.start();

    const sink = new MockSink();
    await hub.attachClient(sink);

    await vi.advanceTimersByTimeAsync(3500);

    const heartbeats = sink.frames.filter((f) => f.includes('heartbeat'));
    expect(heartbeats.length).toBe(3);

    await hub.close();
  });

  it('stops the heartbeat timer once the last client disconnects', async () => {
    const bus = new FakeRedisBus();
    const hub = new RealtimeHub({ redis: new FakeRedisClient(bus), heartbeatMs: 1000 });
    await hub.start();

    const sink = new MockSink();
    await hub.attachClient(sink);
    hub.detachClient(sink);

    expect((hub as any).heartbeatTimer).toBeNull();

    await hub.close();
  });
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────

describe('RealtimeHub — graceful shutdown', () => {
  it('close() ends every client stream and clears the client registry', async () => {
    const bus = new FakeRedisBus();
    const hub = new RealtimeHub({ redis: new FakeRedisClient(bus), heartbeatMs: 100 });
    await hub.start();

    const sinks = [new MockSink(), new MockSink(), new MockSink()];
    for (const s of sinks) await hub.attachClient(s);

    await hub.close();

    for (const s of sinks) expect(s.ended).toBe(true);
    expect(hub.connectionCount).toBe(0);
  });

  it('close() completes well within the 10s shutdown window', async () => {
    const bus = new FakeRedisBus();
    const hub = new RealtimeHub({ redis: new FakeRedisClient(bus), heartbeatMs: 100 });
    await hub.start();
    await hub.attachClient(new MockSink());

    const start = Date.now();
    await hub.close();
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('close() is idempotent', async () => {
    const bus = new FakeRedisBus();
    const hub = new RealtimeHub({ redis: new FakeRedisClient(bus), heartbeatMs: 0 });
    await hub.start();
    await expect(hub.close()).resolves.not.toThrow();
    await expect(hub.close()).resolves.not.toThrow();
  });
});

// ── Connected-clients gauge ────────────────────────────────────────────────────

describe('RealtimeHub — connected-clients gauge', () => {
  it('tracks attach/detach', async () => {
    const bus = new FakeRedisBus();
    const hub = new RealtimeHub({ redis: new FakeRedisClient(bus), heartbeatMs: 0 });
    await hub.start();

    const sink = new MockSink();
    await hub.attachClient(sink);
    let val = (await sseConnectedClientsGauge.get()).values[0].value;
    expect(val).toBe(1);

    hub.detachClient(sink);
    val = (await sseConnectedClientsGauge.get()).values[0].value;
    expect(val).toBe(0);

    await hub.close();
  });
});

// ── Delivered-events counter ───────────────────────────────────────────────────

describe('RealtimeHub — delivery metric', () => {
  it('increments sseEventsDeliveredTotal for each frame actually written', async () => {
    const bus = new FakeRedisBus();
    const hub = new RealtimeHub({ redis: new FakeRedisClient(bus), heartbeatMs: 0 });
    await hub.start();
    const sink = new MockSink();
    await hub.attachClient(sink);

    const before = (await sseEventsDeliveredTotal.get()).values.reduce((a, v) => a + v.value, 0);
    await hub.publish({ eventType: 'E1', data: {} });
    await hub.publish({ eventType: 'E2', data: {} });
    await flush();
    const after = (await sseEventsDeliveredTotal.get()).values.reduce((a, v) => a + v.value, 0);

    expect(after - before).toBe(2);
    await hub.close();
  });
});
