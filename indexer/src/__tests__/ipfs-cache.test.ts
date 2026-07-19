/**
 * ipfs-cache.test.ts
 *
 * Vitest tests for the IPFS metadata caching module (Feature B).
 * Pinata/gateway HTTP calls are mocked with vi.mock so no real network
 * requests are made.  Prisma is mocked to avoid a live database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
