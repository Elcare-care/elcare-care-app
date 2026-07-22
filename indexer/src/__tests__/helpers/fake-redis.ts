/**
 * In-memory substitute for the subset of the node-redis v4 API the realtime
 * hub uses (XADD/XRANGE + pub/sub + duplicate()). Multiple FakeRedisClient
 * instances created from the same FakeRedisBus share stream and channel
 * state, which is what lets tests simulate two independent API replicas
 * talking through "the same Redis".
 */

type SubscribeCallback = (message: string, channel: string) => void;

interface StreamEntry {
  id: string;
  message: Record<string, string>;
}

export class FakeRedisBus {
  streams = new Map<string, StreamEntry[]>();
  subscribers = new Map<string, Set<SubscribeCallback>>();
  private msCounter = Date.now();
  private seqCounter = 0;
  down = false; // simulate an outage: XADD/PUBLISH/xRange all reject

  nextId(): string {
    const ms = this.msCounter;
    this.seqCounter += 1;
    return `${ms}-${this.seqCounter}`;
  }
}

export class FakeRedisClient {
  isOpen = true;
  isReady = true;
  private mySubs = new Set<string>();

  constructor(private bus: FakeRedisBus, public label = 'client') {}

  async connect(): Promise<void> {
    this.isOpen = true;
    this.isReady = true;
  }

  duplicate(): FakeRedisClient {
    return new FakeRedisClient(this.bus, `${this.label}:sub`);
  }

  async xAdd(
    key: string,
    _id: '*',
    fields: Record<string, string>,
    opts?: { TRIM?: { strategy: 'MAXLEN'; strategyModifier: string; threshold: number } },
  ): Promise<string> {
    if (this.bus.down) throw new Error('FakeRedis: connection down');
    const id = this.bus.nextId();
    const list = this.bus.streams.get(key) ?? [];
    list.push({ id, message: fields });
    if (opts?.TRIM?.threshold) {
      while (list.length > opts.TRIM.threshold) list.shift();
    }
    this.bus.streams.set(key, list);
    return id;
  }

  async xRange(
    key: string,
    start: string,
    _end: '+',
    opts?: { COUNT?: number },
  ): Promise<StreamEntry[]> {
    if (this.bus.down) throw new Error('FakeRedis: connection down');
    const list = this.bus.streams.get(key) ?? [];
    let filtered: StreamEntry[];
    if (start === '-') {
      filtered = list;
    } else if (start.startsWith('(')) {
      const exclusiveId = start.slice(1);
      filtered = list.filter((e) => compareIds(e.id, exclusiveId) > 0);
    } else {
      filtered = list.filter((e) => compareIds(e.id, start) >= 0);
    }
    return opts?.COUNT ? filtered.slice(0, opts.COUNT) : filtered;
  }

  async publish(channel: string, message: string): Promise<number> {
    if (this.bus.down) throw new Error('FakeRedis: connection down');
    const subs = this.bus.subscribers.get(channel);
    if (!subs) return 0;
    for (const cb of subs) cb(message, channel);
    return subs.size;
  }

  async subscribe(channel: string, cb: SubscribeCallback): Promise<void> {
    if (this.bus.down) throw new Error('FakeRedis: connection down');
    let subs = this.bus.subscribers.get(channel);
    if (!subs) {
      subs = new Set();
      this.bus.subscribers.set(channel, subs);
    }
    subs.add(cb);
    this.mySubs.add(channel);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.bus.subscribers.get(channel)?.clear();
    this.mySubs.delete(channel);
  }

  async disconnect(): Promise<void> {
    this.isOpen = false;
    this.isReady = false;
  }

  async quit(): Promise<void> {
    await this.disconnect();
  }

  on(): void {
    /* no-op: FakeRedisClient never emits 'error'/'end' on its own */
  }
}

function compareIds(a: string, b: string): number {
  const [ams, aseq] = a.split('-').map(Number);
  const [bms, bseq] = b.split('-').map(Number);
  return ams - bms || aseq - bseq;
}
