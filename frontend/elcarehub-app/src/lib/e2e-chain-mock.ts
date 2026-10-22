// In-memory chain mock for Playwright E2E (NEXT_PUBLIC_E2E_MOCK_CHAIN=true).

import { DEFAULT_TOKEN } from "@/config/tokens";
import type { Listing } from "./contract";

let nextListingId = 9001;
const listings = new Map<number, Listing>();

// ── Auction mock state ──────────────────────────────────────────────────────

export interface E2eMockAuction {
  auction_id: number;
  creator: string;
  token: string;
  reserve_price: bigint;
  highest_bid: bigint;
  highest_bidder: string | null;
  end_time: number;
  status: "Active" | "Finalized" | "Cancelled";
}

let nextAuctionId = 8001;
const auctions = new Map<number, E2eMockAuction>();

// ── Offer mock state ────────────────────────────────────────────────────────

export interface E2eMockOffer {
  offer_id: number;
  listing_id: number;
  offerer: string;
  amount: bigint;
  token: string;
  status: "Pending" | "Accepted" | "Rejected" | "Withdrawn";
}

let nextOfferId = 6001;
const offers = new Map<number, E2eMockOffer>();

/**
 * Deterministic write-surface failure injection for the E2E wallet failure
 * matrix (Issue #525). Each mode reproduces the exact error shape a real
 * wallet/RPC/chain failure would raise, so the app's existing error
 * classification (classifyTxError in useTxLifecycle) and UI (TxErrorPanel)
 * are exercised the same way they would be in production — the mock only
 * decides *when* to throw, never *how* the app should react.
 *
 * Extended in Issues #999/#1000/#1001 to cover listing creation, auction bid,
 * and offer submission write surfaces.
 */
export type E2eFailureMode =
  | "none"
  | "wallet_rejection"
  | "simulation_failure"
  | "insufficient_balance"
  | "submission_timeout"
  | "chain_failure";

let failureMode: E2eFailureMode = "none";

declare global {
  interface Window {
    __E2E_GET_LISTINGS__?: () => Listing[];
    __E2E_RESET_LISTINGS__?: () => void;
    __E2E_UPSERT_LISTING__?: (listing: Listing) => void;
    __E2E_SET_FAILURE_MODE__?: (mode: E2eFailureMode) => void;
    __E2E_GET_FAILURE_MODE__?: () => E2eFailureMode;
    __E2E_GET_AUCTIONS__?: () => E2eMockAuction[];
    __E2E_RESET_AUCTIONS__?: () => void;
    __E2E_UPSERT_AUCTION__?: (auction: E2eMockAuction) => void;
    __E2E_GET_OFFERS__?: () => E2eMockOffer[];
    __E2E_RESET_OFFERS__?: () => void;
  }
}

export function setE2eFailureMode(mode: E2eFailureMode): void {
  failureMode = mode;
}

export function getE2eFailureMode(): E2eFailureMode {
  return failureMode;
}

export function registerE2eFailureModeOnWindow(): void {
  if (typeof window === "undefined") return;
  window.__E2E_SET_FAILURE_MODE__ = setE2eFailureMode;
  window.__E2E_GET_FAILURE_MODE__ = getE2eFailureMode;
}

/**
 * Throws an error matching the currently configured failure mode, or does
 * nothing when the mode is "none". Messages are worded the way the real
 * Freighter API / Soroban RPC / contract layer word theirs, since
 * classifyTxError (useTxLifecycle.ts) buckets purely on message content.
 */
function maybeThrowForFailureMode(): void {
  switch (failureMode) {
    case "wallet_rejection":
      throw new Error("User declined access: request rejected by user in Freighter.");
    case "simulation_failure":
      throw new Error(
        "Transaction simulation failed: Error(Contract, #4) — listing state changed since preview."
      );
    case "insufficient_balance":
      throw new Error(
        "Transaction simulation failed: insufficient balance to cover this purchase and network fees."
      );
    case "submission_timeout":
      throw new Error("ETIMEDOUT: request to Soroban RPC timed out while submitting the transaction.");
    case "chain_failure":
      throw new Error("Horizon submission failed: 503 Service Unavailable — network error.");
    case "none":
    default:
      return;
  }
}

export function isE2eMockChain(): boolean {
  return process.env.NEXT_PUBLIC_E2E_MOCK_CHAIN === "true";
}

export function resetE2eMockListings(): void {
  listings.clear();
  nextListingId = 9001;
  failureMode = "none";
}

export function resetE2eMockAuctions(): void {
  auctions.clear();
  nextAuctionId = 8001;
}

export function resetE2eMockOffers(): void {
  offers.clear();
  nextOfferId = 6001;
}

export function getE2eMockListings(): Listing[] {
  return Array.from(listings.values());
}

export function getE2eMockAuctions(): E2eMockAuction[] {
  return Array.from(auctions.values());
}

export function getE2eMockOffers(): E2eMockOffer[] {
  return Array.from(offers.values());
}

export function registerE2eMockListingsOnWindow(): void {
  if (typeof window === "undefined") return;
  window.__E2E_GET_LISTINGS__ = getE2eMockListings;
  window.__E2E_RESET_LISTINGS__ = resetE2eMockListings;
  window.__E2E_UPSERT_LISTING__ = e2eMockUpsertListing;
  registerE2eFailureModeOnWindow();
}

export function registerE2eMockAuctionsOnWindow(): void {
  if (typeof window === "undefined") return;
  window.__E2E_GET_AUCTIONS__ = getE2eMockAuctions;
  window.__E2E_RESET_AUCTIONS__ = resetE2eMockAuctions;
  window.__E2E_UPSERT_AUCTION__ = e2eMockUpsertAuction;
}

export function registerE2eMockOffersOnWindow(): void {
  if (typeof window === "undefined") return;
  window.__E2E_GET_OFFERS__ = getE2eMockOffers;
  window.__E2E_RESET_OFFERS__ = resetE2eMockOffers;
}

export function e2eMockUpsertListing(listing: Listing): void {
  listings.set(listing.listing_id, listing);
  if (listing.listing_id >= nextListingId) {
    nextListingId = listing.listing_id + 1;
  }
}

export function e2eMockUpsertAuction(auction: E2eMockAuction): void {
  auctions.set(auction.auction_id, auction);
  if (auction.auction_id >= nextAuctionId) {
    nextAuctionId = auction.auction_id + 1;
  }
}

/**
 * Mock listing creation (Issue #999 — failure injection for listing creation).
 *
 * Failure-mode injection point: failure is injected BEFORE any state mutation
 * (mirroring how a real wallet/RPC rejection aborts before the listing is
 * published on-chain). When mode is "submission_timeout" the mock waits a
 * short deterministic interval before throwing, matching the timing shape of
 * a real RPC timeout without blocking the E2E suite.
 */
export async function e2eMockCreateListingWithFailure(
  artistPublicKey: string,
  price: number,
  tokenAddress: string = DEFAULT_TOKEN.address,
  collectionAddress: string,
  nftTokenId: number
): Promise<number> {
  // Failure-mode injection point (Issue #999 listing creation failure matrix).
  // Thrown BEFORE state mutation — no listing is created when an error fires.
  if (failureMode === "submission_timeout") {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  maybeThrowForFailureMode();

  const id = nextListingId++;
  const priceStroops = BigInt(Math.round(price * 10_000_000));
  listings.set(id, {
    listing_id: id,
    artist: artistPublicKey,
    collection: collectionAddress,
    token_id: nftTokenId,
    price: priceStroops,
    currency: DEFAULT_TOKEN.symbol,
    token: tokenAddress,
    recipients: [{ address: artistPublicKey, percentage: 100 }],
    status: "Active",
    owner: null,
    created_at: Math.floor(Date.now() / 1000),
  });
  return id;
}

export function e2eMockCreateListing(
  artistPublicKey: string,
  price: number,
  tokenAddress: string = DEFAULT_TOKEN.address,
  collectionAddress: string,
  nftTokenId: number
): number {
  const id = nextListingId++;
  const priceStroops = BigInt(Math.round(price * 10_000_000));
  listings.set(id, {
    listing_id: id,
    artist: artistPublicKey,
    collection: collectionAddress,
    token_id: nftTokenId,
    price: priceStroops,
    currency: DEFAULT_TOKEN.symbol,
    token: tokenAddress,
    recipients: [{ address: artistPublicKey, percentage: 100 }],
    status: "Active",
    owner: null,
    created_at: Math.floor(Date.now() / 1000),
  });
  return id;
}

export async function e2eMockBuyArtwork(
  buyerPublicKey: string,
  listingId: number
): Promise<boolean> {
  // Failure-mode injection point (Issue #525 wallet failure matrix). Thrown
  // before any state mutation, mirroring how a real wallet/RPC/chain failure
  // aborts before the listing is actually marked sold.
  if (failureMode === "submission_timeout") {
    // A real submission timeout still blocks for a while before failing —
    // kept short here so the E2E suite stays fast and deterministic.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  maybeThrowForFailureMode();

  const listing = listings.get(listingId);
  if (!listing || listing.status !== "Active") {
    throw new Error("Listing is not available for purchase.");
  }
  if (listing.artist === buyerPublicKey) {
    throw new Error("Cannot buy your own listing.");
  }
  listing.status = "Sold";
  listing.owner = buyerPublicKey;
  return true;
}

/**
 * Mock auction bid (Issue #1000 — failure injection for auction bids).
 *
 * Failure-mode injection point: thrown BEFORE any state mutation so no bid
 * is recorded when the failure fires — mirrors how a real wallet rejection or
 * RPC timeout would abort before the bid reaches the contract.
 *
 * "submission_timeout" adds a short deterministic delay before throwing to
 * model the timing of a real network timeout without stalling the test suite.
 */
export async function e2eMockPlaceBid(
  bidderPublicKey: string,
  auctionId: number,
  bidAmount: bigint
): Promise<boolean> {
  // Failure-mode injection point (Issue #1000 auction-bid failure matrix).
  // Thrown BEFORE state mutation.
  if (failureMode === "submission_timeout") {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  maybeThrowForFailureMode();

  const auction = auctions.get(auctionId);
  if (!auction || auction.status !== "Active") {
    throw new Error("Auction is not accepting bids.");
  }
  if (bidAmount <= auction.highest_bid) {
    throw new Error(
      "Bid amount must be greater than the current highest bid."
    );
  }
  if (bidAmount < auction.reserve_price) {
    throw new Error("Bid amount is below the reserve price.");
  }
  auction.highest_bid = bidAmount;
  auction.highest_bidder = bidderPublicKey;
  return true;
}

/**
 * Mock offer submission (Issue #1001 — failure injection for offer creation).
 *
 * Failure-mode injection point: thrown BEFORE any state mutation so no offer
 * record is created when the failure fires — mirrors how a real wallet
 * rejection or retryable RPC error aborts before the offer is broadcast.
 *
 * "submission_timeout" adds a short deterministic delay before throwing to
 * model the timing of a retryable network failure without stalling the suite.
 */
export async function e2eMockSubmitOffer(
  offererPublicKey: string,
  listingId: number,
  amount: bigint,
  tokenAddress: string = DEFAULT_TOKEN.address
): Promise<number> {
  // Failure-mode injection point (Issue #1001 offer-submission failure matrix).
  // Thrown BEFORE state mutation.
  if (failureMode === "submission_timeout") {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  maybeThrowForFailureMode();

  const listing = listings.get(listingId);
  if (!listing || listing.status !== "Active") {
    throw new Error("Cannot place an offer on a listing that is not active.");
  }

  const id = nextOfferId++;
  offers.set(id, {
    offer_id: id,
    listing_id: listingId,
    offerer: offererPublicKey,
    amount,
    token: tokenAddress,
    status: "Pending",
  });
  return id;
}

export function e2eMockUpsertOffer(offer: E2eMockOffer): void {
  offers.set(offer.offer_id, offer);
  if (offer.offer_id >= nextOfferId) {
    nextOfferId = offer.offer_id + 1;
  }
}

export function e2eMockUpsertListingCompat(listing: Listing): void {
  e2eMockUpsertListing(listing);
}
