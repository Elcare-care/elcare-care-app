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

// ── Image state fixtures (issue #1146) ────────────────────────────────────────

/**
 * Deterministic descriptors for the image lifecycle states exercised by
 * artwork cards and detail pages. Use with `installImageMock` to drive
 * loading → success, loading → timeout, and broken-URL fallbacks without
 * touching the network.
 */
export type ImageStateKind = "loading" | "timeout" | "broken" | "success";

export interface ImageStateFixture {
  kind: ImageStateKind;
  /** URL to feed into the component under test. */
  src: string;
  /** Expected fallback/placeholder rendering for this state. */
  expectsFallback: boolean;
  /** Milliseconds after which a still-loading image is treated as timed out. */
  timeoutMs: number;
}

const IMAGE_STATE_SRC: Record<ImageStateKind, string> = {
  loading: "ipfs://QmImageLoading",
  timeout: "ipfs://QmImageTimeout",
  broken: "ipfs://QmBrokenImageCid",
  success: "ipfs://QmImageCid",
};

export function makeImageState(
  kind: ImageStateKind = "success",
  overrides: Partial<ImageStateFixture> = {}
): ImageStateFixture {
  return {
    kind,
    src: IMAGE_STATE_SRC[kind],
    expectsFallback: kind !== "success",
    timeoutMs: 5_000,
    ...overrides,
  };
}

/** Convenience: one descriptor per state, in a stable order. */
export function makeAllImageStates(): ImageStateFixture[] {
  return (["loading", "timeout", "broken", "success"] as ImageStateKind[]).map(
    (kind) => makeImageState(kind)
  );
}

/** Listing fixture with an explicit image URL override on its metadata. */
export function makeListingWithImage(
  image: string,
  overrides: Partial<Listing> = {}
): Listing {
  return makeListing({ metadata_cid: image, ...overrides });
}

// ── Image mock utility (issue #1146) ─────────────────────────────────────────

export interface ImageMock {
  /** Every Image instance constructed while the mock is installed. */
  instances: MockImage[];
  /** Resolve the most recently created image as successfully loaded. */
  triggerLoad: () => void;
  /** Reject the most recently created image as a broken URL. */
  triggerError: () => void;
  /** Leave the image pending; pair with jest fake timers to simulate timeout. */
  triggerTimeout: () => void;
  /** Restore the original global Image implementation. */
  restore: () => void;
}

interface MockImage {
  src: string;
  onload: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  decode?: () => Promise<void>;
  addEventListener: (type: string, cb: (ev?: unknown) => void) => void;
  removeEventListener: (type: string, cb: (ev?: unknown) => void) => void;
  naturalWidth: number;
  naturalHeight: number;
  complete: boolean;
}

/**
 * Stub `global.Image` so tests can deterministically drive load/error events.
 * No network access occurs; call `restore()` in `afterEach`.
 */
export function installImageMock(): ImageMock {
  const original = (globalThis as { Image?: unknown }).Image;
  const instances: MockImage[] = [];

  class FakeImage implements MockImage {
    src = "";
    onload: ((ev?: unknown) => void) | null = null;
    onerror: ((ev?: unknown) => void) | null = null;
    naturalWidth = 0;
    naturalHeight = 0;
    complete = false;
    private listeners: Record<string, Array<(ev?: unknown) => void>> = {};

    constructor() {
      instances.push(this);
    }

    addEventListener(type: string, cb: (ev?: unknown) => void): void {
      (this.listeners[type] ??= []).push(cb);
    }

    removeEventListener(type: string, cb: (ev?: unknown) => void): void {
      this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== cb);
    }

    decode(): Promise<void> {
      return Promise.resolve();
    }

    private emit(type: string): void {
      const ev = { type };
      if (type === "load") {
        this.complete = true;
        this.naturalWidth = 1;
        this.naturalHeight = 1;
      }
      this.onload && type === "load" && this.onload(ev);
      this.onerror && type === "error" && this.onerror(ev);
      for (const cb of this.listeners[type] ?? []) cb(ev);
    }

    __emitLoad(): void {
      this.emit("load");
    }

    __emitError(): void {
      this.emit("error");
    }
  }

  (globalThis as { Image?: unknown }).Image = FakeImage;

  const latest = (): MockImage | undefined => instances[instances.length - 1];

  return {
    instances,
    triggerLoad: () => {
      (latest() as unknown as { __emitLoad?: () => void })?.__emitLoad?.();
    },
    triggerError: () => {
      (latest() as unknown as { __emitError?: () => void })?.__emitError?.();
    },
    triggerTimeout: () => {
      // Intentionally a no-op: the image stays pending so fake timers can
      // advance past the component's timeout threshold.
    },
    restore: () => {
      (globalThis as { Image?: unknown }).Image = original;
    },
  };
}

// ── Reset sequences (call in beforeEach for deterministic IDs) ────────────────

export function resetFixtureSequences(): void {
  _listingSeq = 1;
  _notifSeq = 1;
  _activitySeq = 1;
}
