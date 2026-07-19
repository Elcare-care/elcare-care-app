import { rpc, Contract, TransactionBuilder, BASE_FEE, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import prisma from './db.js';
import { emitSSEEvent } from './api/routes.js';
import dotenv from 'dotenv';
import {
  latestLedgerProcessedGauge,
  networkLatestLedgerGauge,
  syncLatencyGauge,
  gapsCreatedTotal,
  openGapsGauge,
  openGapLedgersTotalGauge,
  duplicateEventsCounter,
} from './metrics.js';
import { recordProgress } from './stall.js';
import { collectMarketplaceEvents, sortDecodedEvents, MAX_LEDGER_WINDOW } from './event-sync.js';
import { withRetry } from './retry.js';
import { logger } from './logger.js';
import redis from './redis.js';
import { loadConfig } from './config.js';

dotenv.config();

const RPC_URL = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = process.env.MARKETPLACE_CONTRACT_ID || '';
const LAUNCHPAD_CONTRACT_ID = process.env.LAUNCHPAD_CONTRACT_ID || '';

export const MAX_REORG_DEPTH = 100;

// ── LedgerGap persistence ─────────────────────────────────────────────────────

export type LedgerGapSource = 'rpc_window_skip' | 'reorg' | 'manual';

/**
 * Upsert a LedgerGap row for a skipped ledger range.
 *
 * Uses a unique index on (fromLedger, toLedger, source) so repeated calls for
 * the same range are idempotent — the poller may re-enter the same code path
 * after a restart before the gap is repaired.
 *
 * Also refreshes the open-gap gauge so Prometheus always reflects current state.
 */
export async function persistLedgerGap(
  from: number,
  to: number,
  source: LedgerGapSource,
): Promise<void> {
  try {
    await prisma.ledgerGap.upsert({
      where: {
        fromLedger_toLedger_source: { fromLedger: from, toLedger: to, source },
      },
      create: { fromLedger: from, toLedger: to, source, status: 'Open' },
      update: {}, // already exists — leave status/error untouched
    });

    gapsCreatedTotal.inc({ source });

    // Refresh open-gap gauges asynchronously (best-effort, non-blocking)
    prisma.ledgerGap
      .findMany({ where: { status: 'Open' }, select: { fromLedger: true, toLedger: true } })
      .then((gaps) => {
        openGapsGauge.set(gaps.length);
        const total = gaps.reduce((acc, g) => acc + (g.toLedger - g.fromLedger + 1), 0);
        openGapLedgersTotalGauge.set(total);
      })
      .catch(() => {/* non-fatal */});

    logger.info('poller: persisted ledger gap', { from, to, source });
  } catch (err) {
    // Non-fatal: gap persistence must never crash the poller
    logger.error('poller: failed to persist ledger gap', {
      from, to, source,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// Retry back-off base in ms; doubles on each consecutive failure up to MAX_BACKOFF_MS.
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;

let consecutiveErrors = 0;

// Graceful shutdown coordination
let shuttingDown = false;
let shutdownStarted = false;
const shutdownHooks: Array<() => Promise<void>> = [];

/** Register an async cleanup function to run during graceful shutdown. */
export function registerShutdownHook(fn: () => Promise<void>): void {
  shutdownHooks.push(fn);
}

function getContractIds(): string[] {
  return [CONTRACT_ID, LAUNCHPAD_CONTRACT_ID].filter(Boolean);
}

function updateSyncMetrics(processedLedger: number, networkLatestLedger: number) {
  latestLedgerProcessedGauge.set(processedLedger);
  networkLatestLedgerGauge.set(networkLatestLedger);
  syncLatencyGauge.set(Math.max(0, networkLatestLedger - processedLedger));
}

function setupSignalHandlers() {
  const onSignal = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutdown signal received', { signal: sig });
    // Start async cleanup; don't await here since signals may be re-delivered
    gracefulShutdown().catch((err) => {
      logger.error('Graceful shutdown failed', { err });
      process.exit(1);
    });
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}

export async function gracefulShutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;

  console.log('[Shutdown] Closing resources: Prisma + Redis + registered hooks');
  const cleanup = Promise.allSettled([
    prisma.$disconnect(),
    (redis && typeof redis.disconnect === 'function') ? redis.disconnect() : Promise.resolve(),
    ...shutdownHooks.map((fn) => fn()),
  ]);

  try {
    await Promise.race([
      cleanup,
      new Promise((_, rej) => setTimeout(() => rej(new Error('shutdown timeout')), 10_000)),
    ]);
    logger.info('Shutdown: cleanup complete');
    process.exit(0);
  } catch (err) {
    logger.error('Shutdown: cleanup timed out', { err });
    process.exit(1);
  }
}

// Register handlers immediately so any external SIGTERM/SIGINT will be caught
setupSignalHandlers();

const server = new rpc.Server(RPC_URL);

/**
 * Rolls the database back to `safeAtLedger` by deleting all events and
 * listings that were written past that ledger, then resets SyncState.
 * Called when a chain re-org is detected.
 */
export async function revertLedgers(safeAtLedger: number): Promise<void> {
  logger.warn('Reorg: rolling back', { safeAtLedger });
  await prisma.$transaction(async (tx) => {
    // Remove events that occurred after the safe checkpoint
    await tx.marketplaceEvent.deleteMany({
      where: { ledgerSequence: { gt: safeAtLedger } },
    });

    // Remove per-event history rows written past the safe checkpoint
    await tx.bid.deleteMany({
      where: { ledgerSequence: { gt: safeAtLedger } },
    });
    await tx.priceHistory.deleteMany({
      where: { ledgerSequence: { gt: safeAtLedger } },
    });
    await tx.protocolFee.deleteMany({
      where: { ledgerSequence: { gt: safeAtLedger } },
    });

    // Remove listings that were first created after the safe checkpoint
    await tx.listing.deleteMany({
      where: { createdAtLedger: { gt: safeAtLedger } },
    });

    // Revert listings whose status changed after the safe checkpoint back to Active
    await tx.listing.updateMany({
      where: { updatedAtLedger: { gt: safeAtLedger } },
      data: { status: 'Active' as const, updatedAtLedger: safeAtLedger },
    });

    // Reset collections deployed after the safe checkpoint
    await tx.collection.deleteMany({
      where: { deployedAtLedger: { gt: safeAtLedger } },
    });

    // Reset the sync cursor
    await tx.syncState.update({
      where: { id: 1 },
      data: { lastLedger: safeAtLedger, lastLedgerHash: null },
    });
  });
  logger.info('Reorg: rollback complete', { resumeFromLedger: safeAtLedger + 1 });
}

/** SyncState fields for a ledger advance; omits hash when fetch failed so we keep the prior checkpoint. */
export function buildSyncStateLedgerData(
  lastLedger: number,
  ledgerHash: string | null
): { lastLedger: number; lastLedgerHash?: string } {
  if (ledgerHash !== null) {
    return { lastLedger, lastLedgerHash: ledgerHash };
  }
  return { lastLedger };
}

/**
 * Walks back from `divergedAt` up to MAX_REORG_DEPTH ledgers to find the
 * deepest ledger still accessible on the network's canonical chain.
 * Returns that ledger's sequence number as the safe revert point.
 */
export async function findReorgSafePoint(
  divergedAt: number,
  rpcServer: rpc.Server
): Promise<number> {
  for (let depth = 1; depth <= MAX_REORG_DEPTH; depth++) {
    const candidate = divergedAt - depth;
    if (candidate <= 0) return 0;
    try {
      const res = await rpcServer.getLedgers({
        startLedger: candidate,
        pagination: { limit: 1 },
      });
      if (res.ledgers && res.ledgers.length > 0) {
        return candidate;
      }
    } catch {
      // Ledger not accessible at this depth; keep walking back
    }
  }
  return Math.max(0, divergedAt - MAX_REORG_DEPTH);
}

export async function validateHashContinuity(
  syncState: { lastLedger: number; lastLedgerHash: string | null },
  rpcServer: rpc.Server
): Promise<boolean> {
  // No stored hash (initial sync or prior hash fetch failure) — cannot detect re-org.
  if (syncState.lastLedger > 0 && syncState.lastLedgerHash) {
    try {
      const ledgersRes = await rpcServer.getLedgers({
        startLedger: syncState.lastLedger,
        pagination: { limit: 1 }
      });
      if (ledgersRes.ledgers && ledgersRes.ledgers.length > 0) {
        const networkLedger = ledgersRes.ledgers[0];
        if (networkLedger.hash !== syncState.lastLedgerHash) {
          console.warn(`Chain re-org detected at ledger ${syncState.lastLedger}! DB hash: ${syncState.lastLedgerHash}, Network hash: ${networkLedger.hash}`);
          const safeLedger = await findReorgSafePoint(syncState.lastLedger, rpcServer);
          await revertLedgers(safeLedger);
          return false;
        }
      }
    } catch (err) {
      logger.error('Hash continuity check failed', { ledger: syncState.lastLedger, err });
    }
  }
  return true;
}

export async function startPolling() {
  const config = loadConfig(); // Validates at startup; throws on invalid env values
  const contractIds = getContractIds();
  if (contractIds.length === 0) {
    throw new Error('At least one of MARKETPLACE_CONTRACT_ID or LAUNCHPAD_CONTRACT_ID must be set');
  }

  console.log(`Starting indexer poller for contract(s): ${contractIds.join(', ')} (pollIntervalMs=${config.pollIntervalMs}, maxLedgersPerCycle=${config.maxLedgersPerCycle})`);

  while (!shuttingDown) {
    try {
      // 1. Get last indexed ledger — upsert avoids a unique-constraint violation
      //    when two instances start simultaneously (race between findUnique + create).
      let syncState = await prisma.syncState.upsert({
        where: { id: 1 },
        create: { id: 1, lastLedger: 0, lastLedgerHash: null },
        update: {},
      });

      // 2. Validate hash continuity on every poll
      const isContinuous = await validateHashContinuity(syncState, server);
      if (!isContinuous) {
        continue; // Restart the loop immediately with the reverted state
      }

      // 3. Resolve start ledger, clamping to the safe RPC window on every poll
      let networkLatestLedger: number;
      networkLatestLedger = await withRetry(
        () => server.getLatestLedger().then((r) => r.sequence),
        { operation: 'getLatestLedger', maxAttempts: 5, baseDelayMs: 1_000 }
      );

      networkLatestLedgerGauge.set(networkLatestLedger);

      if (syncState.lastLedger > 0 && networkLatestLedger < syncState.lastLedger) {
        logger.warn('Network latest ledger moved behind indexed state', {
          indexedLedger: syncState.lastLedger,
          networkLatestLedger,
        });
        // Persist the gap caused by the reorg before reverting
        await persistLedgerGap(networkLatestLedger + 1, syncState.lastLedger, 'reorg');
        await revertLedgers(networkLatestLedger);
        continue;
      }

      const windowFloor = networkLatestLedger - MAX_LEDGER_WINDOW;
      let startLedger = syncState.lastLedger + 1;
      let skippedRange: { from: number; to: number } | null = null;
      if (startLedger < windowFloor) {
        skippedRange = { from: startLedger, to: windowFloor - 1 };
        logger.warn('Skipping ledger gap outside the live RPC window', {
          skippedRange,
          windowFloor,
          networkLatest: networkLatestLedger,
        });
        startLedger = windowFloor;
        // Persist the reset so future polls don't re-request the stale range.
        const resetState = await prisma.syncState.update({
          where: { id: 1 },
          data: { lastLedger: windowFloor - 1, lastLedgerHash: null },
        });

        syncState = resetState;

        // Persist gap so the repair worker can back-fill the skipped range.
        await persistLedgerGap(skippedRange.from, skippedRange.to, 'rpc_window_skip');
      }
      // Cap how many ledgers we process per cycle to bound catch-up batch size.
      const batchEndLedger = Math.min(networkLatestLedger, startLedger + config.maxLedgersPerCycle - 1);
      const decodedEvents = await collectMarketplaceEvents(server, contractIds, startLedger, batchEndLedger);

      let latestHash: string | null = null;
      if (decodedEvents.length > 0) {
        const maxLedger = Math.max(...decodedEvents.map((event) => event.ledgerSequence));
        try {
          const ledgersRes = await server.getLedgers({
            startLedger: maxLedger,
            pagination: { limit: 1 },
          });
          if (ledgersRes.ledgers && ledgersRes.ledgers.length > 0) {
            latestHash = ledgersRes.ledgers[0].hash;
          }
        } catch (err) {
          logger.error('Failed to fetch hash for ledger', { ledger: maxLedger, err });
        }

        const { updatedState, newEvents } = await prisma.$transaction(async (tx) => {
          const toInsert = await applyDecodedEvents(decodedEvents, tx);
          const updated = await tx.syncState.update({
            where: { id: 1 },
            data: buildSyncStateLedgerData(maxLedger, latestHash),
          });

          return { updatedState: updated, newEvents: toInsert };
        });

        updateSyncMetrics(updatedState.lastLedger, networkLatestLedger);
        recordProgress();

        for (const ev of newEvents) emitSSEEvent(ev);
      } else if (batchEndLedger > syncState.lastLedger) {
        try {
          const ledgersRes = await server.getLedgers({
            startLedger: batchEndLedger,
            pagination: { limit: 1 },
          });
          if (ledgersRes.ledgers && ledgersRes.ledgers.length > 0) {
            latestHash = ledgersRes.ledgers[0].hash;
          }
        } catch (err) {
          console.error(`Failed to fetch hash for ledger ${batchEndLedger}:`, err);
        }

        const updatedState = await prisma.syncState.update({
          where: { id: 1 },
          data: buildSyncStateLedgerData(batchEndLedger, latestHash),
        });

        updateSyncMetrics(updatedState.lastLedger, networkLatestLedger);
        recordProgress();
      } else {
        updateSyncMetrics(syncState.lastLedger, networkLatestLedger);
      }

      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      const backoff = Math.min(
        BASE_BACKOFF_MS * Math.pow(2, consecutiveErrors - 1),
        MAX_BACKOFF_MS
      );
      logger.error('Error in polling loop', {
        consecutiveErrors,
        backoffMs: backoff,
        err: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      await new Promise((resolve) => setTimeout(resolve, backoff));
      continue;
    }

    consecutiveErrors = 0;
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }

  if (shuttingDown) {
    await gracefulShutdown();
  }
}

async function fetchListingFromChain(_listingId: bigint): Promise<any | null> {
  return null;
}

async function fetchAuctionFromChain(_auctionId: bigint): Promise<any | null> {
  return null;
}

/** Resolves the globally unique identity of a decoded event (RPC id preferred). */
function resolveEventId(event: any): string {
  return event.eventId || event.eventHash || '';
}

export async function applyDecodedEvents(decodedEvents: any[], tx: any) {
  if (decodedEvents.length === 0) return [];

  // Deterministic application order: (ledgerSequence, txIndex, eventIndex).
  // State reducers below are last-write-wins, so out-of-order application
  // within a batch would corrupt state (e.g. an earlier BID_PLACED overwriting
  // a later one).
  const sorted = sortDecodedEvents(decodedEvents);

  const rows = sorted.map((event) => ({
    eventId: resolveEventId(event),
    listingId: event.listingId ?? null,
    eventType: event.eventType,
    actor: event.actor,
    data: event.data,
    ledgerSequence: event.ledgerSequence,
    eventHash: event.eventHash ?? '',
    txHash: event.txHash ?? '',
    txIndex: event.txIndex ?? 0,
    eventIndex: event.eventIndex ?? 0,
  }));

  // Determine which events are already stored so reducers and SSE only run
  // for genuinely new events (a full-batch replay must be a no-op). This
  // lookup is NOT the duplicate-prevention mechanism — the unique constraints
  // enforced by createMany({ skipDuplicates }) below are, so a concurrent
  // writer racing between these two statements can never double-insert.
  const known = await tx.marketplaceEvent.findMany({
    where: {
      OR: [
        { eventId: { in: rows.map((r) => r.eventId) } },
        { eventHash: { in: rows.map((r) => r.eventHash).filter(Boolean) } },
      ],
    },
    select: { eventId: true, eventHash: true },
  });
  const knownIds = new Set<string>();
  for (const r of known as Array<{ eventId: string; eventHash: string }>) {
    if (r.eventId) knownIds.add(r.eventId);
    if (r.eventHash) knownIds.add(r.eventHash);
  }

  const newRows = rows.filter((r) => !knownIds.has(r.eventId) && !knownIds.has(r.eventHash));
  const preKnownDuplicates = rows.length - newRows.length;
  if (preKnownDuplicates > 0) {
    duplicateEventsCounter.inc(preKnownDuplicates);
    logger.debug('[Dedup] Skipping already-stored events', {
      count: preKnownDuplicates,
    });
  }

  if (newRows.length === 0) return [];

  const created = await tx.marketplaceEvent.createMany({
    data: newRows,
    skipDuplicates: true,
  });
  // Rows skipped here were inserted concurrently by another writer between the
  // findMany above and this insert.
  const racedDuplicates = newRows.length - (created?.count ?? newRows.length);
  if (racedDuplicates > 0) duplicateEventsCounter.inc(racedDuplicates);

  const newIds = new Set(newRows.map((r) => r.eventId));
  const toInsert = sorted.filter((event) => newIds.has(resolveEventId(event)));

  // Apply state reducers in batch order. Reducers are themselves guarded
  // against regressions (updatedAtLedger / monotonic comparisons) so a raced
  // or replayed event cannot move state backwards.
  for (const event of toInsert) {
    await processEvent(event, tx, true);
  }

  return toInsert;
}

export async function processEvent(event: any, tx?: any, skipInsert = false) {
  const { eventType, listingId, actor, ledgerSequence, data } = event;

  const db = tx ?? prisma;

  if (!skipInsert) {
    await db.marketplaceEvent.create({
      data: {
        listingId,
        eventType,
        actor,
        ledgerSequence,
        data,
        eventHash: event.eventHash ?? '',
        eventId: resolveEventId(event),
        txHash: event.txHash ?? '',
        txIndex: event.txIndex ?? 0,
        eventIndex: event.eventIndex ?? 0,
      },
    });
  }

  // Handle deploy events (no listingId — collection deployments)
  if (eventType === 'DEPLOY_NORMAL_721' || eventType === 'DEPLOY_NORMAL_1155' ||
      eventType === 'DEPLOY_LAZY_721' || eventType === 'DEPLOY_LAZY_1155') {
    const kindMap: Record<string, string> = {
      DEPLOY_NORMAL_721:  'normal_721',
      DEPLOY_NORMAL_1155: 'normal_1155',
      DEPLOY_LAZY_721:    'lazy_721',
      DEPLOY_LAZY_1155:   'lazy_1155',
    };
    const rawData = Array.isArray(data) ? data : [];
    const creatorAddr  = rawData[0]?.toString() || actor;
    const contractAddr = rawData[1]?.toString() || '';
    if (contractAddr) {
      await db.collection.upsert({
        where: { contractAddress: contractAddr },
        create: {
          contractAddress: contractAddr,
          kind: kindMap[eventType],
          creator: creatorAddr,
          deployedAtLedger: ledgerSequence,
        },
        update: {
          creator: creatorAddr,
          deployedAtLedger: ledgerSequence,
        },
      });
    }
    return;
  }

  // Update Listing state based on event type.
  //
  // Order-safety: every mutation of existing state carries a
  // `updatedAtLedger: { lte: ledgerSequence }` guard (or a monotonic value
  // guard for bids) so that replaying or reordering events can never move
  // state backwards. A `count === 0` therefore means "not found OR stale
  // event" — both are safe to skip.
  if (!listingId) return;

  switch (eventType) {
    case 'LISTING_CREATED': {
      let chainListing = await fetchListingFromChain(listingId);
      if (chainListing && !chainListing.artist) {
        chainListing = null;
      }

      const artist = chainListing ? chainListing.artist.toString() : data.artist;
      const price = chainListing ? chainListing.price.toString() : data.price;
      const currency = chainListing ? chainListing.currency.toString() : data.currency;
      const collection = chainListing ? chainListing.collection.toString() : data.collection;
      const nftTokenId = chainListing ? BigInt(chainListing.token_id) : BigInt(data.token_id);
      const token = chainListing ? chainListing.token.toString() : (data.token || '');

      const recipients = chainListing
        ? chainListing.recipients.map((r: any) => ({
            address: r.address.toString(),
            percentage: Number(r.percentage)
          }))
        : [];

      // Ensure the row exists, then apply data only if this event is not
      // stale — a late-arriving LISTING_CREATED must not reset a listing
      // that has since been sold or cancelled back to Active.
      await db.listing.upsert({
        where: { listingId },
        create: {
          listingId,
          artist,
          owner: null,
          price,
          currency,
          collection,
          nftTokenId,
          token,
          status: 'Active' as const,
          recipients,
          createdAtLedger: ledgerSequence,
          updatedAtLedger: ledgerSequence,
        },
        update: {},
      });
      await db.listing.updateMany({
        where: { listingId, updatedAtLedger: { lte: ledgerSequence } },
        data: {
          artist,
          price,
          collection,
          nftTokenId,
          status: 'Active' as const,
          recipients,
          updatedAtLedger: ledgerSequence,
        },
      });
      break;
    }

    case 'LISTING_UPDATED': {
      const { count } = await db.listing.updateMany({
        where: { listingId, updatedAtLedger: { lte: ledgerSequence } },
        data: {
          price: data.new_price,
          collection: data.collection,
          nftTokenId: BigInt(data.token_id || 0),
          updatedAtLedger: ledgerSequence,
        },
      });
      if (count === 0) logger.warn('LISTING_UPDATED: listing not found or event stale', { listingId: listingId?.toString(), ledger: ledgerSequence });
      break;
    }

    case 'LISTING_PRICE_UPDATED': {
      const { count } = await db.listing.updateMany({
        where: { listingId, updatedAtLedger: { lte: ledgerSequence } },
        data: {
          price: data.new_price,
          updatedAtLedger: ledgerSequence,
        },
      });
      if (count === 0) logger.warn('LISTING_PRICE_UPDATED: listing not found or event stale', { listingId: listingId?.toString(), ledger: ledgerSequence });
      // Price history accumulates regardless of listing state; the unique
      // eventId + skipDuplicates makes replays a no-op.
      await db.priceHistory.createMany({
        data: [{
          listingId,
          oldPrice: data.old_price,
          newPrice: data.new_price,
          updatedBy: data.updated_by || actor,
          ledgerSequence,
          eventId: resolveEventId(event),
        }],
        skipDuplicates: true,
      });
      break;
    }

    case 'ARTWORK_SOLD': {
      const { count } = await db.listing.updateMany({
        where: { listingId, updatedAtLedger: { lte: ledgerSequence } },
        data: {
          status: 'Sold' as const,
          owner: data.buyer,
          updatedAtLedger: ledgerSequence,
        },
      });
      if (count === 0) logger.error('ARTWORK_SOLD: listing not found or event stale — sale not recorded', { listingId: listingId?.toString(), ledger: ledgerSequence });
      break;
    }

    case 'LISTING_CANCELLED': {
      const { count } = await db.listing.updateMany({
        where: { listingId, updatedAtLedger: { lte: ledgerSequence } },
        data: {
          status: 'Cancelled' as const,
          updatedAtLedger: ledgerSequence,
        },
      });
      if (count === 0) logger.warn('LISTING_CANCELLED: listing not found or event stale', { listingId: listingId?.toString(), ledger: ledgerSequence });
      break;
    }

    // Contract semantics: expiry transitions the listing to Cancelled.
    case 'LISTING_EXPIRED': {
      const { count } = await db.listing.updateMany({
        where: { listingId, updatedAtLedger: { lte: ledgerSequence } },
        data: {
          status: 'Cancelled' as const,
          updatedAtLedger: ledgerSequence,
        },
      });
      if (count === 0) logger.warn('LISTING_EXPIRED: listing not found or event stale', { listingId: listingId?.toString(), ledger: ledgerSequence });
      break;
    }

    case 'PROTOCOL_FEE_COLLECTED': {
      await db.protocolFee.createMany({
        data: [{
          listingId,
          amount: data.amount,
          token: data.token,
          treasury: data.treasury,
          ledgerSequence,
          eventId: resolveEventId(event),
        }],
        skipDuplicates: true,
      });
      break;
    }

    case 'AUCTION_CREATED': {
      let chainAuction = await fetchAuctionFromChain(listingId);
      if (chainAuction && !chainAuction.creator) {
        chainAuction = null;
      }
      
      const creator = chainAuction ? chainAuction.creator.toString() : data.creator;
      const reservePrice = chainAuction ? chainAuction.reserve_price.toString() : (data.reserve_price || '0');
      const token = chainAuction ? chainAuction.token.toString() : (data.token || '');
      const endTime = chainAuction ? BigInt(chainAuction.end_time) : BigInt(data.end_time || 0);
      const collection = chainAuction ? chainAuction.collection.toString() : data.collection;
      const nftTokenId = chainAuction ? BigInt(chainAuction.token_id) : BigInt(data.token_id || 0);
      const recipients = chainAuction 
        ? chainAuction.recipients.map((r: any) => ({
            address: r.address.toString(),
            percentage: Number(r.percentage)
          }))
        : [];

      await db.auction.upsert({
        where: { auctionId: listingId },
        create: {
          auctionId: listingId,
          creator,
          collection,
          nftTokenId,
          token,
          reservePrice,
          highestBid: '0',
          highestBidder: null,
          endTime,
          status: 'Active' as const,
          recipients,
          createdAtLedger: ledgerSequence,
          updatedAtLedger: ledgerSequence,
        },
        update: {},
      });
      await db.auction.updateMany({
        where: { auctionId: listingId, updatedAtLedger: { lte: ledgerSequence } },
        data: {
          creator,
          collection,
          nftTokenId,
          token,
          reservePrice,
          endTime,
          status: 'Active' as const,
          recipients,
          updatedAtLedger: ledgerSequence,
        },
      });
      break;
    }

    case 'BID_PLACED': {
      // Bid history — one row per (auction, ledger, bidder); replays hit the
      // unique constraint and become a no-op update.
      await db.bid.upsert({
        where: {
          auctionId_ledgerSequence_bidder: {
            auctionId: listingId,
            ledgerSequence,
            bidder: data.bidder,
          },
        },
        create: {
          auctionId: listingId,
          bidder: data.bidder,
          amount: data.bid_amount,
          ledgerSequence,
        },
        update: { amount: data.bid_amount },
      });

      // Monotonic guard: bids strictly increase on-chain, so an out-of-order
      // or replayed BID_PLACED can never lower the recorded highest bid.
      const { count } = await db.auction.updateMany({
        where: { auctionId: listingId, highestBid: { lt: data.bid_amount } },
        data: {
          highestBid: data.bid_amount,
          highestBidder: data.bidder,
          updatedAtLedger: ledgerSequence,
        }
      });
      if (count === 0) logger.warn('BID_PLACED: auction not found or bid not higher than recorded', { auctionId: listingId?.toString(), ledger: ledgerSequence });
      break;
    }

    case 'AUCTION_EXTENDED': {
      const { count } = await db.auction.updateMany({
        where: { auctionId: listingId, updatedAtLedger: { lte: ledgerSequence } },
        data: {
          endTime: BigInt(data.new_end_time || 0),
          updatedAtLedger: ledgerSequence,
        },
      });
      if (count === 0) logger.warn('AUCTION_EXTENDED: auction not found or event stale', { auctionId: listingId?.toString(), ledger: ledgerSequence });
      break;
    }

    case 'AUCTION_RESOLVED': {
      const { count } = await db.auction.updateMany({
        where: { auctionId: listingId, updatedAtLedger: { lte: ledgerSequence } },
        data: {
          status: 'Finalized' as const,
          highestBid: data.amount,
          highestBidder: data.winner || null,
          updatedAtLedger: ledgerSequence,
        }
      });
      if (count === 0) logger.error('AUCTION_RESOLVED: auction not found or event stale — resolution not recorded', { auctionId: listingId?.toString(), ledger: ledgerSequence });
      break;
    }

    case 'AUCTION_CANCELLED': {
      const { count } = await db.auction.updateMany({
        where: { auctionId: listingId, updatedAtLedger: { lte: ledgerSequence } },
        data: {
          status: 'Cancelled' as const,
          updatedAtLedger: ledgerSequence,
        },
      });
      if (count === 0) logger.warn('AUCTION_CANCELLED: auction not found or event stale', { auctionId: listingId?.toString(), ledger: ledgerSequence });
      break;
    }

    case 'OFFER_MADE': {
      await db.offer.upsert({
        where: { offerId: BigInt(data.offer_id) },
        create: {
          offerId: BigInt(data.offer_id),
          listingId: BigInt(data.listing_id),
          offerer: data.offerer,
          amount: data.amount,
          token: data.token,
          status: 'Pending' as const,
          createdAtLedger: ledgerSequence,
          updatedAtLedger: ledgerSequence,
        },
        update: {},
      });
      // Guarded so a stale OFFER_MADE cannot reset a terminal offer state.
      await db.offer.updateMany({
        where: { offerId: BigInt(data.offer_id), updatedAtLedger: { lte: ledgerSequence } },
        data: {
          listingId: BigInt(data.listing_id),
          offerer: data.offerer,
          amount: data.amount,
          token: data.token,
          status: 'Pending' as const,
          updatedAtLedger: ledgerSequence,
        },
      });
      break;
    }

    case 'OFFER_ACCEPTED': {
      await db.offer.updateMany({
        where: { offerId: BigInt(data.offer_id), updatedAtLedger: { lte: ledgerSequence } },
        data: {
          status: 'Accepted' as const,
          updatedAtLedger: ledgerSequence,
        }
      });
      const { count: listingCount } = await db.listing.updateMany({
        where: { listingId: BigInt(data.listing_id), updatedAtLedger: { lte: ledgerSequence } },
        data: {
          status: 'Sold' as const,
          owner: data.offerer,
          updatedAtLedger: ledgerSequence,
        }
      });
      if (listingCount === 0) logger.error('OFFER_ACCEPTED: listing not found or event stale — offer accepted but listing not updated', { listingId: data.listing_id?.toString(), offerId: data.offer_id?.toString(), ledger: ledgerSequence });
      break;
    }

    case 'OFFER_REJECTED': {
      await db.offer.updateMany({
        where: { offerId: BigInt(data.offer_id), updatedAtLedger: { lte: ledgerSequence } },
        data: {
          status: 'Rejected' as const,
          updatedAtLedger: ledgerSequence,
        }
      });
      break;
    }

    case 'OFFER_WITHDRAWN': {
      await db.offer.updateMany({
        where: { offerId: BigInt(data.offer_id), updatedAtLedger: { lte: ledgerSequence } },
        data: {
          status: 'Withdrawn' as const,
          updatedAtLedger: ledgerSequence,
        }
      });
      break;
    }

    // Terminal state: the offerer reclaimed escrowed funds after expiry.
    case 'OFFER_RECLAIMED': {
      await db.offer.updateMany({
        where: { offerId: BigInt(data.offer_id), updatedAtLedger: { lte: ledgerSequence } },
        data: {
          status: 'Reclaimed' as const,
          updatedAtLedger: ledgerSequence,
        }
      });
      break;
    }

    // ROYALTY_PAID, ADMIN_TRANSFER_PROPOSED, ADMIN_TRANSFERRED,
    // ARTIST_REVOKED, ARTIST_REINSTATED, CONTRACT_PAUSED, CONTRACT_UNPAUSED:
    // persisted to MarketplaceEvent (with actor) above; no state reduction.
  }

  // Broadcast to any connected SSE clients after the DB write is complete.
  if (!tx) emitSSEEvent(event);
}
