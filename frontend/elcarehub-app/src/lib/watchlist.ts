// lib/watchlist.ts — Collector watchlist and notification model (Issue #70)
//
// Storage: localStorage only, keyed by wallet address.
// Non-custodial: no server-side storage, no secrets persisted.
// Signed-out users: watchlist is keyed to "anonymous" session; on wallet
// connect the anonymous list is NOT merged automatically (privacy-preserving).

export type WatchableType = "listing" | "auction" | "collection" | "artist";

export interface WatchedItem {
  type: WatchableType;
  id: string;
  addedAt: number;
}

export type NotificationCategory =
  | "AUCTION_ENDING"
  | "AUCTION_FINALIZED"
  | "OFFER_CHANGE"
  | "OFFER_ACCEPTED"
  | "OFFER_WITHDRAWN"
  | "LISTING_CHANGE"
  | "LISTING_SOLD"
  | "LISTING_PRICE_UPDATED"
  | "TX_CONFIRMED"
  | "COLLECTION_DEPLOYED"
  | "BID_PLACED";

/** Priority determines visual treatment and sort order. */
export type NotificationPriority = "HIGH" | "MEDIUM" | "LOW";

export interface NotificationPreferences {
  AUCTION_ENDING: boolean;
  AUCTION_FINALIZED: boolean;
  OFFER_CHANGE: boolean;
  OFFER_ACCEPTED: boolean;
  OFFER_WITHDRAWN: boolean;
  LISTING_CHANGE: boolean;
  LISTING_SOLD: boolean;
  LISTING_PRICE_UPDATED: boolean;
  TX_CONFIRMED: boolean;
  COLLECTION_DEPLOYED: boolean;
  BID_PLACED: boolean;
}

const DEFAULT_PREFS: NotificationPreferences = {
  AUCTION_ENDING: true,
  AUCTION_FINALIZED: true,
  OFFER_CHANGE: true,
  OFFER_ACCEPTED: true,
  OFFER_WITHDRAWN: true,
  LISTING_CHANGE: true,
  LISTING_SOLD: true,
  LISTING_PRICE_UPDATED: false,
  TX_CONFIRMED: true,
  COLLECTION_DEPLOYED: false,
  BID_PLACED: true,
};

const WATCHLIST_KEY_PREFIX = "elcarehub:watchlist";
const PREFS_KEY_PREFIX = "elcarehub:notification-prefs";
const READ_KEY_PREFIX = "elcarehub:notifications-read";
const ANON_KEY = "anonymous";

function walletKey(publicKey: string | null): string {
  return publicKey ?? ANON_KEY;
}

// ── Watchlist CRUD ────────────────────────────────────────────────────────────

export function getWatchlist(publicKey: string | null): WatchedItem[] {
  if (typeof localStorage === "undefined") return [];
  const key = `${WATCHLIST_KEY_PREFIX}:${walletKey(publicKey)}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as WatchedItem[];
  } catch {
    return [];
  }
}

export function isWatching(
  publicKey: string | null,
  type: WatchableType,
  id: string
): boolean {
  return getWatchlist(publicKey).some((w) => w.type === type && w.id === id);
}

export function addToWatchlist(
  publicKey: string | null,
  type: WatchableType,
  id: string
): void {
  if (typeof localStorage === "undefined") return;
  const existing = getWatchlist(publicKey);
  if (existing.some((w) => w.type === type && w.id === id)) return;
  const updated: WatchedItem[] = [
    ...existing,
    { type, id, addedAt: Date.now() },
  ];
  const key = `${WATCHLIST_KEY_PREFIX}:${walletKey(publicKey)}`;
  localStorage.setItem(key, JSON.stringify(updated));
}

export function removeFromWatchlist(
  publicKey: string | null,
  type: WatchableType,
  id: string
): void {
  if (typeof localStorage === "undefined") return;
  const updated = getWatchlist(publicKey).filter(
    (w) => !(w.type === type && w.id === id)
  );
  const key = `${WATCHLIST_KEY_PREFIX}:${walletKey(publicKey)}`;
  localStorage.setItem(key, JSON.stringify(updated));
}

export function clearWatchlist(publicKey: string | null): void {
  if (typeof localStorage === "undefined") return;
  const key = `${WATCHLIST_KEY_PREFIX}:${walletKey(publicKey)}`;
  localStorage.removeItem(key);
}

// ── Notification preferences ──────────────────────────────────────────────────

export function getNotificationPreferences(
  publicKey: string | null
): NotificationPreferences {
  if (typeof localStorage === "undefined") return { ...DEFAULT_PREFS };
  const key = `${PREFS_KEY_PREFIX}:${walletKey(publicKey)}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<NotificationPreferences>;
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function setNotificationPreferences(
  publicKey: string | null,
  prefs: Partial<NotificationPreferences>
): void {
  if (typeof localStorage === "undefined") return;
  const key = `${PREFS_KEY_PREFIX}:${walletKey(publicKey)}`;
  const current = getNotificationPreferences(publicKey);
  localStorage.setItem(key, JSON.stringify({ ...current, ...prefs }));
}

// ── Read state ────────────────────────────────────────────────────────────────

export function getReadNotificationIds(publicKey: string | null): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  const key = `${READ_KEY_PREFIX}:${walletKey(publicKey)}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

export function markNotificationRead(
  publicKey: string | null,
  notifId: string
): void {
  if (typeof localStorage === "undefined") return;
  const key = `${READ_KEY_PREFIX}:${walletKey(publicKey)}`;
  const ids = getReadNotificationIds(publicKey);
  ids.add(notifId);
  localStorage.setItem(key, JSON.stringify([...ids]));
}

export function markAllNotificationsRead(
  publicKey: string | null,
  notifIds: string[]
): void {
  if (typeof localStorage === "undefined") return;
  const key = `${READ_KEY_PREFIX}:${walletKey(publicKey)}`;
  const ids = getReadNotificationIds(publicKey);
  notifIds.forEach((id) => ids.add(id));
  localStorage.setItem(key, JSON.stringify([...ids]));
}

// ── In-app notification model ─────────────────────────────────────────────────

export interface AppNotification {
  id: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  title: string;
  body: string;
  resourceType: WatchableType;
  resourceId: string;
  /** Deep-link to the affected resource */
  href: string;
  /** Transaction hash when applicable */
  txHash?: string;
  /** Amount string for bids/offers/sales (human-readable, may include token symbol) */
  amount?: string;
  receivedAt: number;
  isRead: boolean;
  /** True when the underlying resource may have changed since this notification */
  isStale: boolean;
}

/** Category labels for notification preferences UI */
export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  AUCTION_ENDING: "Auction Ending Soon",
  AUCTION_FINALIZED: "Auction Finalized",
  OFFER_CHANGE: "Offer Activity",
  OFFER_ACCEPTED: "Offer Accepted",
  OFFER_WITHDRAWN: "Offer Withdrawn",
  LISTING_CHANGE: "Listing Changes",
  LISTING_SOLD: "Listing Sold",
  LISTING_PRICE_UPDATED: "Price Updates",
  TX_CONFIRMED: "Transaction Confirmed",
  COLLECTION_DEPLOYED: "Collection Deployed",
  BID_PLACED: "New Bids",
};

/** Priority for each notification category */
export const CATEGORY_PRIORITY: Record<NotificationCategory, NotificationPriority> = {
  AUCTION_ENDING: "HIGH",
  AUCTION_FINALIZED: "HIGH",
  OFFER_ACCEPTED: "HIGH",
  LISTING_SOLD: "HIGH",
  OFFER_CHANGE: "MEDIUM",
  OFFER_WITHDRAWN: "MEDIUM",
  BID_PLACED: "MEDIUM",
  LISTING_CHANGE: "MEDIUM",
  TX_CONFIRMED: "MEDIUM",
  COLLECTION_DEPLOYED: "LOW",
  LISTING_PRICE_UPDATED: "LOW",
};

/** Format a raw stroop amount as a human-readable string */
function formatAmount(amount: unknown, token?: unknown): string {
  if (amount == null) return "";
  const raw = typeof amount === "bigint" ? Number(amount) : Number(String(amount));
  if (!Number.isFinite(raw) || raw === 0) return "";
  // XLM has 7 decimal places
  const formatted = (raw / 1e7).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 7,
  });
  const symbol = typeof token === "string" && token.length > 0 ? " XLM" : " XLM";
  return `${formatted}${symbol}`;
}

/**
 * Maps an SSE event from the indexer stream to an AppNotification when the
 * affected resource is in the user's watchlist.
 * Returns null when the event is not relevant to any watched item.
 */
export function sseEventToNotification(
  event: {
    type: string;
    listingId?: number;
    auctionId?: number;
    data?: Record<string, unknown>;
  },
  watchlist: WatchedItem[],
  prefs: NotificationPreferences,
  readIds: Set<string>
): AppNotification | null {
  const now = Date.now();
  const d = event.data ?? {};

  // ── Listing events ──────────────────────────────────────────────────────────
  if (
    (event.type === "LISTING_CREATED" ||
      event.type === "LISTING_CANCELLED" ||
      event.type === "ARTWORK_SOLD" ||
      event.type === "LISTING_UPDATED" ||
      event.type === "LISTING_PRICE_UPDATED" ||
      event.type === "LISTING_EXPIRED") &&
    event.listingId != null
  ) {
    const listingId = String(event.listingId);
    const watched = watchlist.some(
      (w) => w.type === "listing" && w.id === listingId
    );
    if (!watched) return null;

    if (event.type === "ARTWORK_SOLD") {
      if (!prefs.LISTING_SOLD) return null;
      const notifId = `listing:${listingId}:ARTWORK_SOLD:${now}`;
      const amount = formatAmount(d.price);
      return {
        id: notifId,
        category: "LISTING_SOLD",
        priority: CATEGORY_PRIORITY.LISTING_SOLD,
        title: "Your watched listing sold!",
        body: amount
          ? `Listing #${listingId} sold for ${amount}.`
          : `Listing #${listingId} has been sold.`,
        amount,
        resourceType: "listing",
        resourceId: listingId,
        href: `/listings/${listingId}`,
        receivedAt: now,
        isRead: readIds.has(notifId),
        isStale: false,
      };
    }

    if (event.type === "LISTING_PRICE_UPDATED") {
      if (!prefs.LISTING_PRICE_UPDATED) return null;
      const notifId = `listing:${listingId}:LISTING_PRICE_UPDATED:${now}`;
      const newPrice = formatAmount(d.new_price);
      const oldPrice = formatAmount(d.old_price);
      return {
        id: notifId,
        category: "LISTING_PRICE_UPDATED",
        priority: CATEGORY_PRIORITY.LISTING_PRICE_UPDATED,
        title: "Price updated on watched listing",
        body: oldPrice && newPrice
          ? `Listing #${listingId} price changed from ${oldPrice} to ${newPrice}.`
          : `Listing #${listingId} price was updated.`,
        amount: newPrice,
        resourceType: "listing",
        resourceId: listingId,
        href: `/listings/${listingId}`,
        receivedAt: now,
        isRead: readIds.has(notifId),
        isStale: false,
      };
    }

    if (!prefs.LISTING_CHANGE) return null;
    const notifId = `listing:${listingId}:${event.type}:${now}`;
    return {
      id: notifId,
      category: "LISTING_CHANGE",
      priority: CATEGORY_PRIORITY.LISTING_CHANGE,
      title:
        event.type === "LISTING_CANCELLED"
          ? "Watched listing cancelled"
          : event.type === "LISTING_EXPIRED"
          ? "Watched listing expired"
          : "Watched listing updated",
      body: `Listing #${listingId} status changed.`,
      resourceType: "listing",
      resourceId: listingId,
      href: `/listings/${listingId}`,
      receivedAt: now,
      isRead: readIds.has(notifId),
      isStale: false,
    };
  }

  // ── Auction events ──────────────────────────────────────────────────────────
  if (event.auctionId != null) {
    const auctionId = String(event.auctionId);
    const watched = watchlist.some(
      (w) => w.type === "auction" && w.id === auctionId
    );
    if (!watched) return null;

    if (event.type === "BID_PLACED") {
      if (!prefs.BID_PLACED) return null;
      const notifId = `auction:${auctionId}:BID_PLACED:${now}`;
      const amount = formatAmount(d.bid_amount);
      return {
        id: notifId,
        category: "BID_PLACED",
        priority: CATEGORY_PRIORITY.BID_PLACED,
        title: "New bid on watched auction",
        body: amount
          ? `Auction #${auctionId} received a bid of ${amount}.`
          : `Auction #${auctionId} has a new bid.`,
        amount,
        resourceType: "auction",
        resourceId: auctionId,
        href: `/auctions/${auctionId}`,
        receivedAt: now,
        isRead: readIds.has(notifId),
        isStale: false,
      };
    }

    if (
      event.type === "AUCTION_EXTENDED" ||
      event.type === "AUCTION_ENDING"
    ) {
      if (!prefs.AUCTION_ENDING) return null;
      const notifId = `auction:${auctionId}:${event.type}:${now}`;
      return {
        id: notifId,
        category: "AUCTION_ENDING",
        priority: CATEGORY_PRIORITY.AUCTION_ENDING,
        title:
          event.type === "AUCTION_EXTENDED"
            ? "Watched auction extended"
            : "Watched auction ending soon",
        body:
          event.type === "AUCTION_EXTENDED"
            ? `Auction #${auctionId} was extended due to a last-minute bid.`
            : `Auction #${auctionId} is ending soon — place your bid!`,
        resourceType: "auction",
        resourceId: auctionId,
        href: `/auctions/${auctionId}`,
        receivedAt: now,
        isRead: readIds.has(notifId),
        isStale: false,
      };
    }

    if (
      event.type === "AUCTION_FINALIZED" ||
      event.type === "AUCTION_RESOLVED"
    ) {
      if (!prefs.AUCTION_FINALIZED) return null;
      const notifId = `auction:${auctionId}:AUCTION_FINALIZED:${now}`;
      const amount = formatAmount(d.amount);
      const winner = typeof d.winner === "string" ? d.winner : null;
      return {
        id: notifId,
        category: "AUCTION_FINALIZED",
        priority: CATEGORY_PRIORITY.AUCTION_FINALIZED,
        title: winner ? "Watched auction ended with a winner" : "Watched auction ended — no bids",
        body: winner && amount
          ? `Auction #${auctionId} finalized. Winning bid: ${amount}.`
          : winner
          ? `Auction #${auctionId} was finalized.`
          : `Auction #${auctionId} ended with no bids.`,
        amount,
        resourceType: "auction",
        resourceId: auctionId,
        href: `/auctions/${auctionId}`,
        receivedAt: now,
        isRead: readIds.has(notifId),
        isStale: false,
      };
    }

    if (event.type === "AUCTION_CANCELLED") {
      if (!prefs.LISTING_CHANGE) return null;
      const notifId = `auction:${auctionId}:AUCTION_CANCELLED:${now}`;
      return {
        id: notifId,
        category: "LISTING_CHANGE",
        priority: CATEGORY_PRIORITY.LISTING_CHANGE,
        title: "Watched auction cancelled",
        body: `Auction #${auctionId} was cancelled.`,
        resourceType: "auction",
        resourceId: auctionId,
        href: `/auctions/${auctionId}`,
        receivedAt: now,
        isRead: readIds.has(notifId),
        isStale: false,
      };
    }
  }

  // ── Offer events (targeted at artist or offerer) ────────────────────────────
  if (
    event.type === "OFFER_ACCEPTED" &&
    event.listingId != null
  ) {
    const listingId = String(event.listingId);
    const watched = watchlist.some(
      (w) => w.type === "listing" && w.id === listingId
    );
    if (!watched) return null;
    if (!prefs.OFFER_ACCEPTED) return null;
    const notifId = `listing:${listingId}:OFFER_ACCEPTED:${now}`;
    const amount = formatAmount(d.amount);
    return {
      id: notifId,
      category: "OFFER_ACCEPTED",
      priority: CATEGORY_PRIORITY.OFFER_ACCEPTED,
      title: "Offer accepted on watched listing",
      body: amount
        ? `Listing #${listingId}: an offer of ${amount} was accepted.`
        : `Listing #${listingId}: an offer was accepted.`,
      amount,
      resourceType: "listing",
      resourceId: listingId,
      href: `/listings/${listingId}`,
      receivedAt: now,
      isRead: readIds.has(notifId),
      isStale: false,
    };
  }

  if (
    event.type === "OFFER_WITHDRAWN" &&
    event.listingId != null
  ) {
    const listingId = String(event.listingId);
    const watched = watchlist.some(
      (w) => w.type === "listing" && w.id === listingId
    );
    if (!watched) return null;
    if (!prefs.OFFER_WITHDRAWN) return null;
    const notifId = `listing:${listingId}:OFFER_WITHDRAWN:${now}`;
    return {
      id: notifId,
      category: "OFFER_WITHDRAWN",
      priority: CATEGORY_PRIORITY.OFFER_WITHDRAWN,
      title: "Offer withdrawn on watched listing",
      body: `Listing #${listingId}: an offer was withdrawn.`,
      resourceType: "listing",
      resourceId: listingId,
      href: `/listings/${listingId}`,
      receivedAt: now,
      isRead: readIds.has(notifId),
      isStale: false,
    };
  }

  if (
    (event.type === "OFFER_MADE" || event.type === "OFFER_REJECTED") &&
    event.listingId != null
  ) {
    const listingId = String(event.listingId);
    const watched = watchlist.some(
      (w) => w.type === "listing" && w.id === listingId
    );
    if (!watched) return null;
    if (!prefs.OFFER_CHANGE) return null;
    const notifId = `listing:${listingId}:${event.type}:${now}`;
    const amount = formatAmount(d.amount);
    return {
      id: notifId,
      category: "OFFER_CHANGE",
      priority: CATEGORY_PRIORITY.OFFER_CHANGE,
      title: event.type === "OFFER_MADE"
        ? "New offer on watched listing"
        : "Offer rejected on watched listing",
      body: event.type === "OFFER_MADE" && amount
        ? `Listing #${listingId}: new offer of ${amount}.`
        : `Listing #${listingId}: offer status changed.`,
      amount: event.type === "OFFER_MADE" ? amount : undefined,
      resourceType: "listing",
      resourceId: listingId,
      href: `/listings/${listingId}`,
      receivedAt: now,
      isRead: readIds.has(notifId),
      isStale: false,
    };
  }

  // ── Deploy / collection events ──────────────────────────────────────────────
  if (
    (event.type === "DEPLOY_NORMAL_721" ||
      event.type === "DEPLOY_NORMAL_1155" ||
      event.type === "DEPLOY_LAZY_721" ||
      event.type === "DEPLOY_LAZY_1155") &&
    Array.isArray(event.data)
  ) {
    if (!prefs.COLLECTION_DEPLOYED) return null;
    const creator = (event.data as unknown[])[0];
    const contractAddr = (event.data as unknown[])[1];
    const watched = watchlist.some(
      (w) =>
        (w.type === "artist" && typeof creator === "string" && w.id === creator) ||
        (w.type === "collection" && typeof contractAddr === "string" && w.id === contractAddr)
    );
    if (!watched) return null;
    const notifId = `collection:${String(contractAddr)}:${event.type}:${now}`;
    return {
      id: notifId,
      category: "COLLECTION_DEPLOYED",
      priority: CATEGORY_PRIORITY.COLLECTION_DEPLOYED,
      title: "Watched artist deployed a collection",
      body: `A new ${event.type.replace("DEPLOY_", "").replace("_", " ").toLowerCase()} collection was deployed.`,
      resourceType: "collection",
      resourceId: typeof contractAddr === "string" ? contractAddr : "",
      href: `/collections/${String(contractAddr)}`,
      receivedAt: now,
      isRead: readIds.has(notifId),
      isStale: false,
    };
  }

  return null;
}
