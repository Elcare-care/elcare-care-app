import { rpc } from '@stellar/stellar-sdk';
import prisma from './db.js';

const RPC_URL = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = process.env.MARKETPLACE_CONTRACT_ID || '';

// How many records to sample per run
const SAMPLE_SIZE = parseInt(process.env.RECONCILE_SAMPLE_SIZE || '50');
// Interval between reconciliation runs in ms
const RECONCILE_INTERVAL_MS = parseInt(process.env.RECONCILE_INTERVAL_MS || '300000'); // 5 min

let discrepancyCount = 0;

export function getDiscrepancyCount() {
  return discrepancyCount;
}

export interface ReconcileResult {
  sampledListings: number;
  sampledAuctions: number;
  discrepancies: DiscrepancyRecord[];
}

export interface DiscrepancyRecord {
  kind: 'listing' | 'auction';
  id: string;
  field: string;
  dbValue: string;
  chainValue: string;
}

// Fetch on-chain listing state. Returns null when the contract call fails or the
// listing is not present on-chain (e.g. using a stub or testnet that has no state).
export async function fetchListingOnChain(
  server: rpc.Server,
  _contractId: string,
  _listingId: bigint
): Promise<{ status: string; price: string } | null> {
  // Real implementation would call the contract's `get_listing` view function.
  // This is left as a no-op stub because the Soroban RPC call requires ABI
  // encoding that is contract-specific; the reconciler still exercises the
  // comparison logic when chain data is available.
  return null;
}

export async function fetchAuctionOnChain(
  server: rpc.Server,
  _contractId: string,
  _auctionId: bigint
): Promise<{ status: string; highestBid: string } | null> {
  return null;
}

// ── Accounting reconciliation (Issue #279) ───────────────────────────────────
//
// The marketplace contract keeps lifetime, monotonic, per-payment-token
// counters (`get_protocol_fee_total`, `get_royalty_total`) that are bumped
// only after a settlement's transfers have fully succeeded — see
// storage.rs's "Accounting counters" section and
// docs/guides/accounting-reconciliation.md. This section sums the indexer's
// own event history (PROTOCOL_FEE_COLLECTED.amount and
// ROYALTY_SETTLEMENT.total_amount, both grouped by token) and compares the
// totals against those on-chain counters, logging a warning on mismatch.
//
// A mismatch can indicate: a missed/dropped event during indexing, a bug in
// event decoding, or (pre-existing) an event topic that was never mapped at
// all — see the `royalty_settlement` TOPIC_MAP fix in parser.ts, added
// alongside this reconciliation because without it there was no off-chain
// royalty total to reconcile against in the first place.

// Fetch the on-chain lifetime protocol-fee total for `token`. Returns null
// when unavailable — same stub pattern as fetchListingOnChain/
// fetchAuctionOnChain above (a real implementation calls the contract's
// `get_protocol_fee_total` view via `server.simulateTransaction`, which needs
// contract-specific ABI/XDR encoding of the `token` Address argument).
export async function fetchProtocolFeeTotalOnChain(
  server: rpc.Server,
  _contractId: string,
  _token: string
): Promise<string | null> {
  return null;
}

// Fetch the on-chain lifetime royalty-settlement total for `token`. Same stub
// pattern — see fetchProtocolFeeTotalOnChain above.
export async function fetchRoyaltyTotalOnChain(
  server: rpc.Server,
  _contractId: string,
  _token: string
): Promise<string | null> {
  return null;
}

type FetchTokenTotal = (
  server: rpc.Server,
  contractId: string,
  token: string
) => Promise<string | null>;

export interface AccountingDiscrepancyRecord {
  kind: 'protocol_fee' | 'royalty';
  token: string;
  offChainTotal: string;
  onChainTotal: string;
}

export interface AccountingReconcileResult {
  tokensChecked: number;
  discrepancies: AccountingDiscrepancyRecord[];
}

/** Sum a bigint-valued field out of MarketplaceEvent.data, grouped by token. */
function sumByToken(
  rows: Array<{ data: unknown }>,
  amountField: string,
  tokenField: string
): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    const data = row.data as Record<string, unknown> | null;
    if (!data) continue;
    const token = data[tokenField];
    const amount = data[amountField];
    if (typeof token !== 'string' || (amount === undefined || amount === null)) continue;
    const amt = BigInt(amount as bigint | number | string);
    totals.set(token, (totals.get(token) ?? 0n) + amt);
  }
  return totals;
}

/**
 * Compare the indexer's off-chain aggregation of protocol fees and royalty
 * settlements (per payment token) against the marketplace contract's
 * on-chain lifetime counters. Logs a warning per mismatch; does not throw.
 *
 * Off-chain totals are computed over the indexer's *entire* event history
 * (not sampled) since these are meant to equal an exact lifetime counter,
 * not an approximation.
 */
export async function runAccountingReconciliation(
  server: rpc.Server,
  contractId: string,
  fetchProtocolFeeTotal: FetchTokenTotal = fetchProtocolFeeTotalOnChain,
  fetchRoyaltyTotal: FetchTokenTotal = fetchRoyaltyTotalOnChain
): Promise<AccountingReconcileResult> {
  const discrepancies: AccountingDiscrepancyRecord[] = [];

  const [feeEvents, royaltyEvents] = await Promise.all([
    prisma.marketplaceEvent.findMany({
      where: { eventType: 'PROTOCOL_FEE_COLLECTED' },
      select: { data: true },
    }),
    prisma.marketplaceEvent.findMany({
      where: { eventType: 'ROYALTY_SETTLEMENT' },
      select: { data: true },
    }),
  ]);

  const feeTotals = sumByToken(feeEvents, 'amount', 'token');
  const royaltyTotals = sumByToken(royaltyEvents, 'total_amount', 'token');

  const tokens = new Set<string>([...feeTotals.keys(), ...royaltyTotals.keys()]);

  for (const token of tokens) {
    const offChainFee = (feeTotals.get(token) ?? 0n).toString();
    const onChainFee = await fetchProtocolFeeTotal(server, contractId, token);
    if (onChainFee !== null && onChainFee !== offChainFee) {
      const rec: AccountingDiscrepancyRecord = {
        kind: 'protocol_fee', token, offChainTotal: offChainFee, onChainTotal: onChainFee,
      };
      discrepancies.push(rec);
      console.warn('[Reconciler] Accounting discrepancy', rec);
    }

    const offChainRoyalty = (royaltyTotals.get(token) ?? 0n).toString();
    const onChainRoyalty = await fetchRoyaltyTotal(server, contractId, token);
    if (onChainRoyalty !== null && onChainRoyalty !== offChainRoyalty) {
      const rec: AccountingDiscrepancyRecord = {
        kind: 'royalty', token, offChainTotal: offChainRoyalty, onChainTotal: onChainRoyalty,
      };
      discrepancies.push(rec);
      console.warn('[Reconciler] Accounting discrepancy', rec);
    }
  }

  console.log(
    `[Reconciler] Accounting check: ${tokens.size} token(s). ` +
    `Discrepancies found: ${discrepancies.length}`
  );

  return { tokensChecked: tokens.size, discrepancies };
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

export async function runReconciliation(
  server: rpc.Server,
  contractId: string,
  sampleSize = SAMPLE_SIZE,
  fetchListing: FetchListing = fetchListingOnChain,
  fetchAuction: FetchAuction = fetchAuctionOnChain
): Promise<ReconcileResult> {
  const discrepancies: DiscrepancyRecord[] = [];

  // ── Sample active listings ─────────────────────────────────────────────────
  const listings = await prisma.listing.findMany({
    where: { status: 'Active' },
    take: sampleSize,
    orderBy: { updatedAtLedger: 'desc' },
    select: { listingId: true, status: true, price: true },
  });

  for (const listing of listings) {
    const chainState = await fetchListing(server, contractId, listing.listingId);
    if (!chainState) continue; // chain unavailable — skip this record

    if (chainState.status !== listing.status) {
      const rec: DiscrepancyRecord = {
        kind: 'listing',
        id: listing.listingId.toString(),
        field: 'status',
        dbValue: listing.status,
        chainValue: chainState.status,
      };
      discrepancies.push(rec);
      console.warn('[Reconciler] Discrepancy', rec);
      discrepancyCount++;
    }

    if (chainState.price !== listing.price.toString()) {
      const rec: DiscrepancyRecord = {
        kind: 'listing',
        id: listing.listingId.toString(),
        field: 'price',
        dbValue: listing.price.toString(),
        chainValue: chainState.price,
      };
      discrepancies.push(rec);
      console.warn('[Reconciler] Discrepancy', rec);
      discrepancyCount++;
    }
  }

  // ── Sample active auctions ─────────────────────────────────────────────────
  const auctions = await prisma.auction.findMany({
    where: { status: 'Active' },
    take: sampleSize,
    orderBy: { updatedAtLedger: 'desc' },
    select: { auctionId: true, status: true, highestBid: true },
  });

  for (const auction of auctions) {
    const chainState = await fetchAuction(server, contractId, auction.auctionId);
    if (!chainState) continue;

    if (chainState.status !== auction.status) {
      const rec: DiscrepancyRecord = {
        kind: 'auction',
        id: auction.auctionId.toString(),
        field: 'status',
        dbValue: auction.status,
        chainValue: chainState.status,
      };
      discrepancies.push(rec);
      console.warn('[Reconciler] Discrepancy', rec);
      discrepancyCount++;
    }

    if (chainState.highestBid !== auction.highestBid.toString()) {
      const rec: DiscrepancyRecord = {
        kind: 'auction',
        id: auction.auctionId.toString(),
        field: 'highestBid',
        dbValue: auction.highestBid.toString(),
        chainValue: chainState.highestBid,
      };
      discrepancies.push(rec);
      console.warn('[Reconciler] Discrepancy', rec);
      discrepancyCount++;
    }
  }

  console.log(
    `[Reconciler] Sampled ${listings.length} listings, ${auctions.length} auctions. ` +
    `Discrepancies found: ${discrepancies.length}`
  );

  return {
    sampledListings: listings.length,
    sampledAuctions: auctions.length,
    discrepancies,
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
    try {
      await runAccountingReconciliation(server, CONTRACT_ID);
    } catch (err) {
      console.error('[Reconciler] Accounting run failed:', err);
    }
  };

  // Run once immediately, then on interval
  await tick();
  setInterval(tick, RECONCILE_INTERVAL_MS);
}
