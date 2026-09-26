import { rpc } from '@stellar/stellar-sdk';
import prisma from './db.js';
import prismaWrite from './prisma-write.js';
import {
  reconcilerDiscrepanciesTotal,
  reconcilerRepairsTotal,
  reconcilerDriftGauge,
  reconcilerRunsTotal,
  reconcilerSkippedTotal,
} from './metrics.js';
import {
  fetchListingOnChain as defaultFetchListing,
  fetchAuctionOnChain as defaultFetchAuction,
  fetchOfferOnChain as defaultFetchOffer,
  fetchCollectionFeeBpsFromMarketplace as defaultFetchCollectionFeeBps,
  fetchListingsBatch,
  fetchAuctionsBatch,
  getListingReader,
  getAuctionReader,
  getOfferReader,
} from './chain-state.js';
import type {
  ChainListingState,
  ChainAuctionState,
  ChainOfferState,
} from './chain-state.js';
import { logger } from './logger.js';

const RPC_URL                = process.env.STELLAR_RPC_URL              || 'https://soroban-testnet.stellar.org';
const CONTRACT_ID            = process.env.MARKETPLACE_CONTRACT_ID       || '';
const LAUNCHPAD_CONTRACT_ID  = process.env.LAUNCHPAD_CONTRACT_ID         || '';
const SAMPLE_SIZE            = parseInt(process.env.RECONCILE_SAMPLE_SIZE   || '50');
const RECONCILE_INTERVAL_MS  = parseInt(process.env.RECONCILE_INTERVAL_MS   || '300000');
const AUTO_REPAIR            = process.env.RECONCILER_AUTO_REPAIR === 'true';
const BUDGET_PER_RUN         = parseInt(process.env.RECONCILER_BUDGET_PER_RUN || '200');

// ── Public types ──────────────────────────────────────────────────────────────

export interface ReconcileResult {
  sampledListings: number;
  sampledAuctions: number;
  discrepancies:   DiscrepancyRecord[];
  repairs:         number;
  skipped:         number;
  dryRun:          boolean;
  runId:           number | null;
}

export interface AccountingReconcileResult {
  sampledOffers:      number;
  sampledCollections: number;
  discrepancies:      DiscrepancyRecord[];
  repairs:            number;
  skipped:            number;
  dryRun:             boolean;
  runId:              number | null;
}

export interface DiscrepancyRecord {
  kind:        'listing' | 'auction' | 'offer' | 'collection';
  id:          string;
  field:       string;
  dbValue:     string;
  chainValue:  string;
}

// ── Injectable fetch function types (kept for test injection) ─────────────────

export type FetchListing = (
  server: rpc.Server,
  contractId: string,
  listingId: bigint
) => Promise<(ChainListingState & { status: string; price: string }) | null>;

export type FetchAuction = (
  server: rpc.Server,
  contractId: string,
  auctionId: bigint
) => Promise<(ChainAuctionState & { status: string; highestBid: string }) | null>;

export type FetchOffer = (
  server: rpc.Server,
  contractId: string,
  offerId: bigint
) => Promise<(ChainOfferState & { status: string; amount: string }) | null>;

export type FetchCollectionFeeBps = (
  server: rpc.Server,
  contractId: string,
  address: string
) => Promise<number | null>;

// Re-export the real implementations so tests can import and spy on them.
export {
  defaultFetchListing   as fetchListingOnChain,
  defaultFetchAuction   as fetchAuctionOnChain,
  defaultFetchOffer     as fetchOfferOnChain,
  defaultFetchCollectionFeeBps as fetchCollectionFeeBpsFromMarketplace,
};

// ── Repair helpers ────────────────────────────────────────────────────────────

async function writeRepair(opts: {
  modelType:    string;
  recordId:     string;
  field:        string;
  oldValue:     string;
  newValue:     string;
  reason:       string;
  sourceLedger: number;
  dryRun:       boolean;
}): Promise<void> {
  await (prismaWrite as any).reconciliationRepair.create({
    data: {
      modelType:   opts.modelType,
      recordId:    opts.recordId,
      field:       opts.field,
      oldValue:    opts.oldValue,
      newValue:    opts.newValue,
      reason:      opts.reason,
      sourceLedger: opts.sourceLedger,
      status:      opts.dryRun ? 'DryRun' : 'Applied',
    },
  });
  reconcilerRepairsTotal.inc({ model: opts.modelType, dry_run: String(opts.dryRun) });
}

async function persistDiscrepancy(opts: {
  runId:      number;
  kind:       'listing' | 'auction';
  entityId:   string;
  field:      string;
  dbValue:    string;
  chainValue: string;
}): Promise<number> {
  const row = await (prismaWrite as any).discrepancy.create({
    data: {
      runId:      opts.runId,
      kind:       opts.kind,
      entityId:   opts.entityId,
      field:      opts.field,
      dbValue:    opts.dbValue,
      chainValue: opts.chainValue,
    },
  });
  return row.id as number;
}

async function markDiscrepancyResolved(discrepancyId: number): Promise<void> {
  await (prismaWrite as any).discrepancy.update({
    where: { id: discrepancyId },
    data:  { resolved: true, resolvedAt: new Date() },
  });
}

// ── Core reconciliation logic ─────────────────────────────────────────────────

export async function runReconciliation(
  server: rpc.Server,
  contractId: string,
  sampleSize       = SAMPLE_SIZE,
  fetchListing: FetchListing   = defaultFetchListing as FetchListing,
  fetchAuction: FetchAuction   = defaultFetchAuction as FetchAuction,
  dryRun           = !AUTO_REPAIR,
  budgetPerRun     = BUDGET_PER_RUN
): Promise<ReconcileResult> {
  const discrepancies: DiscrepancyRecord[] = [];
  let repairsApplied = 0;
  let skippedCount   = 0;
  let rpcBudget      = budgetPerRun;
  let runId: number | null = null;

  // ── Create a ReconciliationRun row ─────────────────────────────────────────
  try {
    const run = await (prismaWrite as any).reconciliationRun.create({
      data: { dryRun },
    });
    runId = run.id as number;
  } catch (err) {
    logger.error('[Reconciler] Failed to create ReconciliationRun row', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Continue without run tracking rather than aborting the whole reconciliation
  }

  // ── Sample active listings ─────────────────────────────────────────────────
  const listings = await prisma.listing.findMany({
    where:   { status: 'Active' },
    take:    sampleSize,
    orderBy: { updatedAtLedger: 'desc' },
    select:  {
      listingId:       true,
      status:          true,
      price:           true,
      owner:           true,
      updatedAtLedger: true,
    },
  });

  for (const listing of listings) {
    if (rpcBudget <= 0) {
      skippedCount++;
      reconcilerSkippedTotal.inc({ reason: 'budget_exhausted' });
      continue;
    }

    let chainState: Awaited<ReturnType<FetchListing>>;
    try {
      chainState = await fetchListing(server, contractId, listing.listingId);
      rpcBudget--;
    } catch {
      skippedCount++;
      reconcilerSkippedTotal.inc({ reason: 'rpc_error' });
      logger.warn('[Reconciler] RPC error fetching listing', {
        listingId: listing.listingId.toString(),
      });
      continue;
    }
    if (!chainState) {
      // Entry archived / TTL-expired — not a discrepancy, just unavailable
      skippedCount++;
      reconcilerSkippedTotal.inc({ reason: 'entry_not_found' });
      continue;
    }

    const id          = listing.listingId.toString();
    const sourceLedger = listing.updatedAtLedger;
    const kind        = 'listing' as const;

    // ── Compare fields ───────────────────────────────────────────────────────
    const listingChecks: Array<{
      field: string;
      dbVal: string;
      chainVal: string;
      updateData: Record<string, unknown>;
      reason: string;
    }> = [];

    if (chainState.status !== listing.status) {
      listingChecks.push({
        field:      'status',
        dbVal:      listing.status,
        chainVal:   chainState.status,
        updateData: { status: chainState.status },
        reason:     'chain_status_mismatch',
      });
    }

    const dbPrice = listing.price.toString();
    if (chainState.price !== dbPrice) {
      listingChecks.push({
        field:      'price',
        dbVal:      dbPrice,
        chainVal:   chainState.price,
        updateData: { price: chainState.price },
        reason:     'chain_price_mismatch',
      });
    }

    // owner is optional on both sides; compare only when chain gives a value
    const dbOwner    = listing.owner ?? null;
    const chainOwner = chainState.owner ?? null;
    if (chainOwner !== dbOwner) {
      listingChecks.push({
        field:      'owner',
        dbVal:      dbOwner ?? '',
        chainVal:   chainOwner ?? '',
        updateData: { owner: chainOwner },
        reason:     'chain_owner_mismatch',
      });
    }

    for (const check of listingChecks) {
      const rec: DiscrepancyRecord = {
        kind, id, field: check.field,
        dbValue: check.dbVal, chainValue: check.chainVal,
      };
      discrepancies.push(rec);
      reconcilerDiscrepanciesTotal.inc({ model: 'listing', field: check.field });
      logger.warn('[Reconciler] Discrepancy', rec);

      let discId: number | undefined;
      if (runId !== null) {
        try {
          discId = await persistDiscrepancy({
            runId, kind, entityId: id,
            field: check.field, dbValue: check.dbVal, chainValue: check.chainVal,
          });
        } catch (err) {
          logger.error('[Reconciler] Failed to persist Discrepancy row', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (!dryRun) {
        try {
          await (prismaWrite as any).$transaction(async (tx: any) => {
            await tx.listing.update({
              where: { listingId: listing.listingId },
              data:  check.updateData,
            });
            await writeRepair({
              modelType: 'listing', recordId: id, field: check.field,
              oldValue: check.dbVal, newValue: check.chainVal,
              reason: check.reason, sourceLedger, dryRun,
            });
          });
          repairsApplied++;
          if (discId !== undefined) {
            await markDiscrepancyResolved(discId).catch(() => {});
          }
        } catch (err) {
          logger.error('[Reconciler] Repair transaction failed (listing)', {
            listingId: id, field: check.field,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        await writeRepair({
          modelType: 'listing', recordId: id, field: check.field,
          oldValue: check.dbVal, newValue: check.chainVal,
          reason: check.reason, sourceLedger, dryRun,
        });
        repairsApplied++;
      }
    }
  }

  // ── Sample active auctions ─────────────────────────────────────────────────
  const auctions = await prisma.auction.findMany({
    where:   { status: 'Active' },
    take:    sampleSize,
    orderBy: { updatedAtLedger: 'desc' },
    select:  {
      auctionId:       true,
      status:          true,
      highestBid:      true,
      highestBidder:   true,
      endTime:         true,
      updatedAtLedger: true,
    },
  });

  for (const auction of auctions) {
    if (rpcBudget <= 0) {
      skippedCount++;
      reconcilerSkippedTotal.inc({ reason: 'budget_exhausted' });
      continue;
    }

    let chainState: Awaited<ReturnType<FetchAuction>>;
    try {
      chainState = await fetchAuction(server, contractId, auction.auctionId);
      rpcBudget--;
    } catch {
      skippedCount++;
      reconcilerSkippedTotal.inc({ reason: 'rpc_error' });
      logger.warn('[Reconciler] RPC error fetching auction', {
        auctionId: auction.auctionId.toString(),
      });
      continue;
    }
    if (!chainState) {
      skippedCount++;
      reconcilerSkippedTotal.inc({ reason: 'entry_not_found' });
      continue;
    }

    const id          = auction.auctionId.toString();
    const sourceLedger = auction.updatedAtLedger;
    const kind        = 'auction' as const;

    const auctionChecks: Array<{
      field: string;
      dbVal: string;
      chainVal: string;
      updateData: Record<string, unknown>;
      reason: string;
    }> = [];

    if (chainState.status !== auction.status) {
      auctionChecks.push({
        field:      'status',
        dbVal:      auction.status,
        chainVal:   chainState.status,
        updateData: { status: chainState.status },
        reason:     'chain_status_mismatch',
      });
    }

    const dbHighestBid = auction.highestBid.toString();
    if (chainState.highestBid !== dbHighestBid) {
      auctionChecks.push({
        field:      'highestBid',
        dbVal:      dbHighestBid,
        chainVal:   chainState.highestBid,
        updateData: { highestBid: chainState.highestBid },
        reason:     'chain_bid_mismatch',
      });
    }

    const dbHighestBidder    = auction.highestBidder ?? null;
    const chainHighestBidder = chainState.highestBidder ?? null;
    if (chainHighestBidder !== dbHighestBidder) {
      auctionChecks.push({
        field:      'highestBidder',
        dbVal:      dbHighestBidder ?? '',
        chainVal:   chainHighestBidder ?? '',
        updateData: { highestBidder: chainHighestBidder },
        reason:     'chain_bidder_mismatch',
      });
    }

    const dbEndTime    = auction.endTime.toString();
    const chainEndTime = chainState.endTime ?? '';
    if (chainEndTime && chainEndTime !== dbEndTime) {
      auctionChecks.push({
        field:      'endTime',
        dbVal:      dbEndTime,
        chainVal:   chainEndTime,
        updateData: { endTime: chainEndTime },
        reason:     'chain_endtime_mismatch',
      });
    }

    for (const check of auctionChecks) {
      const rec: DiscrepancyRecord = {
        kind, id, field: check.field,
        dbValue: check.dbVal, chainValue: check.chainVal,
      };
      discrepancies.push(rec);
      reconcilerDiscrepanciesTotal.inc({ model: 'auction', field: check.field });
      logger.warn('[Reconciler] Discrepancy', rec);

      let discId: number | undefined;
      if (runId !== null) {
        try {
          discId = await persistDiscrepancy({
            runId, kind, entityId: id,
            field: check.field, dbValue: check.dbVal, chainValue: check.chainVal,
          });
        } catch (err) {
          logger.error('[Reconciler] Failed to persist Discrepancy row', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (!dryRun) {
        try {
          await (prismaWrite as any).$transaction(async (tx: any) => {
            await tx.auction.update({
              where: { auctionId: auction.auctionId },
              data:  check.updateData,
            });
            await writeRepair({
              modelType: 'auction', recordId: id, field: check.field,
              oldValue: check.dbVal, newValue: check.chainVal,
              reason: check.reason, sourceLedger, dryRun,
            });
          });
          repairsApplied++;
          if (discId !== undefined) {
            await markDiscrepancyResolved(discId).catch(() => {});
          }
        } catch (err) {
          logger.error('[Reconciler] Repair transaction failed (auction)', {
            auctionId: id, field: check.field,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        await writeRepair({
          modelType: 'auction', recordId: id, field: check.field,
          oldValue: check.dbVal, newValue: check.chainVal,
          reason: check.reason, sourceLedger, dryRun,
        });
        repairsApplied++;
      }
    }
  }

  // ── Finalise metrics + ReconciliationRun row ───────────────────────────────
  reconcilerDriftGauge.set(discrepancies.length);
  reconcilerRunsTotal.inc({ outcome: 'ok', dry_run: String(dryRun) });

  if (runId !== null) {
    try {
      await (prismaWrite as any).reconciliationRun.update({
        where: { id: runId },
        data: {
          completedAt:        new Date(),
          sampledListings:    listings.length,
          sampledAuctions:    auctions.length,
          discrepanciesFound: discrepancies.length,
          repairsApplied,
          skippedRecords:     skippedCount,
        },
      });
    } catch (err) {
      logger.error('[Reconciler] Failed to finalise ReconciliationRun row', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info(
    `[Reconciler] Sampled ${listings.length} listings, ${auctions.length} auctions. ` +
    `Discrepancies: ${discrepancies.length}, repairs: ${repairsApplied}, ` +
    `skipped: ${skippedCount} (dryRun=${dryRun})`
  );

  return {
    sampledListings: listings.length,
    sampledAuctions: auctions.length,
    discrepancies,
    repairs:  repairsApplied,
    skipped:  skippedCount,
    dryRun,
    runId,
  };
}

// ── Accounting reconciliation (offers + collections) ──────────────────────────

/**
 * Reconciles Pending offers and collection fee overrides against on-chain state.
 *
 * Runs as a secondary pass after the primary listing/auction reconciliation so
 * the budget can be allocated independently.  Returns structured discrepancy
 * records and increments the same Prometheus counters.
 */
export async function runAccountingReconciliation(
  server: rpc.Server,
  marketplaceContractId: string,
  launchpadContractId     = '',
  sampleSize              = SAMPLE_SIZE,
  fetchOffer: FetchOffer                   = defaultFetchOffer as FetchOffer,
  fetchCollectionFeeBps: FetchCollectionFeeBps = defaultFetchCollectionFeeBps,
  dryRun                  = !AUTO_REPAIR,
  budgetPerRun            = BUDGET_PER_RUN,
): Promise<AccountingReconcileResult> {
  const discrepancies: DiscrepancyRecord[] = [];
  let repairsApplied = 0;
  let skippedCount   = 0;
  let rpcBudget      = budgetPerRun;
  let runId: number | null = null;

  try {
    const run = await (prismaWrite as any).reconciliationRun.create({
      data: { dryRun },
    });
    runId = run.id as number;
  } catch (err) {
    logger.error('[Reconciler] Failed to create accounting ReconciliationRun row', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── Sample Pending offers ──────────────────────────────────────────────────
  const offers = await (prisma as any).offer.findMany({
    where:   { status: 'Pending' },
    take:    sampleSize,
    orderBy: { updatedAtLedger: 'desc' },
    select:  {
      offerId:         true,
      status:          true,
      amount:          true,
      updatedAtLedger: true,
    },
  });

  for (const offer of offers) {
    if (rpcBudget <= 0) {
      skippedCount++;
      reconcilerSkippedTotal.inc({ reason: 'budget_exhausted' });
      continue;
    }

    let chainState: Awaited<ReturnType<FetchOffer>>;
    try {
      chainState = await fetchOffer(server, marketplaceContractId, offer.offerId);
      rpcBudget--;
    } catch {
      skippedCount++;
      reconcilerSkippedTotal.inc({ reason: 'rpc_error' });
      logger.warn('[Reconciler] RPC error fetching offer', {
        offerId: offer.offerId.toString(),
      });
      continue;
    }
    if (!chainState) {
      skippedCount++;
      reconcilerSkippedTotal.inc({ reason: 'entry_not_found' });
      continue;
    }

    const id          = offer.offerId.toString();
    const sourceLedger = offer.updatedAtLedger;
    const kind        = 'offer' as const;

    const offerChecks: Array<{
      field: string;
      dbVal: string;
      chainVal: string;
      updateData: Record<string, unknown>;
      reason: string;
    }> = [];

    if (chainState.status !== offer.status) {
      offerChecks.push({
        field:      'status',
        dbVal:      offer.status,
        chainVal:   chainState.status,
        updateData: { status: chainState.status },
        reason:     'chain_offer_status_mismatch',
      });
    }

    const dbAmount = offer.amount.toString();
    if (chainState.amount !== dbAmount) {
      offerChecks.push({
        field:      'amount',
        dbVal:      dbAmount,
        chainVal:   chainState.amount,
        updateData: { amount: chainState.amount },
        reason:     'chain_offer_amount_mismatch',
      });
    }

    for (const check of offerChecks) {
      const rec: DiscrepancyRecord = {
        kind, id, field: check.field,
        dbValue: check.dbVal, chainValue: check.chainVal,
      };
      discrepancies.push(rec);
      reconcilerDiscrepanciesTotal.inc({ model: 'offer', field: check.field });
      logger.warn('[Reconciler] Offer discrepancy', rec);

      let discId: number | undefined;
      if (runId !== null) {
        try {
          discId = await persistDiscrepancy({
            runId, kind, entityId: id,
            field: check.field, dbValue: check.dbVal, chainValue: check.chainVal,
          });
        } catch (err) {
          logger.error('[Reconciler] Failed to persist offer Discrepancy row', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (!dryRun) {
        try {
          await (prismaWrite as any).$transaction(async (tx: any) => {
            await tx.offer.update({
              where: { offerId: offer.offerId },
              data:  check.updateData,
            });
            await writeRepair({
              modelType: 'offer', recordId: id, field: check.field,
              oldValue: check.dbVal, newValue: check.chainVal,
              reason: check.reason, sourceLedger, dryRun,
            });
          });
          repairsApplied++;
          if (discId !== undefined) {
            await markDiscrepancyResolved(discId).catch(() => {});
          }
        } catch (err) {
          logger.error('[Reconciler] Repair transaction failed (offer)', {
            offerId: id, field: check.field,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        await writeRepair({
          modelType: 'offer', recordId: id, field: check.field,
          oldValue: check.dbVal, newValue: check.chainVal,
          reason: check.reason, sourceLedger, dryRun,
        });
        repairsApplied++;
      }
    }
  }

  // ── Sample collections — compare fee override ──────────────────────────────
  const collections = await (prisma as any).collection.findMany({
    take:    sampleSize,
    orderBy: { deployedAtLedger: 'desc' },
    select:  {
      id:              true,
      contractAddress: true,
      feeBpsOverride:  true,
      deployedAtLedger: true,
    },
  });

  for (const col of collections) {
    if (rpcBudget <= 0) {
      skippedCount++;
      reconcilerSkippedTotal.inc({ reason: 'budget_exhausted' });
      continue;
    }

    let chainFeeBps: number | null;
    try {
      chainFeeBps = await fetchCollectionFeeBps(
        server, marketplaceContractId, col.contractAddress
      );
      rpcBudget--;
    } catch {
      skippedCount++;
      reconcilerSkippedTotal.inc({ reason: 'rpc_error' });
      logger.warn('[Reconciler] RPC error fetching collection fee bps', {
        address: col.contractAddress,
      });
      continue;
    }

    const id          = col.id.toString();
    const sourceLedger = col.deployedAtLedger;
    const kind        = 'collection' as const;

    const dbFeeBps = col.feeBpsOverride ?? null;

    if (chainFeeBps !== dbFeeBps) {
      const rec: DiscrepancyRecord = {
        kind, id, field: 'feeBpsOverride',
        dbValue:    String(dbFeeBps ?? ''),
        chainValue: String(chainFeeBps ?? ''),
      };
      discrepancies.push(rec);
      reconcilerDiscrepanciesTotal.inc({ model: 'collection', field: 'feeBpsOverride' });
      logger.warn('[Reconciler] Collection discrepancy', rec);

      let discId: number | undefined;
      if (runId !== null) {
        try {
          discId = await persistDiscrepancy({
            runId, kind, entityId: id,
            field: 'feeBpsOverride',
            dbValue: rec.dbValue, chainValue: rec.chainValue,
          });
        } catch (err) {
          logger.error('[Reconciler] Failed to persist collection Discrepancy row', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (!dryRun) {
        try {
          await (prismaWrite as any).$transaction(async (tx: any) => {
            await tx.collection.update({
              where: { id: col.id },
              data:  { feeBpsOverride: chainFeeBps },
            });
            await writeRepair({
              modelType: 'collection', recordId: id, field: 'feeBpsOverride',
              oldValue: rec.dbValue, newValue: rec.chainValue,
              reason: 'chain_collection_fee_mismatch', sourceLedger, dryRun,
            });
          });
          repairsApplied++;
          if (discId !== undefined) {
            await markDiscrepancyResolved(discId).catch(() => {});
          }
        } catch (err) {
          logger.error('[Reconciler] Repair transaction failed (collection)', {
            collectionId: id, error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        await writeRepair({
          modelType: 'collection', recordId: id, field: 'feeBpsOverride',
          oldValue: rec.dbValue, newValue: rec.chainValue,
          reason: 'chain_collection_fee_mismatch', sourceLedger, dryRun,
        });
        repairsApplied++;
      }
    }
  }

  // ── Finalise ───────────────────────────────────────────────────────────────
  reconcilerDriftGauge.set(discrepancies.length);

  if (runId !== null) {
    try {
      await (prismaWrite as any).reconciliationRun.update({
        where: { id: runId },
        data: {
          completedAt:        new Date(),
          sampledOffers:      offers.length,
          sampledCollections: collections.length,
          discrepanciesFound: discrepancies.length,
          repairsApplied,
          skippedRecords:     skippedCount,
        },
      });
    } catch (err) {
      logger.error('[Reconciler] Failed to finalise accounting ReconciliationRun row', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info(
    `[Reconciler] Accounting: sampled ${offers.length} offers, ` +
    `${collections.length} collections. ` +
    `Discrepancies: ${discrepancies.length}, repairs: ${repairsApplied}, ` +
    `skipped: ${skippedCount} (dryRun=${dryRun})`
  );

  return {
    sampledOffers:      offers.length,
    sampledCollections: collections.length,
    discrepancies,
    repairs:  repairsApplied,
    skipped:  skippedCount,
    dryRun,
    runId,
  };
}

// ── Last-run status (for the API endpoint) ────────────────────────────────────

export async function getReconciliationStatus() {
  const lastRun = await prisma.reconciliationRun.findFirst({
    orderBy: { startedAt: 'desc' },
    include: {
      discrepancies: {
        orderBy: { detectedAt: 'desc' },
        take: 20,
      },
    },
  }) as any;

  const openCount = lastRun
    ? await prisma.discrepancy.count({
        where: { runId: lastRun.id, resolved: false },
      }) as any
    : 0;

  return {
    lastRun: lastRun
      ? {
          id:                 lastRun.id,
          startedAt:          lastRun.startedAt,
          completedAt:        lastRun.completedAt,
          sampledListings:    lastRun.sampledListings,
          sampledAuctions:    lastRun.sampledAuctions,
          discrepanciesFound: lastRun.discrepanciesFound,
          repairsApplied:     lastRun.repairsApplied,
          skippedRecords:     lastRun.skippedRecords,
          dryRun:             lastRun.dryRun,
          errorMessage:       lastRun.errorMessage ?? null,
          openDiscrepancies:  openCount,
          recentDiscrepancies: lastRun.discrepancies,
        }
      : null,
  };
}

// ── Recurring loop ────────────────────────────────────────────────────────────

export async function startReconciler() {
  const server = new rpc.Server(RPC_URL);
  const fetchListing = getListingReader() as FetchListing;
  const fetchAuction = getAuctionReader() as FetchAuction;
  const fetchOffer   = getOfferReader()   as FetchOffer;

  const tick = async () => {
    try {
      await runReconciliation(
        server,
        CONTRACT_ID,
        SAMPLE_SIZE,
        fetchListing,
        fetchAuction,
        !AUTO_REPAIR,
        BUDGET_PER_RUN
      );
    } catch (err) {
      reconcilerRunsTotal.inc({ outcome: 'error', dry_run: String(!AUTO_REPAIR) });
      logger.error('[Reconciler] Run failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await runAccountingReconciliation(
        server,
        CONTRACT_ID,
        LAUNCHPAD_CONTRACT_ID,
        SAMPLE_SIZE,
        fetchOffer,
        defaultFetchCollectionFeeBps,
        !AUTO_REPAIR,
        BUDGET_PER_RUN
      );
    } catch (err) {
      logger.error('[Reconciler] Accounting run failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  await tick();
  setInterval(tick, RECONCILE_INTERVAL_MS);
}
