// In-memory chain mock for Playwright E2E (NEXT_PUBLIC_E2E_MOCK_CHAIN=true).

import { DEFAULT_TOKEN } from "@/config/tokens";
import type { Listing } from "./contract";

let nextListingId = 9001;
const listings = new Map<number, Listing>();

/**
 * Deterministic write-surface failure injection for the E2E wallet failure
 * matrix (Issue #525). Each mode reproduces the exact error shape a real
 * wallet/RPC/chain failure would raise, so the app's existing error
 * classification (classifyTxError in useTxLifecycle) and UI (TxErrorPanel)
 * are exercised the same way they would be in production — the mock only
 * decides *when* to throw, never *how* the app should react.
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

export function getE2eMockListings(): Listing[] {
  return Array.from(listings.values());
}

export function registerE2eMockListingsOnWindow(): void {
  if (typeof window === "undefined") return;
  window.__E2E_GET_LISTINGS__ = getE2eMockListings;
  window.__E2E_RESET_LISTINGS__ = resetE2eMockListings;
  window.__E2E_UPSERT_LISTING__ = e2eMockUpsertListing;
  registerE2eFailureModeOnWindow();
}

export function e2eMockUpsertListing(listing: Listing): void {
  listings.set(listing.listing_id, listing);
  if (listing.listing_id >= nextListingId) {
    nextListingId = listing.listing_id + 1;
  }
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
