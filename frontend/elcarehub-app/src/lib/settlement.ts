// ─────────────────────────────────────────────────────────────
// lib/settlement.ts
//
// Issue #310 / #45 — Exact settlement preview calculation
//
// Computes the precise base-unit breakdown of a purchase so
// that the buyer total matches the transaction amount exactly.
//
// Breakdown:
//   buyerTotal  = itemPrice + protocolFeeAmount + royaltyTotal
//   sellerProceeds = itemPrice - royaltyTotal
//   creatorProceeds = royaltyTotal  (distributed among recipients)
//
// All amounts are stored as bigint stroops to avoid floating-
// point rounding errors.
// ─────────────────────────────────────────────────────────────

import { Listing, Recipient, stroopsToXlm } from "@/lib/contract";

// ── Types ─────────────────────────────────────────────────────

/** A single recipient's royalty share in a settlement */
export interface RecipientShare {
  address: string;
  /** Percentage as an integer (0-100) */
  percentage: number;
  /** Share amount in stroops */
  amountStroops: bigint;
  /** Display amount (XLM string) */
  amountDisplay: string;
}

/**
 * Full settlement preview for a single listing purchase.
 * All *Stroops fields are the authoritative base-unit values.
 * All *Display fields are pre-formatted XLM strings for rendering.
 */
export interface SettlementPreview {
  /** Listing ID this preview is for */
  listingId: number;

  /** ISO-8601 timestamp of when this preview was computed */
  computedAt: string;

  // ── Raw base-unit values (bigint stroops) ──────────────────
  itemPriceStroops: bigint;
  protocolFeeStroops: bigint;
  royaltyTotalStroops: bigint;
  buyerTotalStroops: bigint;
  sellerProceedsStroops: bigint;

  // ── Display values (XLM strings) ──────────────────────────
  itemPriceDisplay: string;
  protocolFeeDisplay: string;
  royaltyTotalDisplay: string;
  buyerTotalDisplay: string;
  sellerProceedsDisplay: string;

  // ── Fee metadata ──────────────────────────────────────────
  /** Protocol fee in basis points (e.g. 250 = 2.5%) */
  protocolFeeBps: number;
  /** Protocol fee as a percentage string (e.g. "2.50") */
  protocolFeePercent: string;

  // ── Royalty recipients ────────────────────────────────────
  recipients: RecipientShare[];

  // ── Token ─────────────────────────────────────────────────
  tokenAddress: string;
  tokenSymbol: string;

  // ── Listing snapshot used for this preview ────────────────
  /** Whether the listing was confirmed Active at preview time */
  listingActive: boolean;
  /** The listing version used — if this changes, preview must be invalidated */
  listingPriceSnapshot: bigint;
  listingTokenSnapshot: string;
}

// ── Calculation ───────────────────────────────────────────────

/**
 * Calculates the exact settlement preview for a listing purchase.
 *
 * @param listing         - The listing to compute the preview for (fetched fresh)
 * @param protocolFeeBps  - Current protocol fee in basis points
 * @param tokenSymbol     - Symbol of the payment token (e.g. "XLM")
 */
export function calculateSettlementPreview(
  listing: Listing,
  protocolFeeBps: number,
  tokenSymbol: string
): SettlementPreview {
  const itemPriceStroops = listing.price;

  // Protocol fee: floor(price * bps / 10_000)
  const protocolFeeStroops =
    (itemPriceStroops * BigInt(Math.max(0, protocolFeeBps))) / 10_000n;

  // Royalty: each recipient gets floor(price * percentage / 100)
  const recipientShares: RecipientShare[] = (listing.recipients ?? []).map(
    (r: Recipient) => {
      const amountStroops =
        (itemPriceStroops * BigInt(Math.max(0, r.percentage))) / 100n;
      return {
        address: r.address,
        percentage: r.percentage,
        amountStroops,
        amountDisplay: stroopsToXlm(amountStroops),
      };
    }
  );

  const royaltyTotalStroops = recipientShares.reduce(
    (acc, r) => acc + r.amountStroops,
    0n
  );

  const buyerTotalStroops = itemPriceStroops + protocolFeeStroops;
  const sellerProceedsStroops = itemPriceStroops - royaltyTotalStroops;

  const bpsDecimal = protocolFeeBps / 100;
  const protocolFeePercent = bpsDecimal.toFixed(2);

  return {
    listingId: listing.listing_id,
    computedAt: new Date().toISOString(),

    itemPriceStroops,
    protocolFeeStroops,
    royaltyTotalStroops,
    buyerTotalStroops,
    sellerProceedsStroops,

    itemPriceDisplay: stroopsToXlm(itemPriceStroops),
    protocolFeeDisplay: stroopsToXlm(protocolFeeStroops),
    royaltyTotalDisplay: stroopsToXlm(royaltyTotalStroops),
    buyerTotalDisplay: stroopsToXlm(buyerTotalStroops),
    sellerProceedsDisplay: stroopsToXlm(sellerProceedsStroops),

    protocolFeeBps,
    protocolFeePercent,
    recipients: recipientShares,

    tokenAddress: listing.token,
    tokenSymbol,

    listingActive: listing.status === "Active",
    listingPriceSnapshot: listing.price,
    listingTokenSnapshot: listing.token,
  };
}

/**
 * Returns true when the cached preview is still valid against a freshly-
 * fetched listing. A material change (price, token, status) invalidates it.
 */
export function isPreviewStillValid(
  preview: SettlementPreview,
  freshListing: Listing
): boolean {
  if (!freshListing) return false;
  if (freshListing.status !== "Active") return false;
  if (freshListing.price !== preview.listingPriceSnapshot) return false;
  if (freshListing.token !== preview.listingTokenSnapshot) return false;
  return true;
}
