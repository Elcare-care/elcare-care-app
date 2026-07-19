/**
 * ipfs-cache.ts
 *
 * Background IPFS metadata fetch job for ELCARE-HUB.
 *
 * After a LISTING_CREATED event is indexed, callers invoke `enqueueIpfsFetch`
 * to insert a job into the IpfsQueue table.  The `processIpfsQueue` worker
 * runs periodically and fetches metadata from IPFS, storing the result in the
 * IpfsMetadata table.
 *
 * Gateway strategy:
 *   1. Try PINATA_GATEWAY (primary) up to MAX_PRIMARY_ATTEMPTS times with
 *      exponential back-off.
 *   2. On exhaustion, fall through to PINATA_FALLBACK_GATEWAY (default:
 *      cloudflare-ipfs.com) for up to MAX_FALLBACK_ATTEMPTS.
 *   3. If both fail, the job is marked "failed" and will not be retried.
 */

import axios, { AxiosError } from 'axios';
import prisma from './db.js';
import { logger } from './logger.js';
import { Prisma } from '@prisma/client';

// ── Configuration ─────────────────────────────────────────────────────────────

const PRIMARY_GATEWAY =
  (process.env.PINATA_GATEWAY ?? 'https://gateway.pinata.cloud').replace(/\/$/, '');

const FALLBACK_GATEWAY =
  (process.env.PINATA_FALLBACK_GATEWAY ?? 'https://cloudflare-ipfs.com').replace(/\/$/, '');

const MAX_PRIMARY_ATTEMPTS = 3;
const MAX_FALLBACK_ATTEMPTS = 2;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;

/** Maximum consecutive total attempts before a job is marked "failed". */
const MAX_TOTAL_ATTEMPTS = MAX_PRIMARY_ATTEMPTS + MAX_FALLBACK_ATTEMPTS;

// ── Public types ──────────────────────────────────────────────────────────────

export interface IpfsArtworkMetadata {
  title?: string;
  description?: string;
  image?: string;
  imageUrl?: string;
  attributes?: unknown;
  [key: string]: unknown;
}

// ── Queue management ──────────────────────────────────────────────────────────

/**
 * Enqueues a CID for background IPFS fetching.
 * Idempotent — if the CID is already cached or already queued, this is a no-op.
 */
export async function enqueueIpfsFetch(cid: string): Promise<void> {
  if (!cid) return;

  // Skip if already cached
  const existing = await prisma.ipfsMetadata.findUnique({ where: { cid } });
  if (existing) return;

  // Skip if already queued and not failed
  const inQueue = await prisma.ipfsQueue.findFirst({
    where: { cid, status: { in: ['pending', 'processing', 'done'] } },
  });
  if (inQueue) return;

  await prisma.ipfsQueue.create({
    data: { cid, status: 'pending' },
  });

  logger.info('[IpfsCache] Enqueued IPFS fetch', { cid });
}

// ── Gateway fetch ─────────────────────────────────────────────────────────────

function gatewayUrl(gateway: string, cid: string): string {
  return `${gateway}/ipfs/${cid}`;
}

async function fetchFromGateway(url: string): Promise<IpfsArtworkMetadata> {
  const res = await axios.get<IpfsArtworkMetadata>(url, {
    timeout: FETCH_TIMEOUT_MS,
    headers: { Accept: 'application/json' },
  });
  return res.data;
}

function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
}

/**
 * Attempts to fetch metadata for `cid` using the primary gateway first,
 * then the fallback.  Returns the parsed metadata on success.
 * Throws if all attempts on both gateways are exhausted.
 */
export async function fetchIpfsMetadata(cid: string): Promise<IpfsArtworkMetadata> {
  const gateways = [
    { name: 'primary', url: gatewayUrl(PRIMARY_GATEWAY, cid), maxAttempts: MAX_PRIMARY_ATTEMPTS },
    { name: 'fallback', url: gatewayUrl(FALLBACK_GATEWAY, cid), maxAttempts: MAX_FALLBACK_ATTEMPTS },
  ];

  let lastError: unknown;

  for (const gw of gateways) {
    for (let attempt = 1; attempt <= gw.maxAttempts; attempt++) {
      try {
        const data = await fetchFromGateway(gw.url);
        logger.info('[IpfsCache] Fetched metadata', { cid, gateway: gw.name, attempt });
        return data;
      } catch (err) {
        lastError = err;
        const status = (err as AxiosError)?.response?.status;
        logger.warn('[IpfsCache] Fetch attempt failed', {
          cid, gateway: gw.name, attempt, status,
          error: err instanceof Error ? err.message : String(err),
        });

        // Don't retry on 404 — the content doesn't exist on this gateway
        if (status === 404) break;

        if (attempt < gw.maxAttempts) {
          await new Promise((r) => setTimeout(r, backoffMs(attempt)));
        }
      }
    }
  }

  throw lastError;
}

// ── Job processor ─────────────────────────────────────────────────────────────

/**
 * Processes one batch of pending IPFS queue jobs.
 * Called by a periodic timer in the indexer's main loop.
 * Returns the number of jobs that were successfully fetched.
 */
export async function processIpfsQueue(batchSize = 10): Promise<number> {
  const now = new Date();

  // Claim a batch of jobs that are ready to run
  const jobs = await prisma.ipfsQueue.findMany({
    where: {
      status: 'pending',
      OR: [
        { nextRetryAt: null },
        { nextRetryAt: { lte: now } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
  });

  if (jobs.length === 0) return 0;

  let successCount = 0;

  for (const job of jobs) {
    // Mark as processing to prevent double-pick in concurrent workers
    await prisma.ipfsQueue.update({
      where: { id: job.id },
      data: { status: 'processing' },
    });

    const attempts = job.attempts + 1;

    try {
      const raw = await fetchIpfsMetadata(job.cid);

      // Persist into IpfsMetadata (upsert so re-runs are safe)
      await prisma.ipfsMetadata.upsert({
        where: { cid: job.cid },
        create: {
          cid: job.cid,
          title: typeof raw.title === 'string' ? raw.title : undefined,
          description: typeof raw.description === 'string' ? raw.description : undefined,
          imageUrl: typeof raw.image === 'string'
            ? raw.image
            : typeof raw.imageUrl === 'string'
              ? raw.imageUrl
              : undefined,
          attributes: raw.attributes != null ? (raw.attributes as Prisma.InputJsonValue) : Prisma.JsonNull,
          raw: raw as Prisma.InputJsonValue,
        },
        update: {
          title: typeof raw.title === 'string' ? raw.title : undefined,
          description: typeof raw.description === 'string' ? raw.description : undefined,
          imageUrl: typeof raw.image === 'string'
            ? raw.image
            : typeof raw.imageUrl === 'string'
              ? raw.imageUrl
              : undefined,
          attributes: raw.attributes != null ? (raw.attributes as Prisma.InputJsonValue) : Prisma.JsonNull,
          fetchedAt: new Date(),
          raw: raw as Prisma.InputJsonValue,
        },
      });

      await prisma.ipfsQueue.update({
        where: { id: job.id },
        data: { status: 'done', attempts },
      });

      logger.info('[IpfsCache] Job completed', { cid: job.cid, jobId: job.id });
      successCount++;
    } catch (err) {
      const isFinal = attempts >= MAX_TOTAL_ATTEMPTS;
      const nextRetryAt = isFinal
        ? null
        : new Date(Date.now() + backoffMs(attempts));

      await prisma.ipfsQueue.update({
        where: { id: job.id },
        data: {
          status: isFinal ? 'failed' : 'pending',
          attempts,
          nextRetryAt,
        },
      });

      logger.error('[IpfsCache] Job failed', {
        cid: job.cid,
        jobId: job.id,
        attempts,
        isFinal,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return successCount;
}
