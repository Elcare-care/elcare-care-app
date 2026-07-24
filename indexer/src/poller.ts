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
import { collectMarketplaceEvents, MAX_LEDGER_WINDOW } from './event-sync.js';
import { withRpcRetry } from './retry.js';
import { logger } from './logger.js';
import redis from './redis.js';
import { loadConfig, parseTrackedContracts } from './config.js';
import { enqueueIpfsFetch } from './ipfs-cache.js';

dotenv.config();

// ── Re-org SSE event types ────────────────────────────────────────────────────

/**
 * Emitted on a normal (shallow) re-org that was successfully rolled back.
 * Frontends should show a brief notification and trigger a data refresh.
 */
export interface ReorgEvent {
  type: 'REORG';
  from_ledger: number;
  to_ledger: number;
  timestamp: string;
  depth: number;
}

/**
 * Emitted when a re-org depth exceeds MAX_ROLLBACK_DEPTH.
 * The poller halts; a human operator must call POST /admin/reorg-recovery
 * to trigger manual recovery.
 */
export interface CriticalReorgEvent {
  type: 'CRITICAL_REORG';
  from_ledger: number;
  to_ledger: number;
  timestamp: string;
  depth: number;
  message: string;
}

// ── Poller halt state ─────────────────────────────────────────────────────────

let _pollerHalted = false;
let _haltReason: string | null = null;

/** Returns true when the poller has been halted due to a critical re-org. */
export function isPollerHalted(): boolean {
  return _pollerHalted;
}

/** Returns the halt reason, or null if not halted. */
export function getHaltReason(): string | null {
  return _haltReason;
}

/**
 * Resumes the poller after a critical re-org.  Called by the admin recovery
 * endpoint (POST /admin/reorg-recovery) once an operator has verified the
 * chain state and performed any necessary manual rollback.
 */
export function resumePoller(): void {
  _pollerHalted = false;
  _haltReason = null;
  logger.info('poller: resumed by operator after critical re-org');
}

function emitReorgEvent(fromLedger: number, toLedger: number, depth: number): void {
  const event: ReorgEvent = {
    type: 'REORG',
    from_ledger: fromLedger,
    to_ledger: toLedger,
    timestamp: new Date().toISOString(),
    depth,
  };
  emitSSEEvent(event);
}

function emitCriticalReorgEvent(fromLedger: number, toLedger: number, depth: number): void {
  const msg = `Re-org depth ${depth} exceeds MAX_ROLLBACK_DEPTH — poller halted. ` +
    `Call POST /admin/reorg-recovery to resume after manual verification.`;
  const event: CriticalReorgEvent = {
    type: 'CRITICAL_REORG',
    from_ledger: fromLedger,
    to_ledger: toLedger,
    timestamp: new Date().toISOString(),
    depth,
    message: msg,
  };
  emitSSEEvent(event);
}

export const MAX_REORG_DEPTH = 100;

const RPC_URL = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';

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
  return parseTrackedContracts().map((c) => c.id).filter(Boolean);
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
  rpcServer: rpc.Server,
  maxRollbackDepth = 100,
  reorgHaltOnDeep = true
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
          logger.warn('Chain re-org detected', {
            ledger: syncState.lastLedger,
            dbHash: syncState.lastLedgerHash,
            networkHash: networkLedger.hash,
          });

          const safeLedger = await findReorgSafePoint(syncState.lastLedger, rpcServer);
          const rollbackDepth = syncState.lastLedger - safeLedger;

          // Guard: deep re-orgs halt the poller instead of executing a destructive rollback.
          if (reorgHaltOnDeep && rollbackDepth > maxRollbackDepth) {
            _pollerHalted = true;
            _haltReason =
              `Re-org depth ${rollbackDepth} exceeds MAX_ROLLBACK_DEPTH (${maxRollbackDepth}). ` +
              `Manual operator recovery required via POST /admin/reorg-recovery.`;
            logger.error('CRITICAL: Re-org depth exceeds MAX_ROLLBACK_DEPTH — halting poller', {
              rollbackDepth,
              maxRollbackDepth,
              fromLedger: syncState.lastLedger,
              toLedger: safeLedger,
            });
            emitCriticalReorgEvent(syncState.lastLedger, safeLedger, rollbackDepth);
            return false;
          }

          await revertLedgers(safeLedger);
          emitReorgEvent(syncState.lastLedger, safeLedger, rollbackDepth);
          return false;
        }
      }
    } catch (err) {
      logger.error('Hash continuity check failed', { ledger: syncState.lastLedger, err });
    }
  }
  return true;
}

/**
 * Seed TrackedContract rows from TRACKED_CONTRACTS (or legacy env vars) into
 * the database. Uses upsert on contractId so re-runs are idempotent.
 * Returns the full list of active contracts from the DB after seeding.
 */
export async function seedTrackedContracts() {
  const fromEnv = parseTrackedContracts();
  for (const c of fromEnv) {
    await prisma.trackedContract.upsert({
      where: { contractId: c.id },
      create: {
        contractId: c.id,
        type: c.type,
        label: c.label,
        startLedger: c.startLedger,
        lastLedger: c.startLedger,
        active: true,
      },
      // Only update label/type — don't reset lastLedger for existing contracts
      update: { label: c.label, type: c.type, active: true },
    });
  }
  return prisma.trackedContract.findMany({ where: { active: true } });
}

/**
 * Poll a single tracked contract indefinitely.
 * Each contract maintains its own lastLedger / lastLedgerHash in TrackedContract.
 */
async function pollContract(
  contractRow: { id: number; contractId: string; lastLedger: number; lastLedgerHash: string | null },
  config: ReturnType<typeof loadConfig>
): Promise<void> {
  let localErrors = 0;

  while (!shuttingDown) {
    // If the poller has been halted due to a critical re-org, pause and wait for
    // an operator to call POST /admin/reorg-recovery to clear the halt flag.
    if (_pollerHalted) {
      logger.warn('pollContract: poller halted due to critical re-org — waiting for operator recovery', {
        contractId: contractRow.contractId,
        reason: _haltReason,
      });
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      continue;
    }

    try {
      const contract = await prisma.trackedContract.findUnique({
        where: { id: contractRow.id },
      });

      if (!contract || !contract.active) {
        logger.info('pollContract: contract deactivated, stopping loop', {
          contractId: contractRow.contractId,
        });
        return;
      }

      // Hash continuity check for this contract
      if (contract.lastLedger > 0 && contract.lastLedgerHash) {
        try {
          const ledgersRes = await server.getLedgers({
            startLedger: contract.lastLedger,
            pagination: { limit: 1 },
          });
          if (ledgersRes.ledgers && ledgersRes.ledgers.length > 0) {
            const networkHash = ledgersRes.ledgers[0].hash;
            if (networkHash !== contract.lastLedgerHash) {
              logger.warn('pollContract: reorg detected', {
                contractId: contract.contractId,
                ledger: contract.lastLedger,
              });
              const safeLedger = await findReorgSafePoint(contract.lastLedger, server);
              const rollbackDepth = contract.lastLedger - safeLedger;

              // Guard: deep re-orgs halt the poller.
              if (config.reorgHaltOnDeep && rollbackDepth > config.maxRollbackDepth) {
                _pollerHalted = true;
                _haltReason =
                  `Re-org depth ${rollbackDepth} exceeds MAX_ROLLBACK_DEPTH (${config.maxRollbackDepth}). ` +
                  `Manual operator recovery required via POST /admin/reorg-recovery.`;
                logger.error('CRITICAL: Re-org depth exceeds MAX_ROLLBACK_DEPTH — halting poller', {
                  contractId: contract.contractId,
                  rollbackDepth,
                  maxRollbackDepth: config.maxRollbackDepth,
                  fromLedger: contract.lastLedger,
                  toLedger: safeLedger,
                });
                emitCriticalReorgEvent(contract.lastLedger, safeLedger, rollbackDepth);
                continue; // loop back, where _pollerHalted will block
              }

              await revertLedgers(safeLedger);
              await prisma.trackedContract.update({
                where: { id: contract.id },
                data: { lastLedger: safeLedger, lastLedgerHash: null },
              });
              emitReorgEvent(contract.lastLedger, safeLedger, rollbackDepth);
              continue;
            }
          }
        } catch (err) {
          logger.error('pollContract: hash check failed', {
            contractId: contract.contractId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const networkLatestLedger: number = await withRpcRetry(
        () => server.getLatestLedger().then((r) => r.sequence),
        { operation: 'getLatestLedger', maxAttempts: 5, baseDelayMs: 1_000 }
      );

      networkLatestLedgerGauge.set(networkLatestLedger);

      if (contract.lastLedger > 0 && networkLatestLedger < contract.lastLedger) {
        await persistLedgerGap(networkLatestLedger + 1, contract.lastLedger, 'reorg');
        await revertLedgers(networkLatestLedger);
        await prisma.trackedContract.update({
          where: { id: contract.id },
          data: { lastLedger: networkLatestLedger, lastLedgerHash: null },
        });
        continue;
      }

      const windowFloor = networkLatestLedger - MAX_LEDGER_WINDOW;
      let startLedger = contract.lastLedger + 1;

      if (startLedger < windowFloor) {
        const skippedRange = { from: startLedger, to: windowFloor - 1 };
        logger.warn('pollContract: skipping ledger gap outside RPC window', {
          contractId: contract.contractId,
          ...skippedRange,
          windowFloor,
        });
        await persistLedgerGap(skippedRange.from, skippedRange.to, 'rpc_window_skip');
        await prisma.trackedContract.update({
          where: { id: contract.id },
          data: { lastLedger: windowFloor - 1, lastLedgerHash: null },
        });
        startLedger = windowFloor;
      }

      const batchEndLedger = Math.min(
        networkLatestLedger,
        startLedger + config.maxLedgersPerCycle - 1
      );

      const decodedEvents = await collectMarketplaceEvents(
        server,
        [contract.contractId],
        startLedger,
        batchEndLedger
      );

      let latestHash: string | null = null;
      const advanceTo =
        decodedEvents.length > 0
          ? Math.max(...decodedEvents.map((e) => e.ledgerSequence))
          : batchEndLedger > contract.lastLedger
          ? batchEndLedger
          : null;

      if (advanceTo !== null) {
        try {
          const ledgersRes = await server.getLedgers({
            startLedger: advanceTo,
            pagination: { limit: 1 },
          });
          if (ledgersRes.ledgers && ledgersRes.ledgers.length > 0) {
            latestHash = ledgersRes.ledgers[0].hash;
          }
        } catch (err) {
          logger.error('pollContract: failed to fetch ledger hash', {
            contractId: contract.contractId,
            ledger: advanceTo,
            err,
          });
        }

        if (decodedEvents.length > 0) {
          const { newEvents } = await prisma.$transaction(async (tx) => {
            const toInsert = await applyDecodedEvents(decodedEvents, tx);
            // Keep the shared SyncState in sync with the most-advanced contract
            await tx.syncState.upsert({
              where: { id: 1 },
              create: { id: 1, lastLedger: advanceTo, lastLedgerHash: latestHash },
              update: buildSyncStateLedgerData(advanceTo, latestHash),
            });
            return { newEvents: toInsert };
          });
          for (const ev of newEvents) emitSSEEvent(ev);
        }

        const syncData = buildSyncStateLedgerData(advanceTo, latestHash);
        await prisma.trackedContract.update({
          where: { id: contract.id },
          data: {
            lastLedger: syncData.lastLedger,
            ...(syncData.lastLedgerHash ? { lastLedgerHash: syncData.lastLedgerHash } : {}),
          },
        });

        latestLedgerProcessedGauge.set(advanceTo);
        syncLatencyGauge.set(Math.max(0, networkLatestLedger - advanceTo));
        recordProgress();
      } else {
        latestLedgerProcessedGauge.set(contract.lastLedger);
        syncLatencyGauge.set(Math.max(0, networkLatestLedger - contract.lastLedger));
      }

      localErrors = 0;
    } catch (error) {
      localErrors += 1;
      const backoff = Math.min(BASE_BACKOFF_MS * Math.pow(2, localErrors - 1), MAX_BACKOFF_MS);
      logger.error('pollContract: error in loop', {
        contractId: contractRow.contractId,
        localErrors,
        backoffMs: backoff,
        err: error instanceof Error ? error.message : String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, backoff));
      continue;
    }

    localErrors = 0;
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

export async function startPolling() {
  const config = loadConfig();

  const activeContracts = await seedTrackedContracts();
  if (activeContracts.length === 0) {
    throw new Error('No active tracked contracts found. Set TRACKED_CONTRACTS or MARKETPLACE_CONTRACT_ID.');
  }

  logger.info('startPolling: launching per-contract pollers', {
    contracts: activeContracts.map((c) => ({
      contractId: c.contractId,
      label: c.label,
      type: c.type,
    })),
    pollIntervalMs: config.pollIntervalMs,
    maxLedgersPerCycle: config.maxLedgersPerCycle,
  });

  // Run one loop per contract concurrently; propagate first fatal failure
  await Promise.all(
    activeContracts.map((contract) =>
      pollContract(
        {
          id: contract.id,
          contractId: contract.contractId,
          lastLedger: contract.lastLedger,
          lastLedgerHash: contract.lastLedgerHash,
        },
        config
      )
    )
  );

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

export async function applyDecodedEvents(decodedEvents: any[], tx: any) {
  if (decodedEvents.length === 0) return [];

  const toInsert: any[] = [];

  for (const event of decodedEvents) {
    const eventHash: string = event.eventHash ?? '';

    // Upsert on eventHash — the unique identity of this on-chain event.
    // On conflict (duplicate) the update is a no-op; we detect it by checking
    // whether the row's id changed (Prisma returns the upserted row).
    const existing = eventHash
      ? await tx.marketplaceEvent.findUnique({ where: { eventHash }, select: { id: true } })
      : null;

    if (existing) {
      duplicateEventsCounter.inc();
      logger.debug('[Dedup] Skipping duplicate event', {
        eventHash,
        eventType: event.eventType,
        ledger: event.ledgerSequence,
      });
      continue;
    }

    await tx.marketplaceEvent.create({
      data: {
        listingId: event.listingId ?? null,
        eventType: event.eventType,
        actor: event.actor,
        data: event.data,
        ledgerSequence: event.ledgerSequence,
        eventHash,
        contractId: event.contractId ?? '',
      },
    });

    toInsert.push(event);
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
        contractId: event.contractId ?? '',
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

  // Update Listing state based on event type
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
        update: {
          artist,
          price,
          collection,
          nftTokenId,
          status: 'Active' as const,
          recipients,
          updatedAtLedger: ledgerSequence,
        }
      });

      // Enqueue a background IPFS metadata fetch using the token CID.
      // Fire-and-forget — a fetch failure must never crash the indexing path.
      if (token) {
        enqueueIpfsFetch(token).catch((err) => {
          logger.warn('[processEvent] Failed to enqueue IPFS fetch', {
            listingId: listingId?.toString(), token, err: err instanceof Error ? err.message : String(err),
          });
        });
      }
      break;
    }

    case 'LISTING_UPDATED': {
      const { count } = await db.listing.updateMany({
        where: { listingId },
        data: {
          price: data.new_price,
          collection: data.collection,
          nftTokenId: BigInt(data.token_id || 0),
          updatedAtLedger: ledgerSequence,
        },
      });
      if (count === 0) logger.warn('LISTING_UPDATED: listing not found', { listingId: listingId?.toString(), ledger: ledgerSequence });
      break;
    }

    case 'ARTWORK_SOLD': {
      const { count } = await db.listing.updateMany({
        where: { listingId },
        data: {
          status: 'Sold' as const,
          owner: data.buyer,
          updatedAtLedger: ledgerSequence,
        },
      });
      if (count === 0) logger.error('ARTWORK_SOLD: listing not found — sale not recorded', { listingId: listingId?.toString(), ledger: ledgerSequence });
      break;
    }

    case 'LISTING_CANCELLED': {
      const { count } = await db.listing.updateMany({
        where: { listingId },
        data: {
          status: 'Cancelled' as const,
          updatedAtLedger: ledgerSequence,
        },
      });
      if (count === 0) logger.warn('LISTING_CANCELLED: listing not found', { listingId: listingId?.toString(), ledger: ledgerSequence });
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
        update: {
          creator,
          collection,
          nftTokenId,
          token,
          reservePrice,
          endTime,
          status: 'Active' as const,
          recipients,
          updatedAtLedger: ledgerSequence,
        }
      });
      break;
    }

    case 'BID_PLACED': {
      const { count } = await db.auction.updateMany({
        where: { auctionId: listingId },
        data: {
          highestBid: data.bid_amount,
          highestBidder: data.bidder,
          updatedAtLedger: ledgerSequence,
        }
      });
      if (count === 0) logger.warn('BID_PLACED: auction not found', { auctionId: listingId?.toString(), ledger: ledgerSequence });
      break;
    }

    case 'AUCTION_RESOLVED': {
      const { count } = await db.auction.updateMany({
        where: { auctionId: listingId },
        data: {
          status: 'Finalized' as const,
          highestBid: data.amount,
          highestBidder: data.winner || null,
          updatedAtLedger: ledgerSequence,
        }
      });
      if (count === 0) logger.error('AUCTION_RESOLVED: auction not found — resolution not recorded', { auctionId: listingId?.toString(), ledger: ledgerSequence });
      break;
    }

    case 'AUCTION_CANCELLED': {
      const { count } = await db.auction.updateMany({
        where: { auctionId: listingId },
        data: {
          status: 'Cancelled' as const,
          updatedAtLedger: ledgerSequence,
        },
      });
      if (count === 0) logger.warn('AUCTION_CANCELLED: auction not found', { auctionId: listingId?.toString(), ledger: ledgerSequence });
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
        update: {
          listingId: BigInt(data.listing_id),
          offerer: data.offerer,
          amount: data.amount,
          token: data.token,
          status: 'Pending' as const,
          updatedAtLedger: ledgerSequence,
        }
      });
      break;
    }

    case 'OFFER_ACCEPTED': {
      await db.offer.update({
        where: { offerId: BigInt(data.offer_id) },
        data: {
          status: 'Accepted' as const,
          updatedAtLedger: ledgerSequence,
        }
      });
      const { count: listingCount } = await db.listing.updateMany({
        where: { listingId: BigInt(data.listing_id) },
        data: {
          status: 'Sold' as const,
          owner: data.offerer,
          updatedAtLedger: ledgerSequence,
        }
      });
      if (listingCount === 0) logger.error('OFFER_ACCEPTED: listing not found — offer accepted but listing not updated', { listingId: data.listing_id?.toString(), offerId: data.offer_id?.toString(), ledger: ledgerSequence });
      break;
    }

    case 'OFFER_REJECTED': {
      await db.offer.update({
        where: { offerId: BigInt(data.offer_id) },
        data: {
          status: 'Rejected' as const,
          updatedAtLedger: ledgerSequence,
        }
      });
      break;
    }

    case 'OFFER_WITHDRAWN': {
      await db.offer.update({
        where: { offerId: BigInt(data.offer_id) },
        data: {
          status: 'Withdrawn' as const,
          updatedAtLedger: ledgerSequence,
        }
      });
      break;
    }
  }

  // Broadcast to any connected SSE clients after the DB write is complete.
  if (!tx) emitSSEEvent(event);
}
