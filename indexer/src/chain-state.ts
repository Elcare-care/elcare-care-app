/**
 * chain-state.ts
 *
 * Real on-chain state reader for the marketplace contract.
 *
 * Builds XDR keys matching DataKey::Listing(u64) / DataKey::Auction(u64) from
 * contracts/soroban-marketplace/src/storage.rs, issues getLedgerEntries calls
 * to the Stellar RPC, and decodes the returned ScMap values into typed objects.
 *
 * A simulation-based fallback (get_listing / get_auction view calls) is
 * available and selected when CHAIN_STATE_MODE=simulate.
 */

import {
  rpc,
  xdr,
  StrKey,
  scValToNative,
  nativeToScVal,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Account,
  Keypair,
} from '@stellar/stellar-sdk';
import { withRpcRetry } from './retry.js';
import { logger } from './logger.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface ChainListingState {
  /** "Active" | "Sold" | "Cancelled" */
  status: string;
  /**
   * i128 formatted as "${value}.0000000" to match Prisma Decimal(32,7).toString().
   * Chain stores prices as raw integers; DB stores them as Decimal with 7 decimal
   * places, so toString() appends ".0000000" to any integer input.
   */
  price: string;
  /** Stellar address, or null when Option<Address> is None. */
  owner: string | null;
  /** Ledger timestamp, or null when Option<u64> is None. */
  expiresAt: bigint | null;
}

export interface ChainAuctionState {
  /** "Active" | "Finalized" | "Cancelled" */
  status: string;
  /** i128 formatted as "${value}.0000000" */
  highestBid: string;
  /** Stellar address, or null when Option<Address> is None. */
  highestBidder: string | null;
  /** u64 as decimal string — matches Prisma BigInt.toString(). */
  endTime: string;
}

// ── ScVal key construction ────────────────────────────────────────────────────

/**
 * Encodes DataKey::Listing(id) as a Soroban contracttype ScMap.
 *
 * DataKey is a mixed enum (unit variants + newtype variants), so ALL variants
 * use the ScMap form:
 *   unit variants   → ScMap([{ ScSymbol("Name"): ScVoid }])
 *   newtype variants → ScMap([{ ScSymbol("Name"): inner_val }])
 *
 * Round-trip test: build the key → XDR-encode → pass to getLedgerEntries.
 */
export function buildListingKey(listingId: bigint): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('Listing'),
      val: nativeToScVal(listingId, { type: 'u64' }),
    }),
  ]);
}

/** Encodes DataKey::Auction(id) in the same contracttype ScMap form. */
export function buildAuctionKey(auctionId: bigint): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('Auction'),
      val: nativeToScVal(auctionId, { type: 'u64' }),
    }),
  ]);
}

/**
 * Wraps a contract-data ScVal key into an XDR LedgerKey for persistent storage.
 * Exported so tests can verify key serialisation without calling an RPC node.
 */
export function buildLedgerKey(contractId: string, dataKey: xdr.ScVal): xdr.LedgerKey {
  const contractBytes = StrKey.decodeContract(contractId);
  const scAddress = xdr.ScAddress.scAddressTypeContract(contractBytes);
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: scAddress,
      key: dataKey,
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
}

// ── Decoding helpers ──────────────────────────────────────────────────────────

const LISTING_STATUSES = new Set(['Active', 'Sold', 'Cancelled']);
const AUCTION_STATUSES = new Set(['Active', 'Finalized', 'Cancelled']);

function requireStatus(val: unknown, validSet: Set<string>, context: string): string {
  if (typeof val === 'string' && validSet.has(val)) return val;
  throw new Error(`[chain-state] Unexpected ${context} status: ${JSON.stringify(val)}`);
}

/**
 * Formats a Soroban i128 bigint as a Decimal(32,7)-compatible string.
 *
 * Prisma stores integer i128 values (e.g. 1_000_000_000n) as
 * "1000000000.0000000" in a Decimal(32,7) column; .toString() reproduces that
 * exact string.  Formatting here ensures direct string comparison works without
 * additional parsing overhead in the reconciler hot-path.
 */
export function formatDecimal7(value: unknown): string {
  let bi: bigint;
  if (typeof value === 'bigint') {
    bi = value;
  } else if (typeof value === 'string') {
    bi = BigInt(value);
  } else if (typeof value === 'number') {
    bi = BigInt(Math.trunc(value));
  } else {
    throw new Error(`[chain-state] Cannot format i128: ${JSON.stringify(value)}`);
  }
  return `${bi}.0000000`;
}

function parseOptionalAddress(val: unknown): string | null {
  // Soroban Option<Address> → None encodes as ScVoid → scValToNative returns undefined.
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val;
  return null;
}

function parseOptionalU64(val: unknown): bigint | null {
  // Soroban Option<u64> → None encodes as ScVoid → scValToNative returns undefined.
  if (val === null || val === undefined) return null;
  if (typeof val === 'bigint') return val;
  if (typeof val === 'string') return BigInt(val);
  return null;
}

/**
 * Decodes a scValToNative()-produced object into ChainListingState.
 * Exported so unit tests can exercise XDR decode directly from fixture data.
 */
export function decodeListingEntry(native: Record<string, unknown>): ChainListingState {
  return {
    status:    requireStatus(native['status'], LISTING_STATUSES, 'listing'),
    price:     formatDecimal7(native['price']),
    owner:     parseOptionalAddress(native['owner']),
    expiresAt: parseOptionalU64(native['expires_at']),
  };
}

/**
 * Decodes a scValToNative()-produced object into ChainAuctionState.
 * Exported so unit tests can exercise XDR decode directly from fixture data.
 */
export function decodeAuctionEntry(native: Record<string, unknown>): ChainAuctionState {
  const endTime = native['end_time'];
  let endTimeStr: string;
  if (typeof endTime === 'bigint') {
    endTimeStr = endTime.toString();
  } else if (typeof endTime === 'string') {
    endTimeStr = endTime;
  } else {
    throw new Error(`[chain-state] Unexpected end_time: ${JSON.stringify(endTime)}`);
  }

  return {
    status:        requireStatus(native['status'], AUCTION_STATUSES, 'auction'),
    highestBid:    formatDecimal7(native['highest_bid']),
    highestBidder: parseOptionalAddress(native['highest_bidder']),
    endTime:       endTimeStr,
  };
}

// ── getLedgerEntries — single-entry reads ─────────────────────────────────────

async function fetchScValByLedgerKey(
  server: rpc.Server,
  ledgerKey: xdr.LedgerKey,
  operation: string
): Promise<xdr.ScVal | null> {
  const response = await withRpcRetry(
    () => server.getLedgerEntries(ledgerKey),
    { operation }
  );
  // Empty entries array means the entry is absent (archived / TTL-expired / never created).
  if (!response.entries || response.entries.length === 0) return null;
  return response.entries[0].val.contractData().val();
}

/**
 * Reads Listing state from chain via getLedgerEntries + direct key construction.
 *
 * Returns null when:
 *  - the entry has expired (TTL) / been archived
 *  - the entry was never created (listing id unknown)
 *  - the RPC call fails after all withRpcRetry attempts
 *
 * The caller should treat null as "chain state unavailable — skip this record".
 */
export async function fetchListingOnChain(
  server: rpc.Server,
  contractId: string,
  listingId: bigint
): Promise<ChainListingState | null> {
  const ledgerKey = buildLedgerKey(contractId, buildListingKey(listingId));
  const scVal = await fetchScValByLedgerKey(
    server, ledgerKey, `getLedgerEntries-listing-${listingId}`
  );
  if (!scVal) return null;
  const native = scValToNative(scVal) as Record<string, unknown>;
  return decodeListingEntry(native);
}

/** Reads Auction state from chain via getLedgerEntries. */
export async function fetchAuctionOnChain(
  server: rpc.Server,
  contractId: string,
  auctionId: bigint
): Promise<ChainAuctionState | null> {
  const ledgerKey = buildLedgerKey(contractId, buildAuctionKey(auctionId));
  const scVal = await fetchScValByLedgerKey(
    server, ledgerKey, `getLedgerEntries-auction-${auctionId}`
  );
  if (!scVal) return null;
  const native = scValToNative(scVal) as Record<string, unknown>;
  return decodeAuctionEntry(native);
}

// ── getLedgerEntries — batch reads (more efficient for reconciler sweeps) ─────

/**
 * Fetches many listings in a single getLedgerEntries RPC call.
 *
 * Returns a Map keyed by listingId.toString() → state (null = not found or
 * decode error).  An RPC failure for the whole batch is caught; all ids map
 * to null so the reconciler can count them as skipped.
 */
export async function fetchListingsBatch(
  server: rpc.Server,
  contractId: string,
  listingIds: bigint[]
): Promise<Map<string, ChainListingState | null>> {
  const result = new Map<string, ChainListingState | null>();
  if (listingIds.length === 0) return result;

  const keys = listingIds.map(id => buildLedgerKey(contractId, buildListingKey(id)));
  const keyIndex = new Map<string, bigint>();
  keys.forEach((k, i) => keyIndex.set(k.toXDR('base64'), listingIds[i]));

  try {
    const response = await withRpcRetry(
      () => server.getLedgerEntries(...keys),
      { operation: 'getLedgerEntries-listings-batch' }
    );

    for (const entry of response.entries) {
      const listingId = keyIndex.get(entry.key.toXDR('base64'));
      if (listingId === undefined) continue;
      try {
        const native = scValToNative(entry.val.contractData().val()) as Record<string, unknown>;
        result.set(listingId.toString(), decodeListingEntry(native));
      } catch (err) {
        logger.warn('[chain-state] Malformed listing entry', {
          listingId: listingId.toString(),
          error: err instanceof Error ? err.message : String(err),
        });
        result.set(listingId.toString(), null);
      }
    }
  } catch (err) {
    logger.error('[chain-state] Batch getLedgerEntries (listings) failed', {
      count: listingIds.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Entries absent from the response → not found / evicted TTL
  for (const id of listingIds) {
    if (!result.has(id.toString())) result.set(id.toString(), null);
  }
  return result;
}

/** Fetches many auctions in a single getLedgerEntries RPC call. */
export async function fetchAuctionsBatch(
  server: rpc.Server,
  contractId: string,
  auctionIds: bigint[]
): Promise<Map<string, ChainAuctionState | null>> {
  const result = new Map<string, ChainAuctionState | null>();
  if (auctionIds.length === 0) return result;

  const keys = auctionIds.map(id => buildLedgerKey(contractId, buildAuctionKey(id)));
  const keyIndex = new Map<string, bigint>();
  keys.forEach((k, i) => keyIndex.set(k.toXDR('base64'), auctionIds[i]));

  try {
    const response = await withRpcRetry(
      () => server.getLedgerEntries(...keys),
      { operation: 'getLedgerEntries-auctions-batch' }
    );

    for (const entry of response.entries) {
      const auctionId = keyIndex.get(entry.key.toXDR('base64'));
      if (auctionId === undefined) continue;
      try {
        const native = scValToNative(entry.val.contractData().val()) as Record<string, unknown>;
        result.set(auctionId.toString(), decodeAuctionEntry(native));
      } catch (err) {
        logger.warn('[chain-state] Malformed auction entry', {
          auctionId: auctionId.toString(),
          error: err instanceof Error ? err.message : String(err),
        });
        result.set(auctionId.toString(), null);
      }
    }
  } catch (err) {
    logger.error('[chain-state] Batch getLedgerEntries (auctions) failed', {
      count: auctionIds.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  for (const id of auctionIds) {
    if (!result.has(id.toString())) result.set(id.toString(), null);
  }
  return result;
}

// ── Simulation-based fallback ─────────────────────────────────────────────────

// Dummy source — sequence 0 is valid for simulateTransaction (no sequence check).
// Derived from an all-zero seed so it is deterministic but never has real funds.
let _simSource: Account | null = null;
function getSimSource(): Account {
  if (!_simSource) {
    _simSource = new Account(Keypair.fromRawEd25519Seed(Buffer.alloc(32)).publicKey(), '0');
  }
  return _simSource;
}

function resolveNetworkPassphrase(): string {
  return (
    process.env.STELLAR_NETWORK_PASSPHRASE ??
    (process.env.STELLAR_NETWORK === 'mainnet'
      ? 'Public Global Stellar Network ; September 2015'
      : 'Test SDF Network ; September 2015')
  );
}

async function simulateView(
  server: rpc.Server,
  contractId: string,
  method: string,
  args: xdr.ScVal[]
): Promise<Record<string, unknown> | null> {
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(getSimSource(), {
    fee: BASE_FEE,
    networkPassphrase: resolveNetworkPassphrase(),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  try {
    const sim = await withRpcRetry(
      () => server.simulateTransaction(tx),
      { operation: `simulate-${method}` }
    );
    if (rpc.Api.isSimulationError(sim)) return null;
    const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!retval) return null;
    return scValToNative(retval) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Auction configuration reads ─────────────────────────────────────────────────

export interface AuctionConfig {
  minBidIncrement: string; // i128 formatted as "${value}.0000000"
  extensionWindow: string;  // u64 as decimal string
  extensionTrigger: string; // u64 as decimal string
}

/**
 * Reads global auction configuration from the contract via simulateTransaction.
 * Calls get_min_bid_increment, get_auction_extension_window, and get_auction_extension_trigger.
 */
export async function fetchAuctionConfig(
  server: rpc.Server,
  contractId: string
): Promise<AuctionConfig | null> {
  try {
    const [minIncrement, extensionWindow, extensionTrigger] = await Promise.all([
      simulateView(server, contractId, 'get_min_bid_increment', []),
      simulateView(server, contractId, 'get_auction_extension_window', []),
      simulateView(server, contractId, 'get_auction_extension_trigger', []),
    ]);

    if (minIncrement === null || extensionWindow === null || extensionTrigger === null) {
      return null;
    }

    const windowStr = (extensionWindow as unknown as bigint | number | string).toString();
    const triggerStr = (extensionTrigger as unknown as bigint | number | string).toString();

    return {
      minBidIncrement: formatDecimal7(minIncrement),
      extensionWindow: windowStr,
      extensionTrigger: triggerStr,
    };
  } catch (err) {
    logger.error('[chain-state] Failed to fetch auction config', {
      contractId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Reads Listing state via simulateTransaction of get_listing().
 * Use when CHAIN_STATE_MODE=simulate or as a fallback.
 * get_listing panics with ListingNotFound if the id does not exist → sim error → null.
 */
export async function fetchListingOnChainSimulate(
  server: rpc.Server,
  contractId: string,
  listingId: bigint
): Promise<ChainListingState | null> {
  const args = [nativeToScVal(listingId, { type: 'u64' })];
  const native = await simulateView(server, contractId, 'get_listing', args);
  if (!native) return null;
  return decodeListingEntry(native);
}

/**
 * Reads Auction state via simulateTransaction of get_auction().
 * Use when CHAIN_STATE_MODE=simulate or as a fallback.
 */
export async function fetchAuctionOnChainSimulate(
  server: rpc.Server,
  contractId: string,
  auctionId: bigint
): Promise<ChainAuctionState | null> {
  const args = [nativeToScVal(auctionId, { type: 'u64' })];
  const native = await simulateView(server, contractId, 'get_auction', args);
  if (!native) return null;
  return decodeAuctionEntry(native);
}

// ── Raw-struct readers (for poller event enrichment) ─────────────────────────
//
// The poller's LISTING_CREATED / AUCTION_CREATED handlers optionally enrich
// event payload data with authoritative on-chain values (artist, currency,
// recipients, etc.).  These functions return the full scValToNative() object
// so callers can access any field without re-decoding.

/**
 * Returns the full on-chain Listing struct as a native JS object (all fields),
 * or null when the listing doesn't exist / the RPC call fails.
 */
export async function fetchRawListingFromChain(
  server: rpc.Server,
  contractId: string,
  listingId: bigint
): Promise<Record<string, unknown> | null> {
  if (!contractId) return null;
  return simulateView(server, contractId, 'get_listing', [
    nativeToScVal(listingId, { type: 'u64' }),
  ]);
}

/**
 * Returns the full on-chain Auction struct as a native JS object (all fields),
 * or null when the auction doesn't exist / the RPC call fails.
 */
export async function fetchRawAuctionFromChain(
  server: rpc.Server,
  contractId: string,
  auctionId: bigint
): Promise<Record<string, unknown> | null> {
  if (!contractId) return null;
  return simulateView(server, contractId, 'get_auction', [
    nativeToScVal(auctionId, { type: 'u64' }),
  ]);
}

// ── Mode dispatcher ───────────────────────────────────────────────────────────

/**
 * Returns the appropriate listing reader based on CHAIN_STATE_MODE env var.
 *   ledger_entries (default) — getLedgerEntries with hand-built DataKey
 *   simulate                  — simulateTransaction of get_listing
 */
export function getListingReader(): (
  server: rpc.Server,
  contractId: string,
  listingId: bigint
) => Promise<ChainListingState | null> {
  return process.env.CHAIN_STATE_MODE === 'simulate'
    ? fetchListingOnChainSimulate
    : fetchListingOnChain;
}

/** Returns the appropriate auction reader based on CHAIN_STATE_MODE. */
export function getAuctionReader(): (
  server: rpc.Server,
  contractId: string,
  auctionId: bigint
) => Promise<ChainAuctionState | null> {
  return process.env.CHAIN_STATE_MODE === 'simulate'
    ? fetchAuctionOnChainSimulate
    : fetchAuctionOnChain;
}

// ── Offer types + key construction ────────────────────────────────────────────

export interface ChainOfferState {
  /** "Pending" | "Accepted" | "Rejected" | "Withdrawn" */
  status: string;
  /** i128 formatted as "${value}.0000000" */
  amount: string;
  /** Stellar address of the offerer. */
  offerer: string | null;
  /** Ledger timestamp, or null when Option<u64> is None. */
  expiresAt: bigint | null;
}

const OFFER_STATUSES = new Set(['Pending', 'Accepted', 'Rejected', 'Withdrawn']);

/** Encodes DataKey::Offer(id) — same contracttype ScMap pattern as Listing/Auction. */
export function buildOfferKey(offerId: bigint): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('Offer'),
      val: nativeToScVal(offerId, { type: 'u64' }),
    }),
  ]);
}

/**
 * Decodes a scValToNative()-produced object into ChainOfferState.
 * Matches the on-chain Offer struct fields: status, amount, offerer, expires_at.
 */
export function decodeOfferEntry(native: Record<string, unknown>): ChainOfferState {
  return {
    status:    requireStatus(native['status'], OFFER_STATUSES, 'offer'),
    amount:    formatDecimal7(native['amount']),
    offerer:   parseOptionalAddress(native['offerer']),
    expiresAt: parseOptionalU64(native['expires_at']),
  };
}

/** Reads Offer state from chain via getLedgerEntries. */
export async function fetchOfferOnChain(
  server: rpc.Server,
  contractId: string,
  offerId: bigint
): Promise<ChainOfferState | null> {
  const ledgerKey = buildLedgerKey(contractId, buildOfferKey(offerId));
  const scVal = await fetchScValByLedgerKey(
    server, ledgerKey, `getLedgerEntries-offer-${offerId}`
  );
  if (!scVal) return null;
  const native = scValToNative(scVal) as Record<string, unknown>;
  return decodeOfferEntry(native);
}

/** Fetches many offers in a single getLedgerEntries RPC call. */
export async function fetchOffersBatch(
  server: rpc.Server,
  contractId: string,
  offerIds: bigint[]
): Promise<Map<string, ChainOfferState | null>> {
  const result = new Map<string, ChainOfferState | null>();
  if (offerIds.length === 0) return result;

  const keys = offerIds.map(id => buildLedgerKey(contractId, buildOfferKey(id)));
  const keyIndex = new Map<string, bigint>();
  keys.forEach((k, i) => keyIndex.set(k.toXDR('base64'), offerIds[i]));

  try {
    const response = await withRpcRetry(
      () => server.getLedgerEntries(...keys),
      { operation: 'getLedgerEntries-offers-batch' }
    );

    for (const entry of response.entries) {
      const offerId = keyIndex.get(entry.key.toXDR('base64'));
      if (offerId === undefined) continue;
      try {
        const native = scValToNative(entry.val.contractData().val()) as Record<string, unknown>;
        result.set(offerId.toString(), decodeOfferEntry(native));
      } catch (err) {
        logger.warn('[chain-state] Malformed offer entry', {
          offerId: offerId.toString(),
          error: err instanceof Error ? err.message : String(err),
        });
        result.set(offerId.toString(), null);
      }
    }
  } catch (err) {
    logger.error('[chain-state] Batch getLedgerEntries (offers) failed', {
      count: offerIds.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  for (const id of offerIds) {
    if (!result.has(id.toString())) result.set(id.toString(), null);
  }
  return result;
}

/** Returns the offer reader (always getLedgerEntries; no simulate fallback). */
export function getOfferReader(): (
  server: rpc.Server,
  contractId: string,
  offerId: bigint
) => Promise<ChainOfferState | null> {
  return fetchOfferOnChain;
}

// ── Collection state (launchpad contract) ─────────────────────────────────────

export interface ChainCollectionState {
  /**
   * platform_fee_bps from the launchpad contract's CollectionRecord.
   * Matches DB feeBpsOverride (null means no override / global fee applies).
   */
  feeBpsOverride: number | null;
  /** "Normal721" | "Normal1155" | "LazyMint721" | "LazyMint1155" */
  kind: string | null;
  /** Creator address string, or null when unavailable. */
  creator: string | null;
}

/**
 * Decodes a scValToNative()-produced CollectionRecord into ChainCollectionState.
 * Fields: address, kind, creator, name, symbol, ledger, platform_fee_bps.
 */
export function decodeCollectionEntry(native: Record<string, unknown>): ChainCollectionState {
  const raw = native['platform_fee_bps'];
  const feeBpsOverride: number | null =
    typeof raw === 'number' ? raw :
    typeof raw === 'bigint' ? Number(raw) :
    null;

  const kind = native['kind'];
  const kindStr: string | null = typeof kind === 'string' ? kind : null;

  const creator = native['creator'];
  const creatorStr: string | null = typeof creator === 'string' ? creator : null;

  return { feeBpsOverride, kind: kindStr, creator: creatorStr };
}

/**
 * Reads Collection state via simulateTransaction of get_collection() on the
 * launchpad contract.  Returns null when the collection is not registered or
 * the launchpad contract ID is empty.
 */
export async function fetchCollectionOnChain(
  server: rpc.Server,
  launchpadContractId: string,
  collectionAddress: string
): Promise<ChainCollectionState | null> {
  if (!launchpadContractId) return null;
  const args = [nativeToScVal(collectionAddress, { type: 'address' })];
  const native = await simulateView(server, launchpadContractId, 'get_collection', args);
  if (native == null) return null;
  return decodeCollectionEntry(native as Record<string, unknown>);
}

/**
 * Reads the per-collection fee override from the marketplace contract via
 * simulateTransaction of get_collection_fee_bps(collection: Address) -> Option<u32>.
 *
 * Returns null when no override is set (contract returns None) or on error.
 */
export async function fetchCollectionFeeBpsFromMarketplace(
  server: rpc.Server,
  marketplaceContractId: string,
  collectionAddress: string
): Promise<number | null> {
  if (!marketplaceContractId) return null;
  const args = [nativeToScVal(collectionAddress, { type: 'address' })];
  try {
    const raw = await simulateView(server, marketplaceContractId, 'get_collection_fee_bps', args);
    if (raw == null) return null;
    const n = Number(raw);
    return isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

/** Returns the collection reader (launchpad get_collection via simulate). */
export function getCollectionReader(): (
  server: rpc.Server,
  launchpadContractId: string,
  address: string
) => Promise<ChainCollectionState | null> {
  return fetchCollectionOnChain;
}
