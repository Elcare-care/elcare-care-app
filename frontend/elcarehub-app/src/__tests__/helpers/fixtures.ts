/**
 * fixtures.ts — Shared factory helpers for frontend Jest tests.
 *
 * Import from `@/__tests__/helpers/fixtures` to get typed, minimal-viable
 * test data. Factories accept Partial<T> overrides so each test only specifies
 * the fields it cares about.
 */

import type { Listing } from "@/lib/contract";
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

// ── Reset sequences (call in beforeEach for deterministic IDs) ────────────────

export function resetFixtureSequences(): void {
  _listingSeq = 1;
  _notifSeq = 1;
  _activitySeq = 1;
}
