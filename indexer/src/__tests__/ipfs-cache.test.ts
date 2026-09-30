/**
 * ipfs-cache.test.ts
 *
 * Vitest tests for the IPFS metadata caching module (Feature B + Issue #7).
 * Tests cover: queue idempotency, gateway fallback, 404 short-circuit,
 * content-hash computation (Issue #7), health metrics (Issue #7),
 * and processIpfsQueue batch processing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock axios ────────────────────────────────────────────────────────────────

const { mockAxiosGet } = vi.hoisted(() => ({
  mockAxiosGet: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    get: mockAxiosGet,
  },
  AxiosError: class AxiosError extends Error {
    response?: { status: number };
    constructor(msg: string, status?: number) {
      super(msg);
      if (status !== undefined) this.response = { status };
    }
  },
}));

// ── Mock Prisma ───────────────────────────────────────────────────────────────

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    ipfsMetadata: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    ipfsQueue: {
      findFirst: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../db.js', () => ({ default: mockPrisma }));

// ── Mock logger ───────────────────────────────────────────────────────────────

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Mock crypto (Node has it natively; keep as pass-through) ──────────────────
// No mock needed — Node's built-in crypto module is available in Vitest.

// ── Mock retry ────────────────────────────────────────────────────────────────

vi.mock('../retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../retry.js')>();
  return {
    ...actual,
    withIpfsRetry: async <T>(
      fn: () => Promise<T>,
      overrides?: Partial<typeof actual.IPFS_RETRY_CONFIG>
    ): Promise<T> => {
      const maxAttempts = overrides?.maxAttempts ?? actual.IPFS_RETRY_CONFIG.maxAttempts ?? 3;
      const retryable = overrides?.retryable ?? (() => true);
      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts!; attempt++) {
        try {
          return await fn();
        } catch (err) {
          lastErr = err;
          if (!retryable!(err)) throw err;
        }
      }
      throw lastErr;
    },
  };
});

import {
  enqueueIpfsFetch,
  fetchIpfsMetadata,
  processIpfsQueue,
  computeContentHash,
  getIpfsHealthCounters,
  resetIpfsHealthCounters,
} from '../ipfs-cache';

// ── computeContentHash (Issue #7) ─────────────────────────────────────────────

describe('computeContentHash', () => {
  it('returns a 64-character hex SHA-256 digest', () => {
    const hash = computeContentHash('{"title":"test"}');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', () => {
    const body = JSON.stringify({ title: 'Art', image: 'ipfs://QmABC' });
    expect(computeContentHash(body)).toBe(computeContentHash(body));
  });

  it('produces different hashes for different content', () => {
    const h1 = computeContentHash('{"title":"A"}');
    const h2 = computeContentHash('{"title":"B"}');
    expect(h1).not.toBe(h2);
  });
});

// ── enqueueIpfsFetch ──────────────────────────────────────────────────────────

describe('enqueueIpfsFetch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts a queue job when CID is not cached and not queued', async () => {
    mockPrisma.ipfsMetadata.findUnique.mockResolvedValue(null);
    mockPrisma.ipfsQueue.findFirst.mockResolvedValue(null);
    mockPrisma.ipfsQueue.create.mockResolvedValue({ id: 1, cid: 'abc123' });

    await enqueueIpfsFetch('abc123');

    expect(mockPrisma.ipfsQueue.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cid: 'abc123', status: 'pending' }),
      })
    );
  });

  it('is a no-op when CID is already cached in IpfsMetadata', async () => {
    mockPrisma.ipfsMetadata.findUnique.mockResolvedValue({ cid: 'abc123', title: 'Art' });

    await enqueueIpfsFetch('abc123');

    expect(mockPrisma.ipfsQueue.create).not.toHaveBeenCalled();
  });

  it('is a no-op when CID already has a pending queue entry', async () => {
    mockPrisma.ipfsMetadata.findUnique.mockResolvedValue(null);
    mockPrisma.ipfsQueue.findFirst.mockResolvedValue({ id: 5, cid: 'abc123', status: 'pending' });

    await enqueueIpfsFetch('abc123');

    expect(mockPrisma.ipfsQueue.create).not.toHaveBeenCalled();
  });

  it('is a no-op for an empty CID', async () => {
    await enqueueIpfsFetch('');
    expect(mockPrisma.ipfsMetadata.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.ipfsQueue.create).not.toHaveBeenCalled();
  });

  it('re-queues a previously failed job', async () => {
    mockPrisma.ipfsMetadata.findUnique.mockResolvedValue(null);
    mockPrisma.ipfsQueue.findFirst.mockResolvedValue(null);
    mockPrisma.ipfsQueue.create.mockResolvedValue({ id: 2, cid: 'abc123' });

    await enqueueIpfsFetch('abc123');

    expect(mockPrisma.ipfsQueue.create).toHaveBeenCalledTimes(1);
  });
});

// ── fetchIpfsMetadata ─────────────────────────────────────────────────────────

describe('fetchIpfsMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetIpfsHealthCounters();
  });

  it('returns metadata + contentHash + gatewayName on success', async () => {
    const mockBody = JSON.stringify({ title: 'My NFT', description: 'Cool art', image: 'ipfs://abc' });
    mockAxiosGet.mockResolvedValueOnce({ data: mockBody });

    const result = await fetchIpfsMetadata('abc123');

    expect(result.data).toEqual({ title: 'My NFT', description: 'Cool art', image: 'ipfs://abc' });
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.contentHash).toBe(computeContentHash(mockBody));
    expect(result.gatewayName).toBe('primary');
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
  });

  it('falls back to the fallback gateway when the primary fails', async () => {
    const mockBody = JSON.stringify({ title: 'Fallback Art' });
    mockAxiosGet
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ data: mockBody });

    const result = await fetchIpfsMetadata('cid456');
    expect(result.data).toEqual({ title: 'Fallback Art' });
    expect(result.gatewayName).toBe('fallback');
    expect(mockAxiosGet).toHaveBeenCalledTimes(4);
  });

  it('throws when both primary and fallback are exhausted', async () => {
    mockAxiosGet.mockRejectedValue(new Error('gateway unavailable'));

    await expect(fetchIpfsMetadata('bad-cid')).rejects.toThrow();
    expect(mockAxiosGet).toHaveBeenCalledTimes(5); // 3 primary + 2 fallback
  });

  it('does not retry a 404 on the same gateway', async () => {
    const { AxiosError } = await import('axios');
    const notFound = new (AxiosError as any)('Not Found', 404);

    mockAxiosGet
      .mockRejectedValueOnce(notFound)  // primary 404 → skip remaining primary
      .mockRejectedValueOnce(notFound); // fallback 404 → stop

    await expect(fetchIpfsMetadata('nonexistent')).rejects.toThrow();
    expect(mockAxiosGet).toHaveBeenCalledTimes(2);
  });

  it('throws on non-JSON body', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: '<html>Not JSON</html>' });
    await expect(fetchIpfsMetadata('html-cid')).rejects.toThrow(/non-JSON/);
  });

  // ── Health counter assertions (Issue #7) ──────────────────────────────────

  it('increments fetchSuccess counter on success', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: JSON.stringify({ title: 'T' }) });
    await fetchIpfsMetadata('cid1');
    expect(getIpfsHealthCounters().fetchSuccess).toBe(1);
  });

  it('increments fetchFailure counter when all gateways fail', async () => {
    mockAxiosGet.mockRejectedValue(new Error('down'));
    await expect(fetchIpfsMetadata('cid2')).rejects.toThrow();
    expect(getIpfsHealthCounters().fetchFailure).toBe(1);
  });

  it('increments fetch404 counter on 404 responses', async () => {
    const { AxiosError } = await import('axios');
    const notFound = new (AxiosError as any)('Not Found', 404);
    mockAxiosGet.mockRejectedValue(notFound);
    await expect(fetchIpfsMetadata('cid3')).rejects.toThrow();
    expect(getIpfsHealthCounters().fetch404).toBeGreaterThan(0);
  });

  it('tracks per-gateway success', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: JSON.stringify({ title: 'T' }) });
    await fetchIpfsMetadata('cid4');
    const c = getIpfsHealthCounters();
    expect(c.gatewaySuccesses['primary']).toBe(1);
  });

  it('tracks per-gateway latency', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: JSON.stringify({ title: 'T' }) });
    await fetchIpfsMetadata('cid5');
    const c = getIpfsHealthCounters();
    expect(c.gatewayLatencyMs['primary']).toBeGreaterThanOrEqual(0);
  });

  it('accumulates counters across multiple calls', async () => {
    mockAxiosGet
      .mockResolvedValueOnce({ data: JSON.stringify({ title: 'A' }) })
      .mockResolvedValueOnce({ data: JSON.stringify({ title: 'B' }) });
    await fetchIpfsMetadata('cid6');
    await fetchIpfsMetadata('cid7');
    expect(getIpfsHealthCounters().fetchSuccess).toBe(2);
    expect(getIpfsHealthCounters().gatewaySuccesses['primary']).toBe(2);
  });

  it('resetIpfsHealthCounters zeroes all fields', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: JSON.stringify({ title: 'T' }) });
    await fetchIpfsMetadata('cid8');
    resetIpfsHealthCounters();
    const c = getIpfsHealthCounters();
    expect(c.fetchSuccess).toBe(0);
    expect(c.fetchFailure).toBe(0);
    expect(c.fetch404).toBe(0);
    expect(c.gatewaySuccesses).toEqual({});
  });
});

// ── processIpfsQueue ──────────────────────────────────────────────────────────

describe('processIpfsQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetIpfsHealthCounters();
  });

  const pendingJob = {
    id: 1,
    cid: 'cid123',
    attempts: 0,
    status: 'pending',
    nextRetryAt: null,
    createdAt: new Date(),
  };

  it('fetches metadata, stores contentHash, and marks job as done on success', async () => {
    const mockMeta = { title: 'Success Art', description: 'Nice', image: 'ipfs://xyz' };
    mockPrisma.ipfsQueue.findMany.mockResolvedValue([pendingJob]);
    mockPrisma.ipfsQueue.update.mockResolvedValue({});
    mockPrisma.ipfsMetadata.upsert.mockResolvedValue({ cid: 'cid123', ...mockMeta });
    mockAxiosGet.mockResolvedValueOnce({ data: JSON.stringify(mockMeta) });

    const count = await processIpfsQueue();

    expect(count).toBe(1);
    // contentHash should be stored on upsert
    const upsertCall = mockPrisma.ipfsMetadata.upsert.mock.calls[0][0];
    expect(upsertCall.create.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(upsertCall.update.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // Same hash in create and update
    expect(upsertCall.create.contentHash).toBe(upsertCall.update.contentHash);
    // Final queue update marks done
    const lastUpdate = mockPrisma.ipfsQueue.update.mock.calls.at(-1)![0];
    expect(lastUpdate.data.status).toBe('done');
  });

  it('stores raw.image as imageUrl when image field is present', async () => {
    mockPrisma.ipfsQueue.findMany.mockResolvedValue([pendingJob]);
    mockPrisma.ipfsQueue.update.mockResolvedValue({});
    mockPrisma.ipfsMetadata.upsert.mockResolvedValue({});
    mockAxiosGet.mockResolvedValueOnce({
      data: JSON.stringify({ title: 'T', image: 'ipfs://QmABC', description: 'D' }),
    });

    await processIpfsQueue();

    const upsertCall = mockPrisma.ipfsMetadata.upsert.mock.calls[0][0];
    expect(upsertCall.create.imageUrl).toBe('ipfs://QmABC');
  });

  it('uses imageUrl field when image is absent', async () => {
    mockPrisma.ipfsQueue.findMany.mockResolvedValue([pendingJob]);
    mockPrisma.ipfsQueue.update.mockResolvedValue({});
    mockPrisma.ipfsMetadata.upsert.mockResolvedValue({});
    mockAxiosGet.mockResolvedValueOnce({
      data: JSON.stringify({ title: 'T', imageUrl: 'https://cdn.example.com/img.png' }),
    });

    await processIpfsQueue();

    const upsertCall = mockPrisma.ipfsMetadata.upsert.mock.calls[0][0];
    expect(upsertCall.create.imageUrl).toBe('https://cdn.example.com/img.png');
  });

  it('marks job as pending with nextRetryAt on transient failure', async () => {
    mockPrisma.ipfsQueue.findMany.mockResolvedValue([pendingJob]);
    mockPrisma.ipfsQueue.update.mockResolvedValue({});
    mockAxiosGet.mockRejectedValue(new Error('network error'));

    const count = await processIpfsQueue();

    expect(count).toBe(0);
    const lastUpdate = mockPrisma.ipfsQueue.update.mock.calls.at(-1)![0];
    expect(lastUpdate.data.status).toBe('pending');
    expect(lastUpdate.data.nextRetryAt).toBeInstanceOf(Date);
  });

  it('marks job as failed when MAX_TOTAL_ATTEMPTS is reached', async () => {
    const exhaustedJob = { ...pendingJob, attempts: 4 };
    mockPrisma.ipfsQueue.findMany.mockResolvedValue([exhaustedJob]);
    mockPrisma.ipfsQueue.update.mockResolvedValue({});
    mockAxiosGet.mockRejectedValue(new Error('still failing'));

    await processIpfsQueue();

    const lastUpdate = mockPrisma.ipfsQueue.update.mock.calls.at(-1)![0];
    expect(lastUpdate.data.status).toBe('failed');
    expect(lastUpdate.data.nextRetryAt).toBeNull();
  });

  it('returns 0 and makes no DB writes when queue is empty', async () => {
    mockPrisma.ipfsQueue.findMany.mockResolvedValue([]);

    const count = await processIpfsQueue();
    expect(count).toBe(0);
    expect(mockPrisma.ipfsQueue.update).not.toHaveBeenCalled();
  });

  it('processes multiple jobs in a batch', async () => {
    const jobs = [
      { ...pendingJob, id: 1, cid: 'cid1' },
      { ...pendingJob, id: 2, cid: 'cid2' },
    ];
    mockPrisma.ipfsQueue.findMany.mockResolvedValue(jobs);
    mockPrisma.ipfsQueue.update.mockResolvedValue({});
    mockPrisma.ipfsMetadata.upsert.mockResolvedValue({});
    mockAxiosGet
      .mockResolvedValueOnce({ data: JSON.stringify({ title: 'Art 1' }) })
      .mockResolvedValueOnce({ data: JSON.stringify({ title: 'Art 2' }) });

    const count = await processIpfsQueue(10);
    expect(count).toBe(2);
    expect(mockPrisma.ipfsMetadata.upsert).toHaveBeenCalledTimes(2);
  });

  it('content hash in processIpfsQueue matches manual compute', async () => {
    const body = JSON.stringify({ title: 'HashCheck', image: 'ipfs://QmXYZ' });
    mockPrisma.ipfsQueue.findMany.mockResolvedValue([pendingJob]);
    mockPrisma.ipfsQueue.update.mockResolvedValue({});
    mockPrisma.ipfsMetadata.upsert.mockResolvedValue({});
    mockAxiosGet.mockResolvedValueOnce({ data: body });

    await processIpfsQueue();

    const upsertCall = mockPrisma.ipfsMetadata.upsert.mock.calls[0][0];
    expect(upsertCall.create.contentHash).toBe(computeContentHash(body));
  });
});

// ── Mock axios ────────────────────────────────────────────────────────────────

const { mockAxiosGet } = vi.hoisted(() => ({
  mockAxiosGet: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { get: mockAxiosGet },
  AxiosError: class AxiosError extends Error {
    response?: { status: number };
    constructor(msg: string, status?: number) {
      super(msg);
      if (status !== undefined) this.response = { status };
    }
  },
}));

// ── Mock Prisma ───────────────────────────────────────────────────────────────

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    ipfsMetadata: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    ipfsQueue: {
      findFirst: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../db.js', () => ({ default: mockPrisma }));

// ── Mock logger ───────────────────────────────────────────────────────────────

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Mock retry ────────────────────────────────────────────────────────────────
// Replace withIpfsRetry with a thin shim that honours maxAttempts and retryable
// but uses zero delay so tests run fast and circuit-breaker state never leaks.

vi.mock('../retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../retry.js')>();
  return {
    ...actual,
    withIpfsRetry: async <T>(fn: () => Promise<T>, overrides?: Partial<typeof actual.IPFS_RETRY_CONFIG>): Promise<T> => {
      const maxAttempts = overrides?.maxAttempts ?? actual.IPFS_RETRY_CONFIG.maxAttempts ?? 3;
      const retryable   = overrides?.retryable   ?? (() => true);
      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts!; attempt++) {
        try {
          return await fn();
        } catch (err) {
          lastErr = err;
          if (!retryable!(err)) throw err;
        }
      }
      throw lastErr;
    },
  };
});

import {
  enqueueIpfsFetch,
  fetchIpfsMetadata,
  processIpfsQueue,
} from '../ipfs-cache';

// ── enqueueIpfsFetch ──────────────────────────────────────────────────────────

describe('enqueueIpfsFetch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts a queue job when CID is not cached and not queued', async () => {
    mockPrisma.ipfsMetadata.findUnique.mockResolvedValue(null);
    mockPrisma.ipfsQueue.findFirst.mockResolvedValue(null);
    mockPrisma.ipfsQueue.create.mockResolvedValue({ id: 1, cid: 'abc123' });

    await enqueueIpfsFetch('abc123');

    expect(mockPrisma.ipfsQueue.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cid: 'abc123', status: 'pending' }) })
    );
  });

  it('is a no-op when CID is already cached in IpfsMetadata', async () => {
    mockPrisma.ipfsMetadata.findUnique.mockResolvedValue({ cid: 'abc123', title: 'Art' });

    await enqueueIpfsFetch('abc123');

    expect(mockPrisma.ipfsQueue.create).not.toHaveBeenCalled();
  });

  it('is a no-op when CID already has a pending queue entry', async () => {
    mockPrisma.ipfsMetadata.findUnique.mockResolvedValue(null);
    mockPrisma.ipfsQueue.findFirst.mockResolvedValue({ id: 5, cid: 'abc123', status: 'pending' });

    await enqueueIpfsFetch('abc123');

    expect(mockPrisma.ipfsQueue.create).not.toHaveBeenCalled();
  });

  it('is a no-op for an empty CID', async () => {
    await enqueueIpfsFetch('');
    expect(mockPrisma.ipfsMetadata.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.ipfsQueue.create).not.toHaveBeenCalled();
  });

  it('re-queues a previously failed job (status=failed is not in the "already queued" filter)', async () => {
    mockPrisma.ipfsMetadata.findUnique.mockResolvedValue(null);
    // findFirst returns null because the filter excludes "failed" status
    mockPrisma.ipfsQueue.findFirst.mockResolvedValue(null);
    mockPrisma.ipfsQueue.create.mockResolvedValue({ id: 2, cid: 'abc123' });

    await enqueueIpfsFetch('abc123');

    expect(mockPrisma.ipfsQueue.create).toHaveBeenCalledTimes(1);
  });
});

// ── fetchIpfsMetadata ─────────────────────────────────────────────────────────

describe('fetchIpfsMetadata', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns metadata on a successful primary gateway response', async () => {
    const mockMeta = { title: 'My NFT', description: 'Cool art', image: 'ipfs://abc' };
    mockAxiosGet.mockResolvedValueOnce({ data: mockMeta });

    const result = await fetchIpfsMetadata('abc123');

    expect(result).toEqual(mockMeta);
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    // Should hit the primary gateway first
    expect(mockAxiosGet.mock.calls[0][0]).toContain('/ipfs/abc123');
  });

  it('falls back to the fallback gateway when the primary fails', async () => {
    const mockMeta = { title: 'Fallback Art' };
    // Primary fails 3 times, then fallback succeeds
    mockAxiosGet
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ data: mockMeta });

    const result = await fetchIpfsMetadata('cid456');
    expect(result).toEqual(mockMeta);
    // 3 primary attempts + 1 fallback attempt
    expect(mockAxiosGet).toHaveBeenCalledTimes(4);
    // The fallback URL should contain cloudflare-ipfs or the fallback domain
    expect(mockAxiosGet.mock.calls[3][0]).toContain('/ipfs/cid456');
  });

  it('throws when both primary and fallback are exhausted', async () => {
    mockAxiosGet.mockRejectedValue(new Error('gateway unavailable'));

    await expect(fetchIpfsMetadata('bad-cid')).rejects.toThrow();
    // MAX_PRIMARY_ATTEMPTS(3) + MAX_FALLBACK_ATTEMPTS(2) = 5
    expect(mockAxiosGet).toHaveBeenCalledTimes(5);
  });

  it('does not retry a 404 on the same gateway', async () => {
    const { AxiosError } = await import('axios');
    const notFound = new (AxiosError as any)('Not Found', 404);

    // Primary 404 immediately → skip remaining primary retries → fallback also 404
    mockAxiosGet
      .mockRejectedValueOnce(notFound)  // primary attempt 1 → 404 → stop primary
      .mockRejectedValueOnce(notFound); // fallback attempt 1 → 404 → stop fallback

    await expect(fetchIpfsMetadata('nonexistent')).rejects.toThrow();
    // Only 2 calls total: one per gateway (404 breaks inner retry loop)
    expect(mockAxiosGet).toHaveBeenCalledTimes(2);
  });
});

// ── processIpfsQueue ──────────────────────────────────────────────────────────

describe('processIpfsQueue', () => {
  beforeEach(() => vi.clearAllMocks());

  const pendingJob = { id: 1, cid: 'cid123', attempts: 0, status: 'pending', nextRetryAt: null, createdAt: new Date() };

  it('fetches metadata and marks job as done on success', async () => {
    const mockMeta = { title: 'Success Art', description: 'Nice', image: 'ipfs://xyz' };
    mockPrisma.ipfsQueue.findMany.mockResolvedValue([pendingJob]);
    mockPrisma.ipfsQueue.update.mockResolvedValue({});
    mockPrisma.ipfsMetadata.upsert.mockResolvedValue({ cid: 'cid123', ...mockMeta });
    mockAxiosGet.mockResolvedValueOnce({ data: mockMeta });

    const count = await processIpfsQueue();

    expect(count).toBe(1);
    expect(mockPrisma.ipfsMetadata.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { cid: 'cid123' } })
    );
    // Final update should mark status=done
    const lastUpdate = mockPrisma.ipfsQueue.update.mock.calls.at(-1)![0];
    expect(lastUpdate.data.status).toBe('done');
    expect(lastUpdate.data.attempts).toBe(1);
  });

  it('marks job as pending with incremented attempts and a nextRetryAt on fetch failure', async () => {
    mockPrisma.ipfsQueue.findMany.mockResolvedValue([pendingJob]);
    mockPrisma.ipfsQueue.update.mockResolvedValue({});
    mockAxiosGet.mockRejectedValue(new Error('network error'));

    const count = await processIpfsQueue();

    expect(count).toBe(0);
    // Last update = retry scheduling (not "processing" mark)
    const lastUpdate = mockPrisma.ipfsQueue.update.mock.calls.at(-1)![0];
    // attempts=1, total max=5, so not final → status stays 'pending'
    expect(lastUpdate.data.status).toBe('pending');
    expect(lastUpdate.data.nextRetryAt).toBeInstanceOf(Date);
  });

  it('marks job as failed when MAX_TOTAL_ATTEMPTS is reached', async () => {
    const exhaustedJob = { ...pendingJob, attempts: 4 }; // one more attempt = 5 = MAX
    mockPrisma.ipfsQueue.findMany.mockResolvedValue([exhaustedJob]);
    mockPrisma.ipfsQueue.update.mockResolvedValue({});
    mockAxiosGet.mockRejectedValue(new Error('still failing'));

    await processIpfsQueue();

    const lastUpdate = mockPrisma.ipfsQueue.update.mock.calls.at(-1)![0];
    expect(lastUpdate.data.status).toBe('failed');
    expect(lastUpdate.data.nextRetryAt).toBeNull();
  });

  it('returns 0 and makes no DB writes when queue is empty', async () => {
    mockPrisma.ipfsQueue.findMany.mockResolvedValue([]);

    const count = await processIpfsQueue();
    expect(count).toBe(0);
    expect(mockPrisma.ipfsQueue.update).not.toHaveBeenCalled();
  });

  it('processes multiple jobs in a batch', async () => {
    const jobs = [
      { ...pendingJob, id: 1, cid: 'cid1' },
      { ...pendingJob, id: 2, cid: 'cid2' },
    ];
    mockPrisma.ipfsQueue.findMany.mockResolvedValue(jobs);
    mockPrisma.ipfsQueue.update.mockResolvedValue({});
    mockPrisma.ipfsMetadata.upsert.mockResolvedValue({});
    mockAxiosGet
      .mockResolvedValueOnce({ data: { title: 'Art 1' } })
      .mockResolvedValueOnce({ data: { title: 'Art 2' } });

    const count = await processIpfsQueue(10);
    expect(count).toBe(2);
    expect(mockPrisma.ipfsMetadata.upsert).toHaveBeenCalledTimes(2);
  });

  it('stores raw.image as imageUrl when image field present', async () => {
    mockPrisma.ipfsQueue.findMany.mockResolvedValue([pendingJob]);
    mockPrisma.ipfsQueue.update.mockResolvedValue({});
    mockPrisma.ipfsMetadata.upsert.mockResolvedValue({});
    mockAxiosGet.mockResolvedValueOnce({
      data: { title: 'T', image: 'ipfs://QmABC', description: 'D' },
    });

    await processIpfsQueue();

    const upsertCall = mockPrisma.ipfsMetadata.upsert.mock.calls[0][0];
    expect(upsertCall.create.imageUrl).toBe('ipfs://QmABC');
  });

  it('uses imageUrl field when image is absent', async () => {
    mockPrisma.ipfsQueue.findMany.mockResolvedValue([pendingJob]);
    mockPrisma.ipfsQueue.update.mockResolvedValue({});
    mockPrisma.ipfsMetadata.upsert.mockResolvedValue({});
    mockAxiosGet.mockResolvedValueOnce({
      data: { title: 'T', imageUrl: 'https://cdn.example.com/img.png' },
    });

    await processIpfsQueue();

    const upsertCall = mockPrisma.ipfsMetadata.upsert.mock.calls[0][0];
    expect(upsertCall.create.imageUrl).toBe('https://cdn.example.com/img.png');
  });
});
