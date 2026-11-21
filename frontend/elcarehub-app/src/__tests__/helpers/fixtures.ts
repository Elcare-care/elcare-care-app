/**
 * fixtures.ts — Shared factory helpers for frontend Jest tests.
 *
 * Import from `@/__tests__/helpers/fixtures` to get typed, minimal-viable
 * test data. Factories accept Partial<T> overrides so each test only specifies
 * the fields it cares about.
 */

import type { Listing, Offer } from "@/lib/contract";
import type { ArtworkMetadata } from "@/lib/ipfs";
import type { AppNotification } from "@/lib/watchlist";

// ── Listing fixture ───────────────────────────────────────────────────────────

let _listingSeq = 1;

export function makeListing(overrides: Partial<Listing> = {}): Listing {
  const id = _listingSeq++;
  return {
    listing_id: id,
    artist: `GARTIST${String(id).padStart(49, "0")}`,
    metadata_cid: `QmMeta${String(id).padStart(39, "0")}`,
    collection: `CCOLLECTION${String(id).padStart(45, "0")}`,
    token_id: 1,
    price: 10_000_000n,     // 1 XLM in stroops
    currency: "XLM",
    token: `CTOKEN${String(id).padStart(50, "0")}`,
    recipients: [{ address: `GARTIST${String(id).padStart(49, "0")}`, percentage: 10_000 }],
    status: "Active",
    owner: null,
    created_at: 1000,
    ...overrides,
  };
}

// ── ArtworkMetadata fixture ───────────────────────────────────────────────────

export function makeArtworkMetadata(
  overrides: Partial<ArtworkMetadata> = {}
): ArtworkMetadata {
  return {
    title: "Test Artwork",
    description: "A beautiful test piece",
    artist: "GARTIST0000000000000000000000000000000000000000001",
    image: "ipfs://QmImageCid",
    year: "2025",
    category: "Digital Art",
    altText: "A colourful abstract painting on a dark background.",
    isDecorativeImage: false,
    ...overrides,
  };
}

// ── AppNotification fixture ───────────────────────────────────────────────────

let _notifSeq = 1;

export function makeNotification(
  overrides: Partial<AppNotification> = {}
): AppNotification {
  const id = _notifSeq++;
  return {
    id: `notif-${id}`,
    category: "LISTING_SOLD",
    priority: "HIGH",
    title: "Your watched listing sold!",
    body: `Listing #${id} sold for 1 XLM.`,
    amount: "1 XLM",
    resourceType: "listing",
    resourceId: String(id),
    href: `/listings/${id}`,
    receivedAt: Date.now() - id * 5_000,
    isRead: false,
    isStale: false,
    ...overrides,
  };
}

export function makeReadNotification(
  overrides: Partial<AppNotification> = {}
): AppNotification {
  return makeNotification({ isRead: true, ...overrides });
}

export function makeHighPriorityNotification(
  overrides: Partial<AppNotification> = {}
): AppNotification {
  return makeNotification({
    priority: "HIGH",
    category: "AUCTION_FINALIZED",
    title: "Watched auction ended",
    body: "Auction #1 finalized.",
    resourceType: "auction",
    ...overrides,
  });
}

export function makeLowPriorityNotification(
  overrides: Partial<AppNotification> = {}
): AppNotification {
  return makeNotification({
    priority: "LOW",
    category: "COLLECTION_DEPLOYED",
    title: "Collection deployed",
    body: "A new ERC-721 collection was deployed.",
    resourceType: "collection",
    ...overrides,
  });
}

// ── ActivityFeedEvent fixture (matches indexer ActivityFeedEvent shape) ───────

export interface ActivityFeedEventFixture {
  id: number;
  eventType: string;
  listingId: string | null;
  actor: string;
  data: Record<string, unknown>;
  ledgerSequence: number;
  ledgerTimestamp: string | null;
  summary?: string;
}

let _activitySeq = 1;

export function makeActivityEvent(
  overrides: Partial<ActivityFeedEventFixture> = {}
): ActivityFeedEventFixture {
  const id = _activitySeq++;
  return {
    id,
    eventType: "LISTING_CREATED",
    listingId: String(id),
    actor: `GARTIST${String(id).padStart(49, "0")}`,
    data: { listing_id: id, price: "10000000" },
    ledgerSequence: 1000 + id,
    ledgerTimestamp: new Date(Date.now() - id * 60_000).toISOString(),
    summary: `New listing #${id}`,
    ...overrides,
  };
}

// ── Offer fixture ─────────────────────────────────────────────────────────────

/** Offer statuses surfaced by the offer pages (pending + terminal states). */
export type OfferStatusFixture =
  | "Pending"
  | "Accepted"
  | "Rejected"
  | "Withdrawn"
  | "Expired"
  | "Stale";

/** Direction of an offer relative to the connected wallet. */
export type OfferDirectionFixture = "incoming" | "outgoing";

let _offerSeq = 1;

/**
 * Builds a valid pending offer. Defaults represent an *incoming* offer so the
 * receiving party can accept/reject it; use `makeOutgoingOffer` for the
 * counterparty view.
 */
export function makeOffer(overrides: Partial<Offer> = {}): Offer {
  const id = _offerSeq++;
  const counterparty = `GARTIST${String(id).padStart(49, "0")}`;
  return {
    offer_id: id,
    listing_id: id,
    buyer: counterparty,
    offerer: counterparty,
    amount: 5_000_000n,     // 0.5 XLM in stroops
    currency: "XLM",
    status: "Pending",
    created_at: 1000,
    expires_at: 2000,
    ...overrides,
  } as Offer;
}

export function makeIncomingOffer(overrides: Partial<Offer> = {}): Offer {
  return makeOffer(overrides);
}

export function makeOutgoingOffer(overrides: Partial<Offer> = {}): Offer {
  const id = _offerSeq++;
  return makeOffer({
    buyer: `GBUYER${String(id).padStart(50, "0")}`,
    ...overrides,
  });
}

export function makePendingOffer(overrides: Partial<Offer> = {}): Offer {
  return makeOffer({ status: "Pending", ...overrides });
}

export function makeAcceptedOffer(overrides: Partial<Offer> = {}): Offer {
  return makeOffer({ status: "Accepted", ...overrides });
}

export function makeRejectedOffer(overrides: Partial<Offer> = {}): Offer {
  return makeOffer({ status: "Rejected", ...overrides });
}

export function makeWithdrawnOffer(overrides: Partial<Offer> = {}): Offer {
  return makeOffer({ status: "Withdrawn", ...overrides });
}

export function makeExpiredOffer(overrides: Partial<Offer> = {}): Offer {
  return makeOffer({ status: "Expired", ...overrides });
}

export function makeStaleOffer(overrides: Partial<Offer> = {}): Offer {
  return makeOffer({ status: "Stale", ...overrides });
}

/**
 * Every offer status paired with the direction it is rendered in. Tests can
 * iterate this to assert badge text, action availability and empty-state copy
 * for each combination without duplicating fixtures.
 */
export const offerStatusCases: ReadonlyArray<{
  status: OfferStatusFixture;
  direction: OfferDirectionFixture;
  /** Whether accept/reject actions should be available. */
  actionable: boolean;
  /** Expected badge label rendered by the offer page. */
  badge: string;
}> = [
  { status: "Pending", direction: "incoming", actionable: true, badge: "Pending" },
  { status: "Pending", direction: "outgoing", actionable: false, badge: "Pending" },
  { status: "Accepted", direction: "incoming", actionable: false, badge: "Accepted" },
  { status: "Accepted", direction: "outgoing", actionable: false, badge: "Accepted" },
  { status: "Rejected", direction: "incoming", actionable: false, badge: "Rejected" },
  { status: "Rejected", direction: "outgoing", actionable: false, badge: "Rejected" },
  { status: "Withdrawn", direction: "incoming", actionable: false, badge: "Withdrawn" },
  { status: "Withdrawn", direction: "outgoing", actionable: false, badge: "Withdrawn" },
  { status: "Expired", direction: "incoming", actionable: false, badge: "Expired" },
  { status: "Expired", direction: "outgoing", actionable: false, badge: "Expired" },
  { status: "Stale", direction: "incoming", actionable: false, badge: "Stale" },
  { status: "Stale", direction: "outgoing", actionable: false, badge: "Stale" },
];

// ── Magic wallet fixture ──────────────────────────────────────────────────────

export interface MagicAccountFixture {
  /** Deterministic pseudo-address derived from the email (no real wallet). */
  address: string;
  email: string;
  /** Whether the account is a passkey-backed (vs email OTP) account. */
  isPasskey: boolean;
}

export function makeMagicAccount(
  overrides: Partial<MagicAccountFixture> = {}
): MagicAccountFixture {
  const email = overrides.email ?? "collector@example.test";
  const address = `G${email
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase()
    .padEnd(55, "0")
    .slice(0, 55)}`;
  return {
    address,
    email,
    isPasskey: false,
    ...overrides,
  };
}

export type MagicValidationCaseKind =
  | "blank"
  | "malformed"
  | "valid-email"
  | "valid-passkey"
  | "provider-failure";

export interface MagicValidationCase {
  kind: MagicValidationCaseKind;
  /** Raw input passed to the modal's validation/submit handler. */
  input: string;
  /** Whether client-side validation should accept the input. */
  valid: boolean;
  /** Expected inline error copy, or null when no error is shown. */
  error: string | null;
  /** Simulated provider rejection message (never a real network call). */
  providerError?: string;
}

/**
 * Validation matrix for MagicWalletModal tests. All values are synthetic and
 * deterministic; provider failures are simulated strings, not real calls.
 */
export const magicValidationCases: ReadonlyArray<MagicValidationCase> = [
  { kind: "blank", input: "", valid: false, error: "Email is required" },
  { kind: "blank", input: "   ", valid: false, error: "Email is required" },
  { kind: "malformed", input: "not-an-email", valid: false, error: "Enter a valid email" },
  { kind: "malformed", input: "user@", valid: false, error: "Enter a valid email" },
  { kind: "valid-email", input: "collector@example.test", valid: true, error: null },
  { kind: "valid-passkey", input: "passkey-user@example.test", valid: true, error: null },
  {
    kind: "provider-failure",
    input: "collector@example.test",
    valid: true,
    error: "Unable to sign in. Please try again.",
    providerError: "provider_unavailable",
  },
];

// ── Reset sequences (call in beforeEach for deterministic IDs) ────────────────

export function resetFixtureSequences(): void {
  _listingSeq = 1;
  _notifSeq = 1;
  _activitySeq = 1;
  _offerSeq = 1;
}
