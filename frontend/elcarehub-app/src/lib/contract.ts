// ─────────────────────────────────────────────────────────────
// lib/contract.ts — Soroban Marketplace contract client
//
// All blockchain interaction flows through this module.
// It builds transactions, simulates them, and submits via
// Stellar SDK + Freighter signing.
// ─────────────────────────────────────────────────────────────

import {
  Contract,
  SorobanRpc,
  Transaction,
  TransactionBuilder,
  xdr,
  nativeToScVal,
  scValToNative,
  Address,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { config } from "./config";
import { getConnectedPublicKey, signWithFreighter } from "./freighter";
import { mapSorobanErrorMessage } from "./errors";
import { assertWritePreflight } from "./preflight";
import {
  buildTransactionIntent,
  assertIntentsMatch,
  intentsMatch,
  TransactionIntent,
  TxIntentMismatchError,
} from "./tx-intent";
import { walletTelemetry } from "./wallet-telemetry";
import {
  isE2eMockChain,
  e2eMockCreateListing,
  e2eMockBuyArtwork,
  getE2eMockListings,
  registerE2eMockListingsOnWindow,
} from "./e2e-chain-mock";
import {
  DEFAULT_TOKEN,
  TokenConfig,
  getTokenConfigByAddress,
} from "@/config/tokens";
import { fetchListings, fetchAuctions } from "./indexer";

// ── Types mirrored from the Rust contract ────────────────────

export type ListingStatus = "Active" | "Sold" | "Cancelled";

export interface Recipient {
  address: string;
  percentage: number;
}

export interface Listing {
  listing_id: number;
  artist: string;
  metadata_cid?: string;
  collection: string;
  token_id: number;
  price: bigint;
  currency: string;
  token: string;
  recipients: Recipient[];
  status: ListingStatus;
  owner: string | null;
  created_at: number;
  expires_at?: number;
  quantity?: number;
}

export interface BatchCreateListingInput {
  price: number;
  tokenAddress?: string;
  collectionAddress: string;
  nftTokenId: number;
  quantity?: number;
  recipients?: Array<{ address: string; percentage: number }>;
  expiresAt?: number | null;
}

export interface BatchUpdateListingInput {
  listingId: number;
  newPrice: number;
  newTokenAddress: string;
  newRecipients?: Array<{ address: string; percentage: number }>;
}

export type AuctionStatus = "Active" | "Finalized" | "Cancelled";

export interface Auction {
  auction_id: number;
  creator: string;
  metadata_cid?: string;
  collection: string;
  token_id: number;
  token: string;
  reserve_price: bigint;
  highest_bid: bigint;
  highest_bidder: string | null;
  end_time: number;
  status: AuctionStatus;
  recipients: Recipient[];
  created_at: number;
  /** Maximum number of extensions allowed (0 = unlimited) */
  max_extensions?: number;
  /** Running count of extensions applied so far */
  extension_count?: number;
  /** Original end time set at auction creation, used to enforce total duration cap */
  original_end_time?: number;
}

// ── Soroban RPC server ────────────────────────────────────────

function getRpc(): SorobanRpc.Server {
  return new SorobanRpc.Server(config.rpcUrl, { allowHttp: false });
}

export function getContract(contractId: string = config.contractId): Contract {
  return new Contract(contractId);
}

function getNetworkPassphrase(): string {
  return config.networkPassphrase;
}


const READ_ONLY_CALLER_PUBLIC_KEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

async function getReadOnlyCallerPublicKey(): Promise<string> {
  const connectedPublicKey = await getConnectedPublicKey();
  return connectedPublicKey ?? READ_ONLY_CALLER_PUBLIC_KEY;
}
function resolveConfiguredToken(tokenAddress: string = DEFAULT_TOKEN.address): TokenConfig {
  const token = getTokenConfigByAddress(tokenAddress);
  if (!token) {
    throw new Error(`Unsupported token address: ${tokenAddress}`);
  }

  return token;
}

// ── Invoke helper ─────────────────────────────────────────────

/**
 * Builds, simulates, signs (via Freighter), and submits a contract
 * invocation transaction. Returns the simulation result for read-only
 * calls, or the ledger result for state-changing calls.
 */
export async function invokeContract(
  callerPublicKey: string,
  method: string,
  args: xdr.ScVal[],
  readonly = false,
  contractId: string = config.contractId,
  /**
   * Optional canonical intent the confirmation UI actually displayed to the
   * user before they clicked "confirm". When provided, it is compared
   * against the intent re-derived from the transaction that is actually
   * about to be handed to the wallet (Issue #536) — any mismatch aborts
   * signing. Omit for write flows that don't yet have a dedicated
   * confirmation UI; the self-consistency check below still applies to
   * every write call regardless.
   */
  expectedIntent?: TransactionIntent
): Promise<xdr.ScVal> {
  const readableError = (raw: string, fallback: string): Error => {
    const mapped = mapSorobanErrorMessage(raw);
    return new Error(mapped ?? fallback);
  };

  const rpc = getRpc();
  const contract = getContract(contractId);

  // Fetch the caller's account for the sequence number.
  const account = await rpc.getAccount(callerPublicKey);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  // Simulate to get the resource fee + footprint.
  const simResult = await rpc.simulateTransaction(tx);

  if (SorobanRpc.Api.isSimulationError(simResult)) {
    const raw = String(simResult.error ?? "");
    throw readableError(raw, "Unable to simulate this transaction.");
  }

  if (readonly) {
    // For read-only calls return the simulated result directly.
    const retVal = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    if (!retVal) throw new Error("No return value from simulation.");
    return retVal;
  }

  // ── Preflight guard (Issue #305) ─────────────────────────────────────
  // Re-validate network and contract config immediately before signing.
  // Catches mid-flow network switches that happened after the wallet was
  // initially connected.
  try {
    const walletPassphrase = await (async () => {
      try {
        // getNetworkPassphrase() returns the app-configured value.
        // To detect a *live* wallet mismatch we query Freighter directly
        // when available; if not available we trust the app config.
        if (typeof window !== "undefined" && (window as any)?.freighter?.getNetworkDetails) {
          const details = await (window as any).freighter.getNetworkDetails();
          return details?.networkPassphrase ?? null;
        }
      } catch { /* ignore */ }
      return null; // Magic or unavailable — skip network check
    })();

    assertWritePreflight({
      walletPassphrase,
      isConnected: true,          // we have a callerPublicKey, so connected
      contractId,
      skipNetworkCheck: walletPassphrase === null,
    });
  } catch (preflightErr) {
    if (preflightErr instanceof Error && preflightErr.name === "PreflightError") {
      throw preflightErr;
    }
    // Re-throw unexpected errors from the preflight query
    throw preflightErr;
  }

  // Assemble the transaction with the real resource fee.
  const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
  const txXdr = preparedTx.toXDR();

  // ── Transaction-substitution guard (Issue #536) ─────────────────────────
  // The preflight guard above checks network + contract identity before we
  // even build a transaction. This guard checks the transaction itself,
  // right at the boundary where it is handed to the wallet.
  //
  // We independently re-derive the canonical intent twice:
  //   1. From `preparedTx` — the in-memory object we just assembled.
  //   2. From `txXdr` — the literal XDR string about to be passed into
  //      `signWithFreighter` (the wallet adapter call). Re-parsing it from
  //      scratch (rather than trusting `preparedTx` was not mutated after
  //      assembly) is what makes this a check of the exact bytes the wallet
  //      will see, not just the object we happened to build a moment ago.
  //
  // If those two disagree, something altered the transaction between
  // "assembled" and "about to sign" — a compromised bundle, a malicious
  // extension shim wrapping our signing call, or similar tampering — and we
  // must not ask the wallet to sign it.
  //
  // When the calling UI supplied `expectedIntent` (the intent it actually
  // rendered to the user, e.g. CheckoutModal), that is compared too — this
  // is the literal "confirmation summary vs. exact args sent to the wallet"
  // check the threat model calls for.
  const assembledIntent = buildTransactionIntent(preparedTx);
  let verifiedIntent: TransactionIntent;
  try {
    const reparsedTx = TransactionBuilder.fromXDR(txXdr, getNetworkPassphrase());
    verifiedIntent = buildTransactionIntent(reparsedTx as Transaction);
  } catch {
    walletTelemetry.txIntentMismatch(
      "pre_sign_xdr_decode",
      method,
      contractId,
      ["xdr_decode_failed"]
    );
    throw new TxIntentMismatchError(
      "Transaction verification failed: could not re-verify the transaction immediately before signing. " +
        "For your safety, signing has been stopped.",
      ["xdr_decode_failed"]
    );
  }

  const selfCheck = intentsMatch(assembledIntent, verifiedIntent);
  if (!selfCheck.matches) {
    walletTelemetry.txIntentMismatch(
      "pre_sign_self_check",
      method,
      contractId,
      selfCheck.mismatchedFields
    );
    throw new TxIntentMismatchError(
      "Transaction verification failed: the transaction about to be signed does not match the transaction " +
        "that was just built. For your safety, signing has been stopped before your wallet was asked to sign.",
      selfCheck.mismatchedFields
    );
  }

  if (expectedIntent) {
    try {
      assertIntentsMatch(expectedIntent, verifiedIntent, "confirmation_ui_vs_signing_tx");
    } catch (mismatchErr) {
      const fields =
        mismatchErr instanceof TxIntentMismatchError ? mismatchErr.mismatchedFields : ["unknown"];
      walletTelemetry.txIntentMismatch("confirmation_ui_vs_signing_tx", method, contractId, fields);
      throw mismatchErr;
    }
  }

  // Sign via Freighter.
  const signedXdr = await signWithFreighter(txXdr, getNetworkPassphrase());

  // Submit.
  const submitted = await rpc.sendTransaction(
    TransactionBuilder.fromXDR(signedXdr, getNetworkPassphrase())
  );

  if (submitted.status === "ERROR") {
    const raw = String(submitted.errorResult ?? "");
    throw readableError(raw, "Transaction submission failed.");
  }

  // Poll for completion.
  let getResult = await rpc.getTransaction(submitted.hash);
  while (
    getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND
  ) {
    await new Promise((r) => setTimeout(r, 1000));
    getResult = await rpc.getTransaction(submitted.hash);
  }

  if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    const raw = JSON.stringify(getResult);
    throw readableError(raw, "Transaction failed on-chain. Please try again.");
  }

  const successResult =
    getResult as SorobanRpc.Api.GetSuccessfulTransactionResponse;
  return successResult.returnValue ?? xdr.ScVal.scvVoid();
}

// ── ScVal parsing ─────────────────────────────────────────────

function parseRecipient(obj: any): Recipient {
  return {
    address: (obj["address"] as Address).toString(),
    percentage: Number(obj["percentage"]),
  };
}

function parseListingFromScVal(raw: unknown): Listing {
  const obj = scValToNative(raw as xdr.ScVal) as Record<string, unknown>;

  const expiresAtRaw = obj["expires_at"];
  const expires_at =
    expiresAtRaw != null ? Number(expiresAtRaw) : undefined;

  return {
    listing_id: Number(obj["listing_id"]),
    artist: (obj["artist"] as Address).toString(),
    collection: (obj["collection"] as any).toString(),
    token_id: Number(obj["nft_token_id"]),
    price: BigInt(obj["price"] as bigint),
    currency: String(obj["currency"]),
    token: (obj["token"] as any).toString(),
    recipients: (obj["recipients"] as any[]).map(parseRecipient),
    status: String(obj["status"]) as ListingStatus,
    owner: obj["owner"] ? (obj["owner"] as any).toString() : null,
    created_at: Number(obj["created_at"]),
    ...(expires_at !== undefined && { expires_at }),
  };
}

function parseAuctionFromScVal(raw: unknown): Auction {
  const obj = scValToNative(raw as xdr.ScVal) as Record<string, unknown>;

  return {
    auction_id: Number(obj["auction_id"]),
    creator: (obj["creator"] as Address).toString(),
    collection: (obj["collection"] as any).toString(),
    token_id: Number(obj["nft_token_id"]),
    token: (obj["token"] as any).toString(),
    reserve_price: BigInt(obj["reserve_price"] as bigint),
    highest_bid: BigInt(obj["highest_bid"] as bigint),
    highest_bidder: obj["highest_bidder"] ? (obj["highest_bidder"] as any).toString() : null,
    end_time: Number(obj["end_time"]),
    status: String(obj["status"]) as AuctionStatus,
    recipients: (obj["recipients"] as any[]).map(parseRecipient),
    created_at: Number(obj["created_at"] || 0),
    extension_count: obj["extension_count"] != null ? Number(obj["extension_count"]) : 0,
    max_extensions: obj["max_extensions"] != null ? Number(obj["max_extensions"]) : 0,
    original_end_time: obj["original_end_time"] != null ? Number(obj["original_end_time"]) : undefined,
  };
}

function toScRecipientVec(recipients: Array<{ address: string; percentage: number }>): xdr.ScVal {
  return nativeToScVal(
    recipients.map((r) => ({
      address: new Address(r.address),
      percentage: r.percentage,
    })),
    { type: "vec" }
  );
}

// ── Listing contract methods ──────────────────────────────────

/**
 * create_listing — Artist creates a new on-chain listing.
 */
export async function createListing(
  artistPublicKey: string,
  price: number,
  tokenAddress: string = DEFAULT_TOKEN.address,
  collectionAddress: string,
  nftTokenId: number,
  recipients: Array<{ address: string; percentage: number }> = []
): Promise<number> {
  if (isE2eMockChain()) {
    if (typeof window !== "undefined") registerE2eMockListingsOnWindow();
    return e2eMockCreateListing(
      artistPublicKey,
      price,
      tokenAddress,
      collectionAddress,
      nftTokenId
    );
  }

  const priceStroops = xlmToStroops(price);
  const selectedToken = resolveConfiguredToken(tokenAddress);

  // If no recipients provided, default to 100% to the artist
  const finalRecipients = recipients.length > 0 
    ? recipients 
    : [{ address: artistPublicKey, percentage: 100 }];

  const args: xdr.ScVal[] = [
    new Address(artistPublicKey).toScVal(),
    nativeToScVal(priceStroops, { type: "i128" }),
    nativeToScVal(selectedToken.symbol, { type: "symbol" }),
    new Address(selectedToken.address).toScVal(),
    new Address(collectionAddress).toScVal(),
    nativeToScVal(nftTokenId, { type: "u64" }),
    toScRecipientVec(finalRecipients),
  ];

  const retVal = await invokeContract(artistPublicKey, "create_listing", args);
  return Number(scValToNative(retVal));
}

/**
 * buy_artwork — Buyer purchases a listed artwork.
 *
 * @param expectedIntent  Optional canonical intent (Issue #536) built by the
 *                         confirmation UI (see `buildExpectedBuyArtworkIntent`
 *                         in lib/tx-intent.ts) from the same buyer/listing
 *                         the user confirmed. When supplied, it is verified
 *                         against the transaction actually about to be
 *                         signed — any mismatch aborts before the wallet is
 *                         asked to sign.
 */
export async function buyArtwork(
  buyerPublicKey: string,
  listingId: number,
  expectedIntent?: TransactionIntent
): Promise<boolean> {
  if (isE2eMockChain()) {
    if (typeof window !== "undefined") registerE2eMockListingsOnWindow();
    return e2eMockBuyArtwork(buyerPublicKey, listingId);
  }

  const args: xdr.ScVal[] = [
    new Address(buyerPublicKey).toScVal(),
    nativeToScVal(BigInt(listingId), { type: "u64" }),
  ];

  await invokeContract(buyerPublicKey, "buy_artwork", args, false, config.contractId, expectedIntent);
  return true;
}

/**
 * cancel_listing — Artist cancels their active listing.
 */
export async function cancelListing(
  artistPublicKey: string,
  listingId: number
): Promise<boolean> {
  const args: xdr.ScVal[] = [
    new Address(artistPublicKey).toScVal(),
    nativeToScVal(BigInt(listingId), { type: "u64" }),
  ];

  await invokeContract(artistPublicKey, "cancel_listing", args);
  return true;
}

export async function createListings(
  artistPublicKey: string,
  requests: BatchCreateListingInput[]
): Promise<number[]> {
  if (isE2eMockChain()) {
    if (typeof window !== "undefined") registerE2eMockListingsOnWindow();
    return requests.map((request) => e2eMockCreateListing(
      artistPublicKey,
      request.price,
      request.tokenAddress ?? DEFAULT_TOKEN.address,
      request.collectionAddress,
      request.nftTokenId
    ));
  }

  const payload = requests.map((request) => {
    const priceStroops = xlmToStroops(request.price);
    const selectedToken = resolveConfiguredToken(request.tokenAddress ?? DEFAULT_TOKEN.address);
    const finalRecipients = (request.recipients && request.recipients.length > 0)
      ? request.recipients
      : [{ address: artistPublicKey, percentage: 100 }];

    return {
      price: priceStroops,
      currency: selectedToken.symbol,
      token: new Address(selectedToken.address),
      collection: new Address(request.collectionAddress),
      token_id: request.nftTokenId,
      recipients: finalRecipients.map((r) => ({
        address: new Address(r.address),
        percentage: r.percentage,
      })),
      expires_at: request.expiresAt ?? null,
    };
  });

  const args: xdr.ScVal[] = [
    new Address(artistPublicKey).toScVal(),
    nativeToScVal(payload, { type: "vec" }),
  ];

  const retVal = await invokeContract(artistPublicKey, "create_listings", args);
  return (scValToNative(retVal) as bigint[]).map(Number);
}

export async function cancelListings(
  artistPublicKey: string,
  listingIds: number[]
): Promise<boolean> {
  const args: xdr.ScVal[] = [
    new Address(artistPublicKey).toScVal(),
    nativeToScVal(listingIds.map((id) => BigInt(id)), { type: "vec" }),
  ];

  await invokeContract(artistPublicKey, "cancel_listings", args);
  return true;
}

/**
 * update_listing — Artist updates an active listing with new metadata or price.
 */
export async function updateListing(
  artistPublicKey: string,
  listingId: number,
  newMetadataCid: string,
  newPrice: number,
  newTokenAddress: string,
  newRecipients: Array<{ address: string; percentage: number }> = []
): Promise<boolean> {
  const priceStroops = xlmToStroops(newPrice);
  const selectedToken = resolveConfiguredToken(newTokenAddress);

  const args: xdr.ScVal[] = [
    new Address(artistPublicKey).toScVal(),
    nativeToScVal(BigInt(listingId), { type: "u64" }),
    nativeToScVal(priceStroops, { type: "i128" }),
    new Address(selectedToken.address).toScVal(),
    toScRecipientVec(newRecipients),
  ];

  await invokeContract(artistPublicKey, "update_listing", args);
  return true;
}

export async function updateListings(
  artistPublicKey: string,
  requests: BatchUpdateListingInput[]
): Promise<boolean> {
  const payload = requests.map((request) => ({
    listing_id: BigInt(request.listingId),
    new_price: xlmToStroops(request.newPrice),
    new_token: new Address(request.newTokenAddress),
    new_recipients: (request.newRecipients && request.newRecipients.length > 0
      ? request.newRecipients
      : [{ address: artistPublicKey, percentage: 100 }]
    ).map((r) => ({
      address: new Address(r.address),
      percentage: r.percentage,
    })),
  }));

  const args: xdr.ScVal[] = [
    new Address(artistPublicKey).toScVal(),
    nativeToScVal(payload, { type: "vec" }),
  ];

  await invokeContract(artistPublicKey, "update_listings", args);
  return true;
}

/**
 * get_listing — Fetch a single listing by ID.
 */
export async function getListing(listingId: number): Promise<Listing> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();
  const args = [nativeToScVal(BigInt(listingId), { type: "u64" })];
  const retVal = await invokeContract(callerPublicKey, "get_listing", args, true);
  return parseListingFromScVal(retVal);
}

/**
 * get_total_listings — Read the total listing count.
 */
export async function getTotalListings(): Promise<number> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();
  const retVal = await invokeContract(callerPublicKey, "get_total_listings", [], true);
  return Number(scValToNative(retVal));
}

/**
 * get_artist_listings — Fetch all listing IDs for an artist.
 */
export async function getArtistListings(artistPublicKey: string): Promise<number[]> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();
  const args = [new Address(artistPublicKey).toScVal()];
  const retVal = await invokeContract(callerPublicKey, "get_artist_listings", args, true);
  const ids = scValToNative(retVal) as bigint[];
  return ids.map(Number);
}

/**
 * getAllListings — Fetch listings using indexer if possible, fallback to on-chain scan.
 * getAllListings — Fetch every listing from ID 1 up to total.
 * Uses batching to avoid excessive parallel RPC calls.
 */
export async function getAllListings(): Promise<Listing[]> {
  if (isE2eMockChain()) {
    if (typeof window !== "undefined") registerE2eMockListingsOnWindow();
    return getE2eMockListings();
  }

  // Optimized path: Use the indexer (1 RPC/HTTP call)
  try {
    const res = await fetchListings({ status: "Active" });
    if (res.listings && res.listings.length > 0) {
      return res.listings as Listing[];
    }
  } catch (e) {
    console.warn("[indexer] getAllListings fallback:", e);
  }

  // Backup path: On-chain scan (N RPC calls)
  const total = await getTotalListings();
  const ids = Array.from({ length: total }, (_, i) => i + 1);
  const results = await Promise.all(
    ids.map((id) => getListing(id).catch(() => null))
  );
  return results.filter((l): l is Listing => l !== null);
  const totalRaw = await getTotalListings();
  if (total <= 0) return [];

  const listings: Listing[] = [];
  const BATCH_SIZE = 10;

  for (let offset = 1; offset <= total; offset += BATCH_SIZE) {
    const batchIds = Array.from(
      { length: Math.min(BATCH_SIZE, total - offset + 1) },
      (_, i) => offset + i
    );

    const results = await Promise.all(
      batchIds.map((id) => getListing(id).catch(() => null))
    );

    listings.push(...results.filter((l): l is Listing => l !== null));
  }

  return listings;
}

// ── Offer types mirrored from the Rust contract ──────────────

/**
 * On-chain offer statuses as returned by the contract.
 * "Expired" and "Stale" are client-side derived states — they are never
 * stored on-chain but are computed from expires_at vs the current ledger
 * time, or from indexer freshness metadata.
 */
export type OfferStatus = "Pending" | "Accepted" | "Rejected" | "Withdrawn";

/**
 * Extended UI status that includes client-derived states.
 * - "Expired"  : status is "Pending" AND expires_at is in the past (reclaim available)
 * - "Stale"    : data was fetched too long ago to be trusted (soft warning only)
 */
export type OfferUIStatus = OfferStatus | "Expired" | "Stale";

export interface Offer {
  offer_id: number;
  listing_id: number;
  offerer: string;
  amount: bigint;
  token: string;
  status: OfferStatus;
  created_at: number;
  /** Unix seconds after which the offer expires and can be reclaimed. Absent when the offer never expires. */
  expires_at?: number;
  /**
   * Soroban transaction hash from the escrow deposit (set when the offer was
   * created). Populated by the indexer; absent when not yet indexed.
   */
  escrow_tx_hash?: string;
  /**
   * Soroban transaction hash from the refund/payout event (set when
   * Accepted, Rejected, Withdrawn, or Expired+Reclaimed).
   * Populated by the indexer; absent when the terminal tx is not yet indexed.
   */
  refund_tx_hash?: string;
}

/**
 * Derive the display status for an offer, incorporating client-side
 * "Expired" and "Stale" states that are not stored on-chain.
 *
 * Rules:
 *  - If `isStale` is true, returns "Stale" (soft warning; does not block actions).
 *  - If status is "Pending" and expires_at is defined and in the past → "Expired".
 *  - Otherwise returns the on-chain status unchanged.
 *
 * @param offer        The raw on-chain Offer object.
 * @param nowMs        Current wall-clock time in milliseconds (defaults to Date.now()).
 * @param isStale      Whether the data is considered stale (from indexer freshness).
 */
export function deriveOfferUIStatus(
  offer: Pick<Offer, "status" | "expires_at">,
  nowMs: number = Date.now(),
  isStale = false
): OfferUIStatus {
  if (offer.status === "Pending") {
    if (offer.expires_at != null && offer.expires_at * 1000 <= nowMs) {
      return "Expired";
    }
    if (isStale) return "Stale";
  }
  return offer.status;
}

/**
 * Returns true when the given UI status allows an action to be taken.
 * Only "Pending" offers permit accept / reject / withdraw.
 * "Expired" offers only permit reclaim (handled separately).
 */
export function isOfferActionable(uiStatus: OfferUIStatus): boolean {
  return uiStatus === "Pending" || uiStatus === "Stale";
}

// ── Offer ScVal parsing ──────────────────────────────────────

function parseOfferFromScVal(raw: unknown): Offer {
  const obj = scValToNative(raw as xdr.ScVal) as Record<string, unknown>;

  const expiresAtRaw = obj["expires_at"];
  const expires_at =
    expiresAtRaw != null ? Number(expiresAtRaw) : undefined;

  // escrow_tx_hash and refund_tx_hash are optional indexer-enriched fields;
  // they are not present in the on-chain ScVal but may be injected by the
  // indexer REST layer before the object reaches this parser.
  const escrow_tx_hash =
    typeof obj["escrow_tx_hash"] === "string" ? obj["escrow_tx_hash"] : undefined;
  const refund_tx_hash =
    typeof obj["refund_tx_hash"] === "string" ? obj["refund_tx_hash"] : undefined;

  return {
    offer_id: Number(obj["offer_id"]),
    listing_id: Number(obj["listing_id"]),
    offerer: (obj["offerer"] as Address).toString(),
    amount: BigInt(obj["amount"] as bigint),
    token: (obj["token"] as Address).toString(),
    status: String(obj["status"]) as OfferStatus,
    created_at: Number(obj["created_at"]),
    ...(expires_at !== undefined && { expires_at }),
    ...(escrow_tx_hash !== undefined && { escrow_tx_hash }),
    ...(refund_tx_hash !== undefined && { refund_tx_hash }),
  };
}

// ── Offer contract methods ───────────────────────────────────

export async function makeOffer(
  offererPublicKey: string,
  listingId: number,
  amountXlm: number,
  tokenAddress: string
): Promise<number> {
  const amountStroops = xlmToStroops(amountXlm);
  const args = [
    new Address(offererPublicKey).toScVal(),
    nativeToScVal(BigInt(listingId), { type: "u64" }),
    nativeToScVal(amountStroops, { type: "i128" }),
    new Address(tokenAddress).toScVal(),
  ];
  const retVal = await invokeContract(offererPublicKey, "make_offer", args);
  return Number(scValToNative(retVal));
}

export async function withdrawOffer(offererPublicKey: string, offerId: number): Promise<boolean> {
  const args = [new Address(offererPublicKey).toScVal(), nativeToScVal(BigInt(offerId), { type: "u64" })];
  await invokeContract(offererPublicKey, "withdraw_offer", args);
  return true;
}

// Reclaim the escrowed funds of an expired offer. The contract call is
// permissionless (only the offer_id is passed); the refund always goes to the
// original offerer. `signerPublicKey` is just the source account paying fees.
export async function reclaimOffer(signerPublicKey: string, offerId: number): Promise<boolean> {
  const args = [nativeToScVal(BigInt(offerId), { type: "u64" })];
  await invokeContract(signerPublicKey, "reclaim_offer", args);
  return true;
}

export async function acceptOffer(ownerPublicKey: string, offerId: number): Promise<boolean> {
  const args = [new Address(ownerPublicKey).toScVal(), nativeToScVal(BigInt(offerId), { type: "u64" })];
  await invokeContract(ownerPublicKey, "accept_offer", args);
  return true;
}

export async function rejectOffer(ownerPublicKey: string, offerId: number): Promise<boolean> {
  const args = [new Address(ownerPublicKey).toScVal(), nativeToScVal(BigInt(offerId), { type: "u64" })];
  await invokeContract(ownerPublicKey, "reject_offer", args);
  return true;
}

export async function getOffer(offerId: number): Promise<Offer> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();
  const args = [nativeToScVal(BigInt(offerId), { type: "u64" })];
  const retVal = await invokeContract(callerPublicKey, "get_offer", args, true);
  return parseOfferFromScVal(retVal);
}

export async function getListingOffers(listingId: number): Promise<number[]> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();
  const args = [nativeToScVal(BigInt(listingId), { type: "u64" })];
  const retVal = await invokeContract(callerPublicKey, "get_listing_offers", args, true);
  const ids = scValToNative(retVal) as bigint[];
  return ids.map(Number);
}

export async function getOffererOffers(offererPublicKey: string): Promise<number[]> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();
  const args = [new Address(offererPublicKey).toScVal()];
  const retVal = await invokeContract(callerPublicKey, "get_offerer_offers", args, true);
  const ids = scValToNative(retVal) as bigint[];
  return ids.map(Number);
}

// ── Auction contract methods ──────────────────────────────────

/**
 * create_auction — Artist creates a new on-chain auction.
 *
 * @param creatorPublicKey   Stellar public key of the creator (must match Freighter)
 * @param metadataCid        IPFS CID string of the metadata JSON
 * @param reservePriceXlm    Reserve price in XLM (will be converted to stroops)
 * @param durationSeconds    Auction duration in seconds
 * @returns                  The new auction_id (number)
 */
export async function createAuction(
  creatorPublicKey: string,
  metadataCid: string,
  reservePriceXlm: number,
  durationSeconds: number,
  royaltyBps: number = 0,
  recipients: Array<{ address: string; percentage: number }> = [],
  tokenAddress: string = DEFAULT_TOKEN.address
): Promise<number> {
  const reserveStroops = xlmToStroops(reservePriceXlm);
  const selectedToken = resolveConfiguredToken(tokenAddress);

  const finalRecipients = recipients.length > 0
    ? recipients
    : [{ address: creatorPublicKey, percentage: 100 }];

  const args: xdr.ScVal[] = [
    new Address(creatorPublicKey).toScVal(),
    nativeToScVal(Buffer.from(metadataCid, "utf-8"), { type: "bytes" }),
    new Address(selectedToken.address).toScVal(),
    nativeToScVal(reserveStroops, { type: "i128" }),
    nativeToScVal(BigInt(durationSeconds), { type: "u64" }),
    nativeToScVal(royaltyBps, { type: "u32" }),
    nativeToScVal(finalRecipients.map(r => ({
        address: new Address(r.address),
        percentage: r.percentage
    })), { type: "vec" }),
  ];

  const retVal = await invokeContract(
    creatorPublicKey,
    "create_auction",
    args
  );
  return Number(scValToNative(retVal));
}

/**
 * place_bid — Bidder places a bid on an active auction.
 */
export async function placeBid(
  bidderPublicKey: string,
  auctionId: number,
  amountXlm: number
): Promise<boolean> {
  const amountStroops = xlmToStroops(amountXlm);

  const args: xdr.ScVal[] = [
    new Address(bidderPublicKey).toScVal(),
    nativeToScVal(BigInt(auctionId), { type: "u64" }),
    nativeToScVal(amountStroops, { type: "i128" }),
  ];

  await invokeContract(bidderPublicKey, "place_bid", args);
  return true;
}

/**
 * finalize_auction — Finalize an expired or creator-cancelled auction.
 */
export async function finalizeAuction(
  callerPublicKey: string,
  auctionId: number
): Promise<boolean> {
  const args: xdr.ScVal[] = [
    new Address(callerPublicKey).toScVal(),
    nativeToScVal(BigInt(auctionId), { type: "u64" }),
  ];

  await invokeContract(callerPublicKey, "finalize_auction", args);
  return true;
}

/**
 * update_auction_reserve_price — Creator updates the reserve price of a no-bid
 * active auction (Issue #467).
 */
export async function updateAuctionReservePrice(
  creatorPublicKey: string,
  auctionId: number,
  newPrice: bigint
): Promise<boolean> {
  const args: xdr.ScVal[] = [
    new Address(creatorPublicKey).toScVal(),
    nativeToScVal(BigInt(auctionId), { type: "u64" }),
    nativeToScVal(newPrice, { type: "i128" }),
  ];
  await invokeContract(creatorPublicKey, "update_auction_reserve_price", args);
  return true;
}

/**
 * refund_losing_bid — Losing bidder claims their escrowed amount from a
 * terminal auction (Issue #466). Idempotent: second call returns a stable error.
 */
export async function refundLosingBid(
  bidderPublicKey: string,
  auctionId: number
): Promise<boolean> {
  const args: xdr.ScVal[] = [
    new Address(bidderPublicKey).toScVal(),
    nativeToScVal(BigInt(auctionId), { type: "u64" }),
  ];
  await invokeContract(bidderPublicKey, "refund_losing_bid", args);
  return true;
}

/**
 * block_bidder — Auction creator or admin bars an address from bidding on
 * this auction (anti-shill-bidding registry, Issue #199).
 */
export async function blockBidder(
  callerPublicKey: string,
  auctionId: number,
  bidderAddress: string
): Promise<boolean> {
  const args: xdr.ScVal[] = [
    new Address(callerPublicKey).toScVal(),
    nativeToScVal(BigInt(auctionId), { type: "u64" }),
    new Address(bidderAddress).toScVal(),
  ];

  await invokeContract(callerPublicKey, "block_bidder", args);
  return true;
}

/**
 * unblock_bidder — Remove an address from the auction's blocked-bidder
 * registry (Issue #199).
 */
export async function unblockBidder(
  callerPublicKey: string,
  auctionId: number,
  bidderAddress: string
): Promise<boolean> {
  const args: xdr.ScVal[] = [
    new Address(callerPublicKey).toScVal(),
    nativeToScVal(BigInt(auctionId), { type: "u64" }),
    new Address(bidderAddress).toScVal(),
  ];

  await invokeContract(callerPublicKey, "unblock_bidder", args);
  return true;
}

/**
 * get_blocked_bidders — Read the auction's current blocked-bidder registry
 * (read-only, Issue #199).
 */
export async function getBlockedBidders(auctionId: number): Promise<string[]> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();

  const args: xdr.ScVal[] = [
    nativeToScVal(BigInt(auctionId), { type: "u64" }),
  ];

  const retVal = await invokeContract(
    callerPublicKey,
    "get_blocked_bidders",
    args,
    true
  );

  const addrs = scValToNative(retVal) as string[];
  return addrs.map(String);
}

/**
 * get_auction — Fetch a single auction by ID (read-only).
 */
export async function getAuction(auctionId: number): Promise<Auction> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();

  const args: xdr.ScVal[] = [
    nativeToScVal(BigInt(auctionId), { type: "u64" }),
  ];

  const retVal = await invokeContract(callerPublicKey, "get_auction", args, true);
  return parseAuctionFromScVal(retVal);
}

/**
 * get_artist_auctions — Fetch all auction IDs for an artist.
 */
export async function getArtistAuctions(
  artistPublicKey: string
): Promise<number[]> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();

  const args: xdr.ScVal[] = [new Address(artistPublicKey).toScVal()];

  const retVal = await invokeContract(
    callerPublicKey,
    "get_artist_auctions",
    args,
    true
  );

  const ids = scValToNative(retVal) as bigint[];
  return ids.map(Number);
}

/**
 * getAllAuctions — Fetch auctions using indexer if possible, fallback to on-chain scan.
 */
export async function getAllAuctions(): Promise<Auction[]> {
  // Optimized path: Use the indexer (1 RPC/HTTP call)
  try {
    const raw = await fetchAuctions({ status: "Active" });
    if (raw && raw.length > 0) {
      return raw as Auction[];
    }
  } catch (e) {
    console.warn("[indexer] getAllAuctions fallback:", e);
  }

  // Backup path: On-chain scan (Probing loop)
  // get_total_auctions — Read the total auction count.
  const totalRaw = await getTotalAuctions();
  const total = Math.min(totalRaw, 1000); // Safety limit
  if (total <= 0) return [];

  const auctions: Auction[] = [];
  const BATCH_SIZE = 10;
  
  for (let offset = 1; offset <= total; offset += BATCH_SIZE) {
    const batchIds = Array.from(
      { length: Math.min(BATCH_SIZE, total - offset + 1) },
      (_, i) => offset + i
    );
    
    const results = await Promise.all(
      batchIds.map((id) => getAuction(id).catch(() => null))
    );
    
    auctions.push(...results.filter((a): a is Auction => a !== null));
  }
  
  return auctions;
}

/**
 * get_total_auctions — Read the total auction count.
 */
export async function getTotalAuctions(): Promise<number> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();
  const retVal = await invokeContract(callerPublicKey, "get_total_auctions", [], true);
  return Number(scValToNative(retVal));
}


// ── Utils ───────────────────────────────────────────────────

/**
 * Converts an XLM amount (JS number) to stroops (bigint) using
 * string-based arithmetic to avoid floating-point precision loss.
 *
 * e.g. BigInt(Math.round(0.0000001 * 10_000_000)) === 0n  ← WRONG
 *      xlmToStroops(0.0000001)                          === 1n  ← CORRECT
 */
export function xlmToStroops(xlm: number): bigint {
  const isNegative = xlm < 0;
  const abs = Math.abs(xlm);
  // toFixed(7) gives the correct 7-decimal string without FP drift
  const [whole, frac = ""] = abs.toFixed(7).split(".");
  const fracPadded = frac.padEnd(7, "0").slice(0, 7);
  const result = BigInt(whole) * 10_000_000n + BigInt(fracPadded);
  return isNegative ? -result : result;
}

/** Convert stroops (i128 bigint) to XLM display string */
export function stroopsToXlm(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const frac = stroops % 10_000_000n;

  // Convert components to absolute values for formatting
  const absWhole = whole < 0n ? -whole : whole;
  const absFrac = frac < 0n ? -frac : frac;
  const sign = (whole < 0n || frac < 0n) ? "-" : "";

  let fracStr = absFrac.toString().padStart(7, '0').replace(/0+$/, "");
  return fracStr ? `${sign}${absWhole}.${fracStr}` : `${sign}${absWhole}`;
}

/**
 * revoke_artist — Admin revokes an artist.
 */
export async function revokeArtist(
  adminPublicKey: string,
  artistPublicKey: string
): Promise<boolean> {
  const args: xdr.ScVal[] = [
    new Address(artistPublicKey).toScVal(),
  ];

  await invokeContract(adminPublicKey, "revoke_artist", args);
  return true;
}

/**
 * reinstate_artist — Admin reinstates a revoked artist.
 */
export async function reinstateArtist(
  adminPublicKey: string,
  artistPublicKey: string
): Promise<boolean> {
  const args: xdr.ScVal[] = [
    new Address(artistPublicKey).toScVal(),
  ];

  await invokeContract(adminPublicKey, "reinstate_artist", args);
  return true;
}

/**
 * is_artist_revoked — Check if an artist is revoked.
 */
export async function isArtistRevoked(
  artistPublicKey: string
): Promise<boolean> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();
  const args: xdr.ScVal[] = [
    new Address(artistPublicKey).toScVal(),
  ];

  try {
    const retVal = await invokeContract(callerPublicKey, "is_artist_revoked", args, true);
    return scValToNative(retVal) as boolean;
  } catch {
    return false;
  }
}

/**
 * add_token_to_whitelist — Admin whitelists a token.
 */
export async function addTokenToWhitelist(
  adminPublicKey: string,
  tokenAddress: string
): Promise<boolean> {
  const args: xdr.ScVal[] = [
    new Address(tokenAddress).toScVal(),
  ];

  await invokeContract(adminPublicKey, "add_token_to_whitelist", args);
  return true;
}

/**
 * remove_token_from_whitelist — Admin removes a token from whitelist.
 */
export async function removeTokenFromWhitelist(
  adminPublicKey: string,
  tokenAddress: string
): Promise<boolean> {
  const args: xdr.ScVal[] = [
    new Address(tokenAddress).toScVal(),
  ];

  await invokeContract(adminPublicKey, "remove_token_from_whitelist", args);
  return true;
}

/**
 * get_token_whitelist — Fetch all whitelisted tokens.
 */
export async function getTokenWhitelist(): Promise<string[]> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();
  try {
    const retVal = await invokeContract(callerPublicKey, "get_token_whitelist", [], true);
    const native = scValToNative(retVal) as Address[];
    return native.map(a => a.toString());
  } catch {
    return [];
  }
}

/**
 * get_treasury — Fetch current treasury address.
 */
export async function getTreasury(): Promise<string | null> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();
  try {
    const retVal = await invokeContract(callerPublicKey, "get_treasury", [], true);
    const native = scValToNative(retVal);
    return native ? (native as Address).toString() : null;
  } catch {
    return null;
  }
}

/**
 * get_protocol_fee — Fetch current protocol fee (bps).
 */
export async function getProtocolFee(): Promise<number> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();
  try {
    const retVal = await invokeContract(callerPublicKey, "get_protocol_fee", [], true);
    return Number(scValToNative(retVal));
  } catch {
    return 0;
  }
}

/**
 * get_admin — Fetch current admin address.
 */
export async function getAdmin(): Promise<string | null> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();
  try {
    const retVal = await invokeContract(callerPublicKey, "get_admin", [], true);
    // get_admin returns Option<Address>
    const native = scValToNative(retVal);
    if (!native) return null;
    return (native as Address).toString();
  } catch {
    return null;
  }
}

// ── Admin key rotation (two-step propose → accept, Issue #202) ─────────────────

/** A pending admin-rotation proposal read from `get_pending_admin`. */
export interface PendingAdminProposal {
  /** Address invited to become the new admin. */
  candidate: string;
  /** Absolute unix timestamp (seconds) after which the proposal can no longer be accepted. */
  expiresAt: number;
}

/**
 * transfer_admin — Step 1: the current admin proposes a new admin.
 *
 * The on-chain entry point is `transfer_admin(current_admin, new_admin)`; it
 * stamps the proposal with a 7-day acceptance deadline.
 */
export async function proposeAdmin(
  currentAdminPublicKey: string,
  candidatePublicKey: string
): Promise<boolean> {
  const args: xdr.ScVal[] = [
    new Address(currentAdminPublicKey).toScVal(),
    new Address(candidatePublicKey).toScVal(),
  ];
  await invokeContract(currentAdminPublicKey, "transfer_admin", args);
  return true;
}

/**
 * accept_admin — Step 2: the proposed candidate accepts and becomes admin.
 * Fails on-chain if the proposal has expired or the caller is not the candidate.
 */
export async function acceptAdmin(candidatePublicKey: string): Promise<boolean> {
  const args: xdr.ScVal[] = [new Address(candidatePublicKey).toScVal()];
  await invokeContract(candidatePublicKey, "accept_admin", args);
  return true;
}

/**
 * cancel_admin_proposal — the current admin cancels a still-pending proposal.
 */
export async function cancelAdminProposal(
  currentAdminPublicKey: string
): Promise<boolean> {
  const args: xdr.ScVal[] = [new Address(currentAdminPublicKey).toScVal()];
  await invokeContract(currentAdminPublicKey, "cancel_admin_proposal", args);
  return true;
}

/**
 * get_pending_admin — read the currently-pending admin proposal, or null.
 * Returns `Option<PendingAdminProposal { candidate, expires_at }>`.
 */
export async function getPendingAdmin(): Promise<PendingAdminProposal | null> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();
  try {
    const retVal = await invokeContract(callerPublicKey, "get_pending_admin", [], true);
    const native = scValToNative(retVal) as
      | { candidate: unknown; expires_at: unknown }
      | null
      | undefined;
    if (!native) return null;
    return {
      candidate: (native.candidate as Address).toString(),
      expiresAt: Number(native.expires_at),
    };
  } catch {
    return null;
  }
}

// ── Granular pause controls (Issue #205) ─────────────────────────────────────

/** admin_pause — global circuit-breaker ON. */
export async function adminPause(adminPublicKey: string): Promise<boolean> {
  const args: xdr.ScVal[] = [new Address(adminPublicKey).toScVal()];
  await invokeContract(adminPublicKey, "admin_pause", args);
  return true;
}

/** admin_unpause — global circuit-breaker OFF. */
export async function adminUnpause(adminPublicKey: string): Promise<boolean> {
  const args: xdr.ScVal[] = [new Address(adminPublicKey).toScVal()];
  await invokeContract(adminPublicKey, "admin_unpause", args);
  return true;
}

/** is_paused — read global pause flag. */
export async function getIsContractPaused(): Promise<boolean> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();
  try {
    const retVal = await invokeContract(callerPublicKey, "is_paused", [], true);
    return scValToNative(retVal) as boolean;
  } catch {
    return false;
  }
}

/** pause_collection — pause all operations for a specific collection. */
export async function pauseCollection(
  adminPublicKey: string,
  collectionAddress: string
): Promise<boolean> {
  const args: xdr.ScVal[] = [
    new Address(adminPublicKey).toScVal(),
    new Address(collectionAddress).toScVal(),
  ];
  await invokeContract(adminPublicKey, "pause_collection", args);
  return true;
}

/** unpause_collection — resume a paused collection. */
export async function unpauseCollection(
  adminPublicKey: string,
  collectionAddress: string
): Promise<boolean> {
  const args: xdr.ScVal[] = [
    new Address(adminPublicKey).toScVal(),
    new Address(collectionAddress).toScVal(),
  ];
  await invokeContract(adminPublicKey, "unpause_collection", args);
  return true;
}

/** is_collection_paused — read the pause flag for a specific collection. */
export async function isCollectionPaused(collectionAddress: string): Promise<boolean> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();
  try {
    const args: xdr.ScVal[] = [new Address(collectionAddress).toScVal()];
    const retVal = await invokeContract(callerPublicKey, "is_collection_paused", args, true);
    return scValToNative(retVal) as boolean;
  } catch {
    return false;
  }
}

/** pause_function — block a specific entry-point by name. */
export async function pauseFunction(
  adminPublicKey: string,
  functionName: string
): Promise<boolean> {
  const args: xdr.ScVal[] = [
    new Address(adminPublicKey).toScVal(),
    nativeToScVal(functionName, { type: "symbol" }),
  ];
  await invokeContract(adminPublicKey, "pause_function", args);
  return true;
}

/** unpause_function — unblock a previously paused entry-point. */
export async function unpauseFunction(
  adminPublicKey: string,
  functionName: string
): Promise<boolean> {
  const args: xdr.ScVal[] = [
    new Address(adminPublicKey).toScVal(),
    nativeToScVal(functionName, { type: "symbol" }),
  ];
  await invokeContract(adminPublicKey, "unpause_function", args);
  return true;
}

// ── Auction configuration ────────────────────────────────────────────────────────

export interface AuctionConfig {
  minBidIncrement: string; // i128 formatted as "${value}.0000000"
  extensionWindow: string;  // u64 as decimal string
  extensionTrigger: string; // u64 as decimal string
}

/** get_min_bid_increment — read the global minimum bid increment. */
export async function getMinBidIncrement(): Promise<bigint> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();
  try {
    const retVal = await invokeContract(callerPublicKey, "get_min_bid_increment", [], true);
    return scValToNative(retVal) as bigint;
  } catch {
    return 1000000n; // Default: 0.1 XLM
  }
}

/** set_min_bid_increment — admin function to set the minimum bid increment. */
export async function setMinBidIncrement(
  adminPublicKey: string,
  increment: bigint
): Promise<boolean> {
  const args: xdr.ScVal[] = [
    new Address(adminPublicKey).toScVal(),
    nativeToScVal(increment, { type: "i128" }),
  ];
  await invokeContract(adminPublicKey, "set_min_bid_increment", args);
  return true;
}

/** get_auction_extension_window — read the global extension window. */
export async function getAuctionExtensionWindow(): Promise<bigint> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();
  try {
    const retVal = await invokeContract(callerPublicKey, "get_auction_extension_window", [], true);
    return scValToNative(retVal) as bigint;
  } catch {
    return 600n; // Default: 600 seconds
  }
}

/** set_auction_extension_window — admin function to set the extension window. */
export async function setAuctionExtensionWindow(
  adminPublicKey: string,
  window: bigint
): Promise<boolean> {
  const args: xdr.ScVal[] = [
    new Address(adminPublicKey).toScVal(),
    nativeToScVal(window, { type: "u64" }),
  ];
  await invokeContract(adminPublicKey, "set_auction_extension_window", args);
  return true;
}

/** get_auction_extension_trigger — read the global extension trigger. */
export async function getAuctionExtensionTrigger(): Promise<bigint> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();
  try {
    const retVal = await invokeContract(callerPublicKey, "get_auction_extension_trigger", [], true);
    return scValToNative(retVal) as bigint;
  } catch {
    return 0n; // Default: 0 seconds
  }
}

/** set_auction_extension_trigger — admin function to set the extension trigger. */
export async function setAuctionExtensionTrigger(
  adminPublicKey: string,
  trigger: bigint
): Promise<boolean> {
  const args: xdr.ScVal[] = [
    new Address(adminPublicKey).toScVal(),
    nativeToScVal(trigger, { type: "u64" }),
  ];
  await invokeContract(adminPublicKey, "set_auction_extension_trigger", args);
  return true;
}

/** get_auction_config — fetch all auction configuration values at once. */
export async function getAuctionConfig(): Promise<AuctionConfig> {
  const [minIncrement, extensionWindow, extensionTrigger] = await Promise.all([
    getMinBidIncrement(),
    getAuctionExtensionWindow(),
    getAuctionExtensionTrigger(),
  ]);
  return {
    minBidIncrement: `${minIncrement}.0000000`,
    extensionWindow: extensionWindow.toString(),
    extensionTrigger: extensionTrigger.toString(),
  };
}

/** is_function_paused — read the pause flag for a specific function. */
export async function isFunctionPaused(functionName: string): Promise<boolean> {
  const callerPublicKey = await getReadOnlyCallerPublicKey();
  try {
    const args: xdr.ScVal[] = [nativeToScVal(functionName, { type: "symbol" })];
    const retVal = await invokeContract(callerPublicKey, "is_function_paused", args, true);
    return scValToNative(retVal) as boolean;
  } catch {
    return false;
  }
}
