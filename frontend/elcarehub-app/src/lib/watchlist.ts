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
  | "OFFER_CHANGE"
  | "LISTING_CHANGE"
  | "TX_CONFIRMED";

export interface NotificationPreferences {
  AUCTION_ENDING: boolean;
  OFFER_CHANGE: boolean;
  LISTING_CHANGE: boolean;
  TX_CONFIRMED: boolean;
}

const DEFAULT_PREFS: NotificationPreferences = {
  AUCTION_ENDING: true,
  OFFER_CHANGE: true,
  LISTING_CHANGE: true,
  TX_CONFIRMED: true,
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
  title: string;
  body: string;
  resourceType: WatchableType;
  resourceId: string;
  /** Deep-link to the affected resource */
  href: string;
  /** Transaction hash when applicable */
  txHash?: string;
  receivedAt: number;
  isRead: boolean;
  /** True when the underlying resource may have changed since this notification */
  isStale: boolean;
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

  if (
    (event.type === "LISTING_CREATED" ||
      event.type === "LISTING_CANCELLED" ||
      event.type === "ARTWORK_SOLD") &&
    event.listingId != null
  ) {
    if (!prefs.LISTING_CHANGE) return null;
    const listingId = String(event.listingId);
    const watched = watchlist.some(
      (w) => w.type === "listing" && w.id === listingId
    );
    if (!watched) return null;

    const notifId = `listing:${listingId}:${event.type}:${now}`;
    return {
      id: notifId,
      category: "LISTING_CHANGE",
      title:
        event.type === "ARTWORK_SOLD"
          ? "Watched listing sold"
          : event.type === "LISTING_CANCELLED"
          ? "Watched listing cancelled"
          : "Watched listing updated",
      body: `Listing #${listingId} has a new status.`,
      resourceType: "listing",
      resourceId: listingId,
      href: `/listings/${listingId}`,
      receivedAt: now,
      isRead: readIds.has(notifId),
      isStale: false,
    };
  }

  if (
    (event.type === "BID_PLACED" ||
      event.type === "AUCTION_FINALIZED" ||
      event.type === "AUCTION_CANCELLED" ||
      event.type === "AUCTION_EXTENDED") &&
    event.auctionId != null
  ) {
    const auctionId = String(event.auctionId);
    const watched = watchlist.some(
      (w) => w.type === "auction" && w.id === auctionId
    );
    if (!watched) return null;

    const category: NotificationCategory =
      event.type === "AUCTION_EXTENDED" || event.type === "AUCTION_FINALIZED"
        ? "AUCTION_ENDING"
        : "OFFER_CHANGE";

    if (!prefs[category]) return null;

    const notifId = `auction:${auctionId}:${event.type}:${now}`;
    return {
      id: notifId,
      category,
      title:
        event.type === "AUCTION_FINALIZED"
          ? "Watched auction ended"
          : event.type === "AUCTION_EXTENDED"
          ? "Watched auction extended"
          : event.type === "BID_PLACED"
          ? "New bid on watched auction"
          : "Watched auction cancelled",
      body: `Auction #${auctionId} activity.`,
      resourceType: "auction",
      resourceId: auctionId,
      href: `/auctions/${auctionId}`,
      receivedAt: now,
      isRead: readIds.has(notifId),
      isStale: false,
    };
  }

  return null;
}
