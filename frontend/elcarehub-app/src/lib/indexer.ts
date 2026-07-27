// ─────────────────────────────────────────────────────────────
// lib/indexer.ts — ELCARE-HUB HTTP indexer client
// ─────────────────────────────────────────────────────────────

import axios, { AxiosError, isAxiosError } from "axios";
import { config } from "./config";

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

// ─────────────────────────────────────────────────────────────
// Issue #309 / #44 — Freshness metadata
// ─────────────────────────────────────────────────────────────

/**
 * Freshness metadata attached to every indexed response.
 * Consumers use this to determine whether data is stale and
 * to show a non-blocking stale banner to the user.
 */
export interface FreshnessMetadata {
  /** Last indexed ledger sequence number */
  lastIndexedLedger: number;
  /** Unix ms timestamp when the client fetched this response */
  fetchedAt: number;
  /** Unix ms timestamp when the indexer last processed a new ledger */
  indexerUpdatedAt: number | null;
  /** Whether the SSE stream is currently connected */
  sseConnected: boolean;
}

/**
 * Per-resource stale thresholds in milliseconds.
 * A resource is considered stale when
 *   (Date.now() - fetchedAt) > threshold  OR
 *   (Date.now() - indexerUpdatedAt) > threshold
 */
export const STALE_THRESHOLDS_MS: Record<"listing" | "auction" | "offer" | "default", number> = {
  listing: 30_000,   // 30 s — listings can sell fast
  auction:  15_000,  // 15 s — bids change frequently
  offer:    45_000,  // 45 s — offers are less time-critical
  default:  30_000,
};

/**
 * Returns true when the resource should be considered stale
 * and a refresh should be prompted before sensitive actions.
 */
export function isDataStale(
  freshness: FreshnessMetadata,
  resourceType: keyof typeof STALE_THRESHOLDS_MS = "default"
): boolean {
  const threshold = STALE_THRESHOLDS_MS[resourceType];
  const now = Date.now();
  const ageSinceFetch = now - freshness.fetchedAt;
  if (ageSinceFetch > threshold) return true;
  if (freshness.indexerUpdatedAt !== null) {
    const ageSinceIndexer = now - freshness.indexerUpdatedAt;
    if (ageSinceIndexer > threshold) return true;
  }
  return false;
}

/**
 * Creates a freshness snapshot at the current moment.
 * `lastIndexedLedger` and `indexerUpdatedAt` are populated from
 * the indexer /health response when available.
 */
export function makeFreshness(
  opts: Partial<Pick<FreshnessMetadata, "lastIndexedLedger" | "indexerUpdatedAt" | "sseConnected">> = {}
): FreshnessMetadata {
  return {
    lastIndexedLedger: opts.lastIndexedLedger ?? 0,
    fetchedAt: Date.now(),
    indexerUpdatedAt: opts.indexerUpdatedAt ?? null,
    sseConnected: opts.sseConnected ?? false,
  };
}

export interface ActivityEvent {
  id: string;
  type: "PURCHASE" | "LISTED" | "CANCELLED" | "SALE" | "ROYALTY" | "OFFER_SUBMITTED" | "OFFER_ACCEPTED" | "TRANSFER";
  listing_id: number;
  title: string;
  price: string;
  timestamp: number;
  from: string;
  to: string;
  tx_hash: string;
}

export interface ListingHistoryPage {
  events: ActivityEvent[];
  total: number;
  hasMore: boolean;
}

export type MetricsRange = "day" | "week" | "month" | "all";

export interface SalesTimelinePoint {
  date: string;
  count: number;
}

export interface ArtistMetrics {
  address: string;
  range: MetricsRange;
  totalListings: number;
  totalSales: number;
  totalVolume: string;
  uniqueBuyers: number;
  conversionRate: number;
  salesTimeline: SalesTimelinePoint[];
}

interface RoyaltyStatsResponse {
  totalEarned: string;
  payoutCount: number;
  lastPayout: number;
}

export interface IndexerCollectionRow {
  id: number;
  contractAddress: string;
  kind: string;
  creator: string;
  name: string | null;
  symbol: string | null;
  deployedAtLedger: number;
  createdAt?: string;
}

export interface CollectionFilter {
  kind?: string;
  creator?: string;
  page?: number;
  limit?: number;
}

/** Raw event row as returned by the indexer API and stored in Prisma. */
interface RawMarketplaceEvent {
  id: number;
  listingId?: string | null;
  eventType: string;
  actor: string;
  data: Record<string, unknown>;
  ledgerSequence: number;
  ledgerTimestamp?: string;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransientAxiosError(e: unknown): boolean {
  if (!isAxiosError(e)) return false;
  if (e.code === "ECONNABORTED" || e.code === "ETIMEDOUT") return true;
  const s = e.response?.status;
  return s === undefined || s >= 500;
}

async function httpGet<T>(url: string): Promise<T> {
  const res = await axios.get<T>(url, {
    timeout: DEFAULT_TIMEOUT_MS,
    validateStatus: (s) => s < 400,
  });
  return res.data;
}

async function fetchWithRetry<T>(path: string): Promise<T> {
  const url = `${config.indexerUrl}${path}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await httpGet<T>(url);
    } catch (e) {
      lastErr = e;
      const retry =
        attempt < MAX_RETRIES - 1 && isTransientAxiosError(e as AxiosError);
      if (!retry) {
        throw e instanceof Error ? e : new Error(String(e));
      }
      await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("Indexer request failed");
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isRawMarketplaceEvent(v: unknown): v is RawMarketplaceEvent {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.eventType === "string" &&
    typeof o.actor === "string" &&
    typeof o.ledgerSequence === "number" &&
    typeof o.data === "object" &&
    o.data !== null
  );
}

function parseActivityList(data: unknown): RawMarketplaceEvent[] {
  if (!Array.isArray(data)) return [];
  return data.filter(isRawMarketplaceEvent);
}

function addrString(x: unknown): string {
  if (typeof x === "string") return x;
  return "";
}

function isRoyaltyStatsResponse(v: unknown): v is RoyaltyStatsResponse {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.totalEarned === "string" &&
    typeof o.payoutCount === "number" &&
    Number.isFinite(o.payoutCount) &&
    typeof o.lastPayout === "number" &&
    Number.isFinite(o.lastPayout)
  );
}

function isIndexerCollectionRow(v: unknown): v is IndexerCollectionRow {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.contractAddress === "string" &&
    typeof o.kind === "string" &&
    typeof o.creator === "string"
  );
}

function eventTypeToActivity(
  eventType: string
): ActivityEvent["type"] {
  switch (eventType) {
    case "LISTING_CREATED":
      return "LISTED";
    case "ARTWORK_SOLD":
      return "PURCHASE";
    case "LISTING_CANCELLED":
      return "CANCELLED";
    case "OFFER_SUBMITTED":
      return "OFFER_SUBMITTED";
    case "OFFER_ACCEPTED":
      return "OFFER_ACCEPTED";
    case "TRANSFER":
      return "TRANSFER";
    case "ROYALTY_PAID":
      return "ROYALTY";
    default:
      return "SALE";
  }
}

/**
 * Fetches marketplace-related events for a wallet from the ELCARE-HUB indexer.
 */
export async function getWalletActivity(
  publicKey: string
): Promise<ActivityEvent[]> {
  if (!isNonEmptyString(publicKey)) return [];
  try {
    const raw = await fetchWithRetry<unknown>(
      `/wallets/${encodeURIComponent(publicKey)}/activity?limit=50`
    );
    return parseActivityList(raw).map((ev) =>
      mapWalletEventToActivity(ev, publicKey)
    );
  } catch (e) {
    console.warn(
      "[indexer] getWalletActivity:",
      e instanceof Error ? e.message : e
    );
    return [];
  }
}

function mapWalletEventToActivity(
  ev: RawMarketplaceEvent,
  publicKey: string
): ActivityEvent {
  const data = ev.data;
  const listingIdRaw = ev.listingId;
  const listingIdNum = listingIdRaw != null ? Number(listingIdRaw) : 0;
  const ts = ev.ledgerTimestamp
    ? new Date(ev.ledgerTimestamp).getTime()
    : Date.now();
  const buyer = addrString(data.buyer);
  const artist = addrString(data.artist);
  const price = data.price != null ? String(data.price) : "0";

  let type = eventTypeToActivity(ev.eventType);
  let from = ev.actor;
  let to = ev.actor;

  if (ev.eventType === "LISTING_CREATED") {
    from = artist || ev.actor;
    to = config.contractId || "Contract";
  } else if (ev.eventType === "ARTWORK_SOLD") {
    if (buyer === publicKey) {
      type = "PURCHASE";
      from = artist;
      to = publicKey;
    } else {
      type = "SALE";
      from = artist;
      to = buyer;
    }
  } else if (ev.eventType === "LISTING_CANCELLED") {
    type = "CANCELLED";
    to = "—";
  }

  return {
    id: `ix_${ev.id}`,
    type,
    listing_id: Number.isFinite(listingIdNum) ? listingIdNum : 0,
    title: `Listing #${listingIdNum || "—"}`,
    price,
    timestamp: ts,
    from: from || "—",
    to: to || "—",
    tx_hash: `ledger_${ev.ledgerSequence}`,
  };
}

/**
 * Estimates total royalties for an artist from indexed sales (listing rows).
 */
export async function getRoyaltyStats(
  publicKey: string
): Promise<RoyaltyStatsResponse> {
  const empty: RoyaltyStatsResponse = {
    totalEarned: "0",
    payoutCount: 0,
    lastPayout: 0,
  };
  if (!isNonEmptyString(publicKey)) return empty;
  try {
    const data = await fetchWithRetry<unknown>(
      `/wallets/${encodeURIComponent(publicKey)}/royalty-stats`
    );
    if (isRoyaltyStatsResponse(data)) return data;
  } catch (e) {
    console.warn(
      "[indexer] getRoyaltyStats:",
      e instanceof Error ? e.message : e
    );
  }
  return empty;
}

// ── Royalty payout breakdown (Issue #201) ─────────────────────────────────────

/** One RoyaltyPayment row from GET /wallets/:address/royalty-breakdown. */
export interface RoyaltyPaymentRow {
  id: number;
  /** Set for fixed-price / offer settlements, null for auctions. */
  listingId: string | null;
  /** Set for auction settlements, null otherwise. */
  auctionId: string | null;
  recipient: string;
  amount: string;
  salePrice: string;
  ledgerSequence: number;
  createdAt?: string;
}

export interface RoyaltyBreakdownPage {
  payments: RoyaltyPaymentRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Fetches the paginated per-sale royalty payout audit trail for a wallet,
 * optionally bounded to the inclusive ledger-sequence window [from, to].
 */
export async function fetchRoyaltyBreakdown(
  address: string,
  opts: { limit?: number; offset?: number; from?: number; to?: number } = {}
): Promise<RoyaltyBreakdownPage> {
  const empty: RoyaltyBreakdownPage = {
    payments: [],
    total: 0,
    limit: opts.limit ?? 50,
    offset: opts.offset ?? 0,
  };
  if (!isNonEmptyString(address)) return empty;
  try {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    if (opts.from !== undefined) params.set("from", String(opts.from));
    if (opts.to !== undefined) params.set("to", String(opts.to));
    const qs = params.toString();
    const data = await fetchWithRetry<RoyaltyBreakdownPage>(
      `/wallets/${encodeURIComponent(address)}/royalty-breakdown${qs ? `?${qs}` : ""}`
    );
    if (data && typeof data === "object" && Array.isArray(data.payments)) return data;
  } catch (e) {
    console.warn(
      "[indexer] fetchRoyaltyBreakdown:",
      e instanceof Error ? e.message : e
    );
  }
  return empty;
}

/**
 * Fetches activity (event timeline) for a specific marketplace listing.
 */
export async function getListingActivity(
  listingId: number
): Promise<ActivityEvent[]> {
  if (!Number.isFinite(listingId)) return [];
  try {
    const raw = await fetchWithRetry<unknown>(
      `/listings/${listingId}/history`
    );
    return parseActivityList(raw).map((ev) =>
      mapListingHistoryEvent(ev, listingId)
    );
  } catch (e) {
    console.warn(
      "[indexer] getListingActivity:",
      e instanceof Error ? e.message : e
    );
    return [];
  }
}

function mapListingHistoryEvent(
  ev: RawMarketplaceEvent,
  listingId: number
): ActivityEvent {
  const data = ev.data;
  const ts = ev.ledgerTimestamp
    ? new Date(ev.ledgerTimestamp).getTime()
    : Date.now();
  const priceField =
    data.price ?? (data as { new_price?: unknown }).new_price;
  const price = priceField != null ? String(priceField) : "0";
  const artist = addrString(data.artist);
  const buyer = addrString(data.buyer);

  return {
    id: `lst_${ev.id}`,
    type: eventTypeToActivity(ev.eventType),
    listing_id: listingId,
    title: "Artwork",
    price,
    timestamp: ts,
    from: artist || ev.actor,
    to: buyer || config.contractId,
    tx_hash: `ledger_${ev.ledgerSequence}`,
  };
}

/**
 * Fetches a paginated activity timeline for a specific marketplace listing.
 * Returns events in ascending chronological order (oldest first).
 *
 * @param listingId  - The listing to query.
 * @param offset     - Number of events to skip (default 0).
 * @param limit      - Maximum events to return (default 20).
 */
export async function getListingHistory(
  listingId: number,
  offset = 0,
  limit = 20
): Promise<ListingHistoryPage> {
  const empty: ListingHistoryPage = { events: [], total: 0, hasMore: false };
  if (!Number.isFinite(listingId)) return empty;
  try {
    const params = new URLSearchParams({
      offset: String(offset),
      limit: String(limit),
    });
    const raw = await fetchWithRetry<unknown>(
      `/listings/${listingId}/history?${params.toString()}`
    );

    // Indexer may return an array or a paginated envelope { events, total }
    let events: ActivityEvent[];
    let total = 0;

    if (Array.isArray(raw)) {
      events = parseActivityList(raw).map((ev) =>
        mapListingHistoryEvent(ev, listingId)
      );
      total = offset + events.length;
    } else if (
      raw !== null &&
      typeof raw === "object" &&
      Array.isArray((raw as any).events ?? (raw as any).data)
    ) {
      const r = raw as any;
      const arr = r.events ?? r.data;
      events = parseActivityList(arr).map((ev) =>
        mapListingHistoryEvent(ev, listingId)
      );
      total = typeof r.total === "number" ? r.total : offset + events.length;
    } else {
      return empty;
    }

    return { events, total, hasMore: offset + events.length < total };
  } catch (e) {
    console.warn(
      "[indexer] getListingHistory:",
      e instanceof Error ? e.message : e
    );
    return empty;
  }
}

/**
 * Deployed collections from the indexer (Supplementary to on-chain `all_collections` when the indexer is synced).
 */
export async function getCollections(
  filter: CollectionFilter = {}
): Promise<{ collections: IndexerCollectionRow[]; total: number }> {
  const params = new URLSearchParams();
  if (filter.kind) params.set("kind", filter.kind);
  if (filter.creator) params.set("creator", filter.creator);
  if (filter.limit != null) params.set("limit", String(filter.limit));
  if (filter.page != null) params.set("page", String(filter.page));
  const q = params.toString();
  try {
    const raw = await fetchWithRetry<unknown>(
      `/collections${q ? `?${q}` : ""}`
    );
    if (!Array.isArray(raw)) return { collections: [], total: 0 };
    const collections = raw.filter(isIndexerCollectionRow);
    return { collections, total: collections.length };
  } catch (e) {
    console.warn(
      "[indexer] getCollections:",
      e instanceof Error ? e.message : e
    );
    return { collections: [], total: 0 };
  }
}

/**
 * Fetch royalty stats for an artist (alias for getRoyaltyStats for server-side usage)
 */
export async function fetchRoyaltyStats(
  publicKey: string
): Promise<RoyaltyStatsResponse> {
  return getRoyaltyStats(publicKey);
}

/**
 * Fetch artist listings from the indexer
 */
export async function fetchArtistListings(
  publicKey: string
): Promise<any[]> {
  if (!isNonEmptyString(publicKey)) return [];
  try {
    const data = await fetchWithRetry<unknown>(
      `/listings?artist=${encodeURIComponent(publicKey)}`
    );
    if (Array.isArray(data)) return data;
    return [];
  } catch (e) {
    console.warn(
      "[indexer] fetchArtistListings:",
      e instanceof Error ? e.message : e
    );
    return [];
  }
}

/**
 * Fetch listings from the indexer with optional filters and pagination.
 * Supports both offset-based (offset/limit) and cursor-based (cursor_ledger) pagination.
 * Throws if the indexer is unreachable so callers can fall back to on-chain.
 */
export interface FetchListingsOptions {
  status?: string;
  limit?: number;
  offset?: number;
  /** Cursor ledger from X-Next-Cursor header for cursor-based pagination. */
  cursor_ledger?: number;
  /** Direction for cursor pagination: "asc" | "desc" (default "desc"). */
  cursor_direction?: "asc" | "desc";
  minPrice?: string;
  maxPrice?: string;
  search?: string;
  collection?: string[];
  artist?: string;
  sort?: string;
}

export interface FetchListingsResult {
  listings: any[];
  total?: number;
  /** Ledger sequence of the last returned item — pass as cursor_ledger for next page. */
  nextCursor?: string;
}

export async function fetchListings(options: FetchListingsOptions = {}): Promise<FetchListingsResult> {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.offset != null) params.set('offset', String(options.offset));
  if (options.cursor_ledger != null) params.set('cursor_ledger', String(options.cursor_ledger));
  if (options.cursor_direction) params.set('cursor_direction', options.cursor_direction);
  if (options.minPrice) params.set('minPrice', options.minPrice);
  if (options.maxPrice) params.set('maxPrice', options.maxPrice);
  if (options.search) params.set('search', options.search);
  if (options.artist) params.set('artist', options.artist);
  if (options.sort) params.set('sort', options.sort);
  if (options.collection && options.collection.length > 0) {
    options.collection.forEach(c => params.append('collection', c));
  }
  const q = params.toString();

  const url = `${config.indexerUrl}/listings${q ? `?${q}` : ''}`;
  const res = await axios.get(url, { timeout: DEFAULT_TIMEOUT_MS, validateStatus: (s) => s < 400 });
  const raw = res.data;
  const nextCursor = res.headers?.['x-next-cursor'] ?? '';

  if (raw == null) return { listings: [], nextCursor };
  if (typeof raw === 'object' && (raw as any).listings) {
    const r = raw as any;
    return {
      listings: Array.isArray(r.listings) ? r.listings : [],
      total: r.total,
      nextCursor,
    };
  }
  if (Array.isArray(raw)) return { listings: raw, nextCursor };
  return { listings: [], nextCursor };
}

/**
 * Fetch the next page of listings using the cursor returned by the previous call.
 */
export async function fetchNextListingsPage(
  cursor: string,
  options: Omit<FetchListingsOptions, 'cursor_ledger' | 'offset'> = {}
): Promise<FetchListingsResult> {
  const ledger = parseInt(cursor, 10);
  if (!Number.isFinite(ledger)) return { listings: [], nextCursor: '' };
  return fetchListings({ ...options, cursor_ledger: ledger, cursor_direction: 'desc' });
}

/**
 * Fetch the previous page of listings (ascending direction from cursor).
 */
export async function fetchPrevListingsPage(
  cursor: string,
  options: Omit<FetchListingsOptions, 'cursor_ledger' | 'offset'> = {}
): Promise<FetchListingsResult> {
  const ledger = parseInt(cursor, 10);
  if (!Number.isFinite(ledger)) return { listings: [], nextCursor: '' };
  return fetchListings({ ...options, cursor_ledger: ledger, cursor_direction: 'asc' });
}

/**
 * Fetch auctions from the indexer with optional filters.
 * Throws if the indexer is unreachable so callers can fall back to on-chain.
 */
export async function fetchAuctions(options: {
  creator?: string;
  status?: string;
} = {}): Promise<any[]> {
  const params = new URLSearchParams();
  if (options.creator) params.set('creator', options.creator);
  if (options.status) params.set('status', options.status);
  const q = params.toString();
  const raw = await fetchWithRetry<unknown>(`/auctions${q ? `?${q}` : ''}`);
  if (Array.isArray(raw)) return raw;
  return [];
}

// ─────────────────────────────────────────────────────────────
// Bid history — paginated endpoint (Feature B)
// ─────────────────────────────────────────────────────────────

export interface BidHistoryRecord {
  /** Soroban ledger sequence at which the bid was placed. */
  ledger: number;
  /** Bidder Stellar address. */
  bidder: string;
  /** Bid amount in stroops (i128 serialised as string to avoid JS precision loss). */
  amount: string;
  /** Wall-clock timestamp derived from ledger close time (ms since epoch). */
  timestamp?: number;
}

export interface BidHistoryPage {
  bids: BidHistoryRecord[];
  /** Total number of bids stored on-chain for this auction (may be capped by bid_history_cap). */
  total: number;
  /** True when there are more bids before `offset`. */
  hasMore: boolean;
}

/**
 * Fetch the paginated bid history for an auction from the indexer.
 *
 * Endpoint: GET /auctions/:id/bids?offset=<n>&limit=<n>
 *
 * The indexer returns up to `limit` bids in chronological order (oldest first).
 * Falls back to an empty page on network error so callers can degrade gracefully.
 *
 * @param auctionId - Numeric auction id.
 * @param offset    - Number of bids to skip from the beginning (default 0).
 * @param limit     - Max bids to return per page (default 20, max 100).
 */
export async function getAuctionBidHistory(
  auctionId: number,
  offset = 0,
  limit = 20
): Promise<BidHistoryPage> {
  const empty: BidHistoryPage = { bids: [], total: 0, hasMore: false };
  if (!Number.isFinite(auctionId) || auctionId <= 0) return empty;

  const clampedLimit = Math.min(Math.max(1, limit), 100);
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(clampedLimit),
  });

  try {
    const raw = await fetchWithRetry<unknown>(
      `/auctions/${auctionId}/bids?${params.toString()}`
    );

    if (raw == null) return empty;

    // Server may return { bids, total } or a plain array
    if (Array.isArray(raw)) {
      const bids = parseBidRecords(raw);
      return { bids, total: offset + bids.length, hasMore: false };
    }

    if (typeof raw === "object") {
      const r = raw as Record<string, unknown>;
      const bids = parseBidRecords(
        Array.isArray(r.bids) ? r.bids : Array.isArray(r.data) ? (r.data as unknown[]) : []
      );
      const total = typeof r.total === "number" ? r.total : offset + bids.length;
      return { bids, total, hasMore: offset + bids.length < total };
    }
  } catch (e) {
    console.warn(
      "[indexer] getAuctionBidHistory:",
      e instanceof Error ? e.message : e
    );
  }

  return empty;
}

function parseBidRecords(raw: unknown[]): BidHistoryRecord[] {
  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .map((item) => ({
      ledger: typeof item.ledger === "number" ? item.ledger : 0,
      bidder: typeof item.bidder === "string" ? item.bidder : "",
      amount: item.amount != null ? String(item.amount) : "0",
      timestamp:
        typeof item.timestamp === "number"
          ? item.timestamp
          : typeof item.ledgerTimestamp === "string"
          ? new Date(item.ledgerTimestamp).getTime()
          : undefined,
    }));
}

// ─────────────────────────────────────────────────────────────
// Prometheus-style bid-count histogram (Feature B)
//
// Tracks the distribution of how many bids auctions accumulate.
// In a browser environment this is recorded in a local in-memory
// histogram and reported to the indexer via a fire-and-forget POST
// so the backend Prometheus scrape endpoint can pick it up.
//
// Bucket boundaries mirror Prometheus default histogram buckets
// adjusted for auction bid counts: 1, 2, 5, 10, 20, 50, 100, 200, +Inf
// ─────────────────────────────────────────────────────────────

const BID_COUNT_BUCKETS = [1, 2, 5, 10, 20, 50, 100, 200] as const;

interface BidCountHistogramState {
  buckets: Map<number, number>; // upper_bound → count (cumulative)
  sum: number;
  count: number;
}

const _bidCountHistogram: BidCountHistogramState = {
  buckets: new Map(BID_COUNT_BUCKETS.map((b) => [b, 0])),
  sum: 0,
  count: 0,
};

/**
 * Record an observation into the `elcarehub_auction_bid_count` histogram.
 *
 * Called after fetching or receiving the final bid count for a completed
 * or in-progress auction.  Thread-safe for single-threaded JS environments.
 *
 * Automatically ships the updated histogram snapshot to the indexer's
 * `/metrics/histogram` endpoint in the background (fire-and-forget).
 *
 * @param bidCount - Number of bids placed on the auction.
 * @param indexerUrl - Base URL of the indexer (e.g. `config.indexerUrl`).
 */
export function recordAuctionBidCount(bidCount: number, indexerUrl: string): void {
  if (!Number.isFinite(bidCount) || bidCount < 0) return;

  _bidCountHistogram.sum += bidCount;
  _bidCountHistogram.count += 1;

  // Increment all buckets whose upper bound >= bidCount (cumulative histogram)
  for (const [upperBound] of _bidCountHistogram.buckets) {
    if (bidCount <= upperBound) {
      _bidCountHistogram.buckets.set(
        upperBound,
        (_bidCountHistogram.buckets.get(upperBound) ?? 0) + 1
      );
    }
  }

  // Fire-and-forget: ship snapshot to the indexer for Prometheus scraping
  _shipHistogramSnapshot(indexerUrl).catch(() => {
    // Metric reporting is non-critical — swallow errors silently
  });
}

/**
 * Read-only snapshot of the current histogram state.
 * Useful for testing and local debugging.
 */
export function getAuctionBidCountHistogramSnapshot(): {
  name: string;
  buckets: Array<{ le: string; count: number }>;
  sum: number;
  count: number;
} {
  const buckets: Array<{ le: string; count: number }> = [];
  for (const [upperBound, cnt] of _bidCountHistogram.buckets) {
    buckets.push({ le: String(upperBound), count: cnt });
  }
  // +Inf bucket equals total count
  buckets.push({ le: "+Inf", count: _bidCountHistogram.count });
  return {
    name: "elcarehub_auction_bid_count",
    buckets,
    sum: _bidCountHistogram.sum,
    count: _bidCountHistogram.count,
  };
}

async function _shipHistogramSnapshot(indexerUrl: string): Promise<void> {
  if (typeof fetch === "undefined") return; // SSR / non-browser env
  const snapshot = getAuctionBidCountHistogramSnapshot();
  await fetch(`${indexerUrl}/metrics/histogram`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snapshot),
    // keepalive so the request survives page navigation
    keepalive: true,
  });
}

/**
 * Fetch a single listing (with optional metadata) from the indexer.
 */
export async function fetchListingById(id: number): Promise<any | null> {
  if (!Number.isFinite(id)) return null;
  try {
    const raw = await fetchWithRetry<unknown>(`/listings/${id}`);
    return raw as any;
  } catch (e) {
    console.warn('[indexer] fetchListingById:', e instanceof Error ? e.message : e);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// SSE client — live marketplace event streaming (ISSUE-061)
// ─────────────────────────────────────────────────────────────

/** Relevant SSE event types emitted by the indexer stream. */
export type MarketplaceSSEEventType =
  | "LISTING_CREATED"
  | "LISTING_CANCELLED"
  | "ARTWORK_SOLD"
  | "BID_PLACED"
  | "AUCTION_FINALIZED"
  | "AUCTION_CANCELLED"
  | "AUCTION_EXTENDED"
  | "REORG"
  | "CRITICAL_REORG";

export interface MarketplaceSSEEvent {
  type: MarketplaceSSEEventType;
  listingId?: number;
  auctionId?: number;
  data?: Record<string, unknown>;
  // Re-org specific fields
  from_ledger?: number;
  to_ledger?: number;
  timestamp?: string;
  depth?: number;
  message?: string;
}

/** Options for {@link subscribeToMarketplaceEvents}. */
export interface SSESubscribeOptions {
  /** Called for each parsed marketplace event. */
  onEvent: (event: MarketplaceSSEEvent) => void;
  /** Called when the connection opens (or re-opens after a reconnect). */
  onOpen?: () => void;
  /** Called when the connection closes permanently (max retries exhausted). */
  onClose?: () => void;
  /**
   * The last event ID received by a previous session.
   * Passed as `Last-Event-ID` so the server can replay missed events.
   */
  lastEventId?: string;
  /**
   * Maximum number of reconnect attempts before giving up.
   * Defaults to 10.
   */
  maxRetries?: number;
  /**
   * Base delay in milliseconds between reconnect attempts.
   * Uses exponential back-off capped at 30 s.
   * Defaults to 1 000 ms.
   */
  baseRetryDelayMs?: number;
  /**
   * Debounce window in milliseconds.  When multiple events arrive rapidly
   * within this window they are batched and the callback is invoked once
   * per unique event at the end of the window.
   * Defaults to 200 ms.  Set to 0 to disable debouncing.
   */
  debounceMs?: number;
}

/** Handle returned by {@link subscribeToMarketplaceEvents}.  Call `close()` to unsubscribe. */
export interface SSESubscription {
  /** Unsubscribes and releases all resources. */
  close: () => void;
  /** The last `id` field seen on any SSE event, for use as `lastEventId` on reconnect. */
  getLastEventId: () => string | null;
}

const SSE_RELEVANT_TYPES = new Set<string>([
  "LISTING_CREATED",
  "LISTING_CANCELLED",
  "ARTWORK_SOLD",
  "BID_PLACED",
  "AUCTION_FINALIZED",
  "AUCTION_CANCELLED",
  "AUCTION_EXTENDED",
  "REORG",
  "CRITICAL_REORG",
]);

function parseSSEData(rawData: string): MarketplaceSSEEvent | null {
  try {
    const parsed = JSON.parse(rawData) as Record<string, unknown>;
    const type = (parsed.type ?? parsed.eventType) as string | undefined;
    if (!type || !SSE_RELEVANT_TYPES.has(type)) return null;
    return {
      type: type as MarketplaceSSEEventType,
      listingId:
        parsed.listingId != null ? Number(parsed.listingId) : undefined,
      auctionId:
        parsed.auctionId != null ? Number(parsed.auctionId) : undefined,
      data:
        typeof parsed.data === "object" && parsed.data !== null
          ? (parsed.data as Record<string, unknown>)
          : undefined,
      // Re-org specific fields
      from_ledger: parsed.from_ledger != null ? Number(parsed.from_ledger) : undefined,
      to_ledger: parsed.to_ledger != null ? Number(parsed.to_ledger) : undefined,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
      depth: parsed.depth != null ? Number(parsed.depth) : undefined,
      message: typeof parsed.message === "string" ? parsed.message : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Opens a persistent SSE connection to the indexer's `/events/stream` endpoint.
 *
 * Features:
 * - Exponential back-off reconnect with configurable max retries.
 * - `Last-Event-ID` header forwarded on reconnect so the server can replay
 *   missed events (pairs with ISSUE-061).
 * - Debounce/batching of rapid events within a configurable window.
 * - Returns a {@link SSESubscription} handle — call `.close()` on unmount.
 *
 * The implementation falls back gracefully when `EventSource` is unavailable
 * (e.g., SSR / test environments).
 */
export function subscribeToMarketplaceEvents(
  indexerUrl: string,
  opts: SSESubscribeOptions
): SSESubscription {
  const {
    onEvent,
    onOpen,
    onClose,
    lastEventId: initialLastEventId = null,
    maxRetries = 10,
    baseRetryDelayMs = 1_000,
    debounceMs = 200,
  } = opts;

  let es: EventSource | null = null;
  let retryCount = 0;
  let closed = false;
  let lastEventId: string | null = initialLastEventId ?? null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingEvents: MarketplaceSSEEvent[] = [];

  function flushPending() {
    debounceTimer = null;
    const eventsToFlush = pendingEvents.splice(0);
    for (const ev of eventsToFlush) {
      onEvent(ev);
    }
  }

  function dispatchEvent(ev: MarketplaceSSEEvent) {
    if (debounceMs <= 0) {
      onEvent(ev);
      return;
    }
    pendingEvents.push(ev);
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushPending, debounceMs);
  }

  function buildUrl(): string {
    const base = `${indexerUrl}/events/stream`;
    if (lastEventId) {
      return `${base}?lastEventId=${encodeURIComponent(lastEventId)}`;
    }
    return base;
  }

  function connect() {
    if (closed) return;
    if (typeof EventSource === "undefined") return; // SSR or test env without polyfill

    try {
      es = new EventSource(buildUrl());
    } catch {
      scheduleReconnect();
      return;
    }

    es.onopen = () => {
      retryCount = 0;
      onOpen?.();
    };

    es.onmessage = (msgEvent: MessageEvent) => {
      // Track Last-Event-ID for reconnect
      if (msgEvent.lastEventId) {
        lastEventId = msgEvent.lastEventId;
      }
      const parsed = parseSSEData(msgEvent.data as string);
      if (parsed) dispatchEvent(parsed);
    };

    // Also handle named events the server may emit
    for (const evType of SSE_RELEVANT_TYPES) {
      es.addEventListener(evType, (msgEvent: Event) => {
        const msg = msgEvent as MessageEvent;
        if (msg.lastEventId) lastEventId = msg.lastEventId;
        const parsed = parseSSEData(msg.data as string);
        if (parsed) dispatchEvent(parsed);
      });
    }
    es.onerror = () => {
      es?.close();
      es = null;
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (closed || retryCount >= maxRetries) {
      onClose?.();
      return;
    }
    const delay = Math.min(baseRetryDelayMs * Math.pow(2, retryCount), 30_000);
    retryCount += 1;
    setTimeout(connect, delay);
  }

  connect();

  return {
    close() {
      closed = true;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        flushPending();
      }
      es?.close();
      es = null;
    },
    getLastEventId() {
      return lastEventId;
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Price history — sparkline data for a listing
// ─────────────────────────────────────────────────────────────

export interface PriceHistoryPoint {
  /** Unix timestamp (ms) derived from changedAt */
  timestamp: number;
  /** New price as a string in stroops */
  price: string;
  /** Previous price as a string in stroops (undefined for the seed point) */
  oldPrice?: string;
  /** Address of the artist who made the change */
  changedBy?: string;
  /** Ledger sequence at which the change was recorded */
  ledger?: number;
}

/**
 * Fetches price-change history for a specific listing.
 * Endpoint: GET /listings/:id/price-history
 */
export async function getListingPriceHistory(
  listingId: number
): Promise<PriceHistoryPoint[]> {
  if (!Number.isFinite(listingId)) return [];
  try {
    const raw = await fetchWithRetry<unknown>(
      `/listings/${listingId}/price-history`
    );
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object"
      )
      .map((item) => ({
        timestamp:
          typeof item.changedAt === "string"
            ? new Date(item.changedAt).getTime()
            : typeof item.timestamp === "number"
            ? item.timestamp
            : typeof item.ledgerTimestamp === "string"
            ? new Date(item.ledgerTimestamp).getTime()
            : Date.now(),
        price:
          item.newPrice != null
            ? String(item.newPrice)
            : item.new_price != null
            ? String(item.new_price)
            : item.price != null
            ? String(item.price)
            : "0",
        oldPrice:
          item.oldPrice != null
            ? String(item.oldPrice)
            : item.old_price != null
            ? String(item.old_price)
            : undefined,
        changedBy:
          typeof item.changedBy === "string" ? item.changedBy : undefined,
        ledger:
          typeof item.changedAtLedger === "number"
            ? item.changedAtLedger
            : undefined,
      }));
  } catch (e) {
    console.warn(
      "[indexer] getListingPriceHistory:",
      e instanceof Error ? e.message : e
    );
    return [];
  }
}

/**
 * Fetches launch metrics (mints, volume, conversion) for an artist.
 */
export async function fetchArtistMetrics(
  address: string,
  range: MetricsRange = "all"
): Promise<ArtistMetrics> {
  const empty: ArtistMetrics = {
    address,
    range,
    totalListings: 0,
    totalSales: 0,
    totalVolume: "0",
    uniqueBuyers: 0,
    conversionRate: 0,
    salesTimeline: [],
  };
  if (!isNonEmptyString(address)) return empty;
  try {
    const params = range !== "all" ? `?range=${range}` : "";
    const data = await fetchWithRetry<ArtistMetrics>(
      `/artists/${encodeURIComponent(address)}/metrics${params}`
    );
    if (data && typeof data === "object" && "totalListings" in data) return data as ArtistMetrics;
  } catch (e) {
    console.warn("[indexer] fetchArtistMetrics:", e instanceof Error ? e.message : e);
  }
  return empty;
}
