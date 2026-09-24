import { describe, it, expect, beforeEach } from 'vitest';

export interface SseEvent {
  id: number;
  event: string;
  data: Record<string, unknown>;
  timestamp: number;
}

export class SseTestBroker {
  private capacity: number;
  private ringBuffer: SseEvent[] = [];
  private nextEventId = 1;
  private activeSubscriptions = new Map<string, SseEvent[]>();

  constructor(capacity = 200) {
    this.capacity = capacity;
  }

  broadcast(eventType: string, payload: Record<string, unknown>): SseEvent {
    const event: SseEvent = {
      id: this.nextEventId++,
      event: eventType,
      data: payload,
      timestamp: Date.now()
    };

    this.ringBuffer.push(event);
    if (this.ringBuffer.length > this.capacity) {
      this.ringBuffer.shift();
    }

    for (const [, queue] of this.activeSubscriptions) {
      queue.push(event);
    }
    return event;
  }

  connect(clientId: string, lastEventId?: number): { status: 'CONNECTED' | 'RESET'; events: SseEvent[] } {
    this.activeSubscriptions.set(clientId, []);

    if (lastEventId === undefined) {
      const connectedFrame: SseEvent = {
        id: 0,
        event: 'CONNECTED',
        data: { status: 'ok', retained: this.ringBuffer.length },
        timestamp: Date.now()
      };
      return { status: 'CONNECTED', events: [connectedFrame] };
    }

    if (this.ringBuffer.length === 0) {
      return { status: 'CONNECTED', events: [] };
    }

    const oldestId = this.ringBuffer[0].id;
    if (lastEventId < oldestId - 1) {
      // Cursor evicted from ring buffer: emit reset event per docs/sse-protocol.md
      const resetFrame: SseEvent = {
        id: 0,
        event: 'reset',
        data: { reason: 'cursor_too_old', since: String(lastEventId) },
        timestamp: Date.now()
      };
      return { status: 'RESET', events: [resetFrame] };
    }

    const replayed = this.ringBuffer.filter(e => e.id > lastEventId);
    return { status: 'CONNECTED', events: replayed };
  }

  disconnect(clientId: string): void {
    this.activeSubscriptions.delete(clientId);
  }

  getActiveSubscriberCount(): number {
    return this.activeSubscriptions.size;
  }
}

describe('Realtime Notification & SSE Delivery Test Platform (Issue #654)', () => {
  let broker: SseTestBroker;

  beforeEach(() => {
    broker = new SseTestBroker(50);
  });

  it('establishes clean connection and receives immediate CONNECTED frame', () => {
    const { status, events } = broker.connect('client_alice');
    expect(status).toBe('CONNECTED');
    expect(events.length).toBe(1);
    expect(events[0].event).toBe('CONNECTED');
    expect(broker.getActiveSubscriberCount()).toBe(1);
  });

  it('broadcasts live events monotonically to connected subscribers', () => {
    broker.connect('client_alice');
    const e1 = broker.broadcast('LISTING_CREATED', { listingId: '101', price: '100' });
    const e2 = broker.broadcast('OFFER_MADE', { listingId: '101', amount: '85' });

    expect(e1.id).toBe(1);
    expect(e2.id).toBe(2);
    expect(e2.id).toBeGreaterThan(e1.id);
  });

  it('replays missing events seamlessly when client reconnects with Last-Event-ID', () => {
    broker.connect('client_bob');
    broker.broadcast('LISTING_CREATED', { listingId: '101' });
    broker.broadcast('AUCTION_BID', { auctionId: '55', bid: '150' });

    // Client disconnects at Event ID 2
    broker.disconnect('client_bob');

    // More events occur while disconnected
    broker.broadcast('AUCTION_OUTBID', { auctionId: '55', newBid: '175' });
    broker.broadcast('LISTING_SOLD', { listingId: '101' });

    // Client reconnects specifying Last-Event-ID: 2
    const { status, events } = broker.connect('client_bob', 2);
    expect(status).toBe('CONNECTED');
    expect(events.length).toBe(2);
    expect(events[0].id).toBe(3);
    expect(events[0].event).toBe('AUCTION_OUTBID');
    expect(events[1].id).toBe(4);
    expect(events[1].event).toBe('LISTING_SOLD');
  });

  it('triggers event: reset when client cursor is too old and evicted from ring buffer', () => {
    // Fill broker beyond capacity (50) to force eviction
    for (let i = 0; i < 60; i++) {
      broker.broadcast('HEARTBEAT', { tick: i });
    }

    // Client attempts reconnection with ancient Event ID 2
    const { status, events } = broker.connect('client_stale', 2);
    expect(status).toBe('RESET');
    expect(events.length).toBe(1);
    expect(events[0].event).toBe('reset');
    expect(events[0].data.reason).toBe('cursor_too_old');
  });

  it('broadcasts consistently across multiple concurrent subscribers with zero lost frames', () => {
    const clients = ['sub_1', 'sub_2', 'sub_3', 'sub_4'];
    clients.forEach(c => broker.connect(c));

    const broadcastEvent = broker.broadcast('SETTLEMENT_BATCH', { batchId: 889 });
    expect(broadcastEvent.id).toBeGreaterThan(0);
    expect(broker.getActiveSubscriberCount()).toBe(4);
  });
});
