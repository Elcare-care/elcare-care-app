import { rpc } from '@stellar/stellar-sdk';
import prisma from './db.js';
import prismaWrite from './prisma-write.js';
import {
  reconcilerDiscrepanciesTotal,
  reconcilerRepairsTotal,
  reconcilerDriftGauge,
} from './metrics.js';

const RPC_URL              = process.env.STELLAR_RPC_URL    || 'https://soroban-testnet.stellar.org';
const CONTRACT_ID          = process.env.MARKETPLACE_CONTRACT_ID || '';
const SAMPLE_SIZE          = parseInt(process.env.RECONCILE_SAMPLE_SIZE  || '50');
const RECONCILE_INTERVAL_MS = parseInt(process.env.RECONCILE_INTERVAL_MS || '300000'); // 5 min

let discrepancyCount = 0;

export function getDiscrepancyCount() {
  return discrepancyCount;
}

export interface ReconcileResult {
  sampledListings: number;
  sampledAuctions: number;
  discrepancies:   DiscrepancyRecord[];
  repairs:         number;
  dryRun:          boolean;
}

export interface DiscrepancyRecord {
  kind:        'listing' | 'auction';
  id:          string;
  field:       string;
  dbValue:     string;
  chainValue:  string;
}

// Fetch on-chain listing state.  Returns null when the contract call fails or
// the listing is not present on-chain (e.g. a stub or a testnet with no state).
export async function fetchListingOnChain(
  _server: rpc.Server,
  _contractId: string,
  _listingId: bigint
): Promise<{ status: string; price: string } | null> {
  // Real implementation calls the contract's `get_listing` view function via
  // ABI-encoded simulateTransaction.  Left as a no-op stub because the exact
  // ABI encoding is contract-specific; the reconciler exercises comparison and
  // repair logic whenever chain data is available.
  return null;
}

export async function fetchAuctionOnChain(
  _server: rpc.Server,
  _contractId: string,
  _auctionId: bigint
): Promise<{ status: string; highestBid: string } | null> {
  return null;
}

type FetchListing = (
  server: rpc.Server,
  contractId: string,
  listingId: bigint
) => Promise<{ status: string; price: string } | null>;

type FetchAuction = (
  server: rpc.Server,
  contractId: string,
  auctionId: bigint
) => Promise<{ status: string; highestBid: string } | null>;

async function writeRepair(opts: {
  modelType:   string;
  recordId:    string;
  field:       string;
  oldValue:    string;
  newValue:    string;
  reason:      string;
  sourceLedger: number;
  dryRun:      boolean;
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

export async function runReconciliation(
  server: rpc.Server,
  contractId: string,
  sampleSize   = SAMPLE_SIZE,
  fetchListing: FetchListing = fetchListingOnChain,
  fetchAuction: FetchAuction = fetchAuctionOnChain,
  dryRun = false
): Promise<ReconcileResult> {
  const discrepancies: DiscrepancyRecord[] = [];
  let repairsApplied = 0;

  // ── Sample active listings ─────────────────────────────────────────────────
  const listings = await prisma.listing.findMany({
    where:   { status: 'Active' },
    take:    sampleSize,
    orderBy: { updatedAtLedger: 'desc' },
    select:  { listingId: true, status: true, price: true, updatedAtLedger: true },
  });

  for (const listing of listings) {
    let chainState: Awaited<ReturnType<FetchListing>>;
    try {
      chainState = await fetchListing(server, contractId, listing.listingId);
    } catch {
      // RPC failure — leave record unchanged and continue
      continue;
    }
    if (!chainState) continue;

    const id          = listing.listingId.toString();
    const sourceLedger = listing.updatedAtLedger;

    if (chainState.status !== listing.status) {
      const rec: DiscrepancyRecord = {
        kind: 'listing', id, field: 'status',
        dbValue: listing.status, chainValue: chainState.status,
      };
      discrepancies.push(rec);
      discrepancyCount++;
      reconcilerDiscrepanciesTotal.inc({ model: 'listing', field: 'status' });
      console.warn('[Reconciler] Discrepancy', rec);

      if (!dryRun) {
        await (prismaWrite as any).$transaction(async (tx: any) => {
          await tx.listing.update({
            where: { listingId: listing.listingId },
            data:  { status: chainState!.status as any },
          });
          await writeRepair({
            modelType: 'listing', recordId: id, field: 'status',
            oldValue: listing.status, newValue: chainState!.status,
            reason: 'chain_status_mismatch', sourceLedger, dryRun,
          });
        });
      } else {
        await writeRepair({
          modelType: 'listing', recordId: id, field: 'status',
          oldValue: listing.status, newValue: chainState.status,
          reason: 'chain_status_mismatch', sourceLedger, dryRun,
        });
      }
      repairsApplied++;
    }

    if (chainState.price !== listing.price.toString()) {
      const rec: DiscrepancyRecord = {
        kind: 'listing', id, field: 'price',
        dbValue: listing.price.toString(), chainValue: chainState.price,
      };
      discrepancies.push(rec);
      discrepancyCount++;
      reconcilerDiscrepanciesTotal.inc({ model: 'listing', field: 'price' });
      console.warn('[Reconciler] Discrepancy', rec);

      if (!dryRun) {
        await (prismaWrite as any).$transaction(async (tx: any) => {
          await tx.listing.update({
            where: { listingId: listing.listingId },
            data:  { price: chainState!.price },
          });
          await writeRepair({
            modelType: 'listing', recordId: id, field: 'price',
            oldValue: listing.price.toString(), newValue: chainState!.price,
            reason: 'chain_price_mismatch', sourceLedger, dryRun,
          });
        });
      } else {
        await writeRepair({
          modelType: 'listing', recordId: id, field: 'price',
          oldValue: listing.price.toString(), newValue: chainState.price,
          reason: 'chain_price_mismatch', sourceLedger, dryRun,
        });
      }
      repairsApplied++;
    }
  }

  // ── Sample active auctions ─────────────────────────────────────────────────
  const auctions = await prisma.auction.findMany({
    where:   { status: 'Active' },
    take:    sampleSize,
    orderBy: { updatedAtLedger: 'desc' },
    select:  { auctionId: true, status: true, highestBid: true, updatedAtLedger: true },
  });

  for (const auction of auctions) {
    let chainState: Awaited<ReturnType<FetchAuction>>;
    try {
      chainState = await fetchAuction(server, contractId, auction.auctionId);
    } catch {
      continue;
    }
    if (!chainState) continue;

    const id          = auction.auctionId.toString();
    const sourceLedger = auction.updatedAtLedger;

    if (chainState.status !== auction.status) {
      const rec: DiscrepancyRecord = {
        kind: 'auction', id, field: 'status',
        dbValue: auction.status, chainValue: chainState.status,
      };
      discrepancies.push(rec);
      discrepancyCount++;
      reconcilerDiscrepanciesTotal.inc({ model: 'auction', field: 'status' });
      console.warn('[Reconciler] Discrepancy', rec);

      if (!dryRun) {
        await (prismaWrite as any).$transaction(async (tx: any) => {
          await tx.auction.update({
            where: { auctionId: auction.auctionId },
            data:  { status: chainState!.status as any },
          });
          await writeRepair({
            modelType: 'auction', recordId: id, field: 'status',
            oldValue: auction.status, newValue: chainState!.status,
            reason: 'chain_status_mismatch', sourceLedger, dryRun,
          });
        });
      } else {
        await writeRepair({
          modelType: 'auction', recordId: id, field: 'status',
          oldValue: auction.status, newValue: chainState.status,
          reason: 'chain_status_mismatch', sourceLedger, dryRun,
        });
      }
      repairsApplied++;
    }

    if (chainState.highestBid !== auction.highestBid.toString()) {
      const rec: DiscrepancyRecord = {
        kind: 'auction', id, field: 'highestBid',
        dbValue: auction.highestBid.toString(), chainValue: chainState.highestBid,
      };
      discrepancies.push(rec);
      discrepancyCount++;
      reconcilerDiscrepanciesTotal.inc({ model: 'auction', field: 'highestBid' });
      console.warn('[Reconciler] Discrepancy', rec);

      if (!dryRun) {
        await (prismaWrite as any).$transaction(async (tx: any) => {
          await tx.auction.update({
            where: { auctionId: auction.auctionId },
            data:  { highestBid: chainState!.highestBid },
          });
          await writeRepair({
            modelType: 'auction', recordId: id, field: 'highestBid',
            oldValue: auction.highestBid.toString(), newValue: chainState!.highestBid,
            reason: 'chain_bid_mismatch', sourceLedger, dryRun,
          });
        });
      } else {
        await writeRepair({
          modelType: 'auction', recordId: id, field: 'highestBid',
          oldValue: auction.highestBid.toString(), newValue: chainState.highestBid,
          reason: 'chain_bid_mismatch', sourceLedger, dryRun,
        });
      }
      repairsApplied++;
    }
  }

  reconcilerDriftGauge.set(discrepancies.length);

  console.log(
    `[Reconciler] Sampled ${listings.length} listings, ${auctions.length} auctions. ` +
    `Discrepancies: ${discrepancies.length}, repairs: ${repairsApplied} (dryRun=${dryRun})`
  );

  return {
    sampledListings: listings.length,
    sampledAuctions: auctions.length,
    discrepancies,
    repairs: repairsApplied,
    dryRun,
  };
}

export async function startReconciler() {
  const server = new rpc.Server(RPC_URL);

  const tick = async () => {
    try {
      await runReconciliation(server, CONTRACT_ID);
    } catch (err) {
      console.error('[Reconciler] Run failed:', err);
    }
  };

  await tick();
  setInterval(tick, RECONCILE_INTERVAL_MS);
}
