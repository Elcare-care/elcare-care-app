"use client";

import { useState, useRef, useEffect, useCallback, useMemo, type KeyboardEvent } from "react";
import Link from "next/link";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Activity as ActivityIcon,
  RefreshCw,
  ShoppingCart,
  Gavel,
  Tag,
  ArrowUpDown,
  Layers,
  Wifi,
  WifiOff,
  TrendingUp,
  AlertCircle,
  ArrowUp,
  Loader2,
} from "lucide-react";
import { Breadcrumb } from "@/components/Breadcrumb";
import { useActivityFeed } from "@/hooks/useActivityFeed";
import { ActivityFeedEvent, activityEventKey } from "@/lib/indexer";
import { formatRelativeTime } from "@/lib/format";
import { StaleBanner } from "@/components/StaleBanner";

// ── Event type icon mapping ───────────────────────────────────────────────────

function EventIcon({ eventType }: { eventType: string }) {
  if (eventType.startsWith("AUCTION")) return <Gavel size={15} className="text-terracotta-400 shrink-0" />;
  if (eventType.startsWith("OFFER"))   return <Tag   size={15} className="text-brand-400 shrink-0" />;
  if (eventType.startsWith("DEPLOY"))  return <Layers size={15} className="text-purple-400 shrink-0" />;
  if (eventType === "ARTWORK_SOLD")    return <ShoppingCart size={15} className="text-green-400 shrink-0" />;
  if (eventType.includes("PRICE"))     return <ArrowUpDown size={15} className="text-amber-400 shrink-0" />;
  return <ActivityIcon size={15} className="text-gray-400 shrink-0" />;
}

// ── Domain badge ──────────────────────────────────────────────────────────────

const DOMAIN_BADGE: Record<string, { label: string; cls: string }> = {
  ARTWORK_SOLD:          { label: "Sale",     cls: "bg-green-500/15 text-green-400" },
  LISTING_CREATED:       { label: "Listed",   cls: "bg-brand-500/15 text-brand-400" },
  LISTING_CANCELLED:     { label: "Cancelled",cls: "bg-red-500/15 text-red-400" },
  LISTING_PRICE_UPDATED: { label: "Price",    cls: "bg-amber-500/15 text-amber-400" },
  BID_PLACED:            { label: "Bid",      cls: "bg-terracotta-500/15 text-terracotta-400" },
  AUCTION_RESOLVED:      { label: "Auction",  cls: "bg-terracotta-500/15 text-terracotta-400" },
  AUCTION_FINALIZED:     { label: "Auction",  cls: "bg-terracotta-500/15 text-terracotta-400" },
  AUCTION_CANCELLED:     { label: "Auction",  cls: "bg-red-500/15 text-red-400" },
  OFFER_MADE:            { label: "Offer",    cls: "bg-brand-500/15 text-brand-400" },
  OFFER_ACCEPTED:        { label: "Offer",    cls: "bg-green-500/15 text-green-400" },
  OFFER_WITHDRAWN:       { label: "Offer",    cls: "bg-gray-500/15 text-gray-400" },
};

function DomainBadge({ eventType }: { eventType: string }) {
  const badge = DOMAIN_BADGE[eventType];
  if (!badge) return null;
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${badge.cls}`}>
      {badge.label}
    </span>
  );
}

// ── Resource link ─────────────────────────────────────────────────────────────

function resourceHref(event: ActivityFeedEvent): string | null {
  if (event.listingId) {
    const type = event.eventType;
    if (type.startsWith("AUCTION")) return `/auctions/${event.listingId}`;
    return `/listings/${event.listingId}`;
  }
  if (event.data?.auction_id) return `/auctions/${event.data.auction_id}`;
  if (event.data?.contract_address) return `/collections/${event.data.contract_address}`;
  return null;
}

function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

// ── Single event row ──────────────────────────────────────────────────────────

function ActivityRow({ event }: { event: ActivityFeedEvent }) {
  const href = resourceHref(event);
  const ts = event.ledgerTimestamp ? new Date(event.ledgerTimestamp).getTime() : 0;

  return (
    <div
      className="flex items-start gap-3 px-4 py-3 border-b border-white/5 hover:bg-white/[0.03] transition-colors group"
      data-testid={`activity-event-${activityEventKey(event)}`}
    >
      <div className="mt-0.5">
        <EventIcon eventType={event.eventType} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {href ? (
            <Link
              href={href}
              className="text-sm font-medium text-white hover:text-brand-400 transition-colors truncate"
            >
              {event.summary ?? event.eventType}
            </Link>
          ) : (
            <span className="text-sm font-medium text-white truncate">
              {event.summary ?? event.eventType}
            </span>
          )}
          <DomainBadge eventType={event.eventType} />
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-[11px] text-gray-500">
          {event.actor && (
            <span title={event.actor}>{shortAddress(event.actor)}</span>
          )}
          {event.actor && ts > 0 && <span>·</span>}
          {ts > 0 && (
            <span>{formatRelativeTime(ts)}</span>
          )}
          {event.ledgerSequence > 0 && (
            <>
              <span>·</span>
              <span className="font-mono">ledger {event.ledgerSequence.toLocaleString()}</span>
            </>
          )}
          {event.txHash && (
            <>
              <span>·</span>
              {/* Issue #522 — direct on-chain verification path, independent
                  of whether the indexer's view of this event is current. */}
              <Link
                href={`/tx/${event.txHash}`}
                className="inline-flex items-center gap-0.5 text-brand-400 hover:text-brand-300 transition-colors"
              >
                Verify on-chain
                <ExternalLink size={9} />
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Bottom-of-list loader / end-of-list row ────────────────────────────────────

function TailRow({ isLoadingMore, hasMore }: { isLoadingMore: boolean; hasMore: boolean }) {
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-4 text-xs text-gray-500">
      {isLoadingMore ? (
        <>
          <Loader2 size={13} className="animate-spin" />
          Loading more…
        </>
      ) : hasMore ? (
        <span className="opacity-0">·</span>
      ) : (
        <span>End of activity</span>
      )}
    </div>
  );
}

// ── Filter bar ────────────────────────────────────────────────────────────────

type DomainFilter = "all" | "listing" | "auction" | "offer" | "deploy";

const FILTER_LABELS: Record<DomainFilter, string> = {
  all:     "All",
  listing: "Listings",
  auction: "Auctions",
  offer:   "Offers",
  deploy:  "Collections",
};

function matchesDomainFilter(event: ActivityFeedEvent, filter: DomainFilter): boolean {
  if (filter === "all") return true;
  if (filter === "listing") {
    return (
      event.eventType.startsWith("LISTING") ||
      event.eventType === "ARTWORK_SOLD" ||
      event.eventType.startsWith("OFFER")
    );
  }
  if (filter === "auction") return event.eventType.startsWith("AUCTION") || event.eventType === "BID_PLACED";
  if (filter === "offer")   return event.eventType.startsWith("OFFER");
  if (filter === "deploy")  return event.eventType.startsWith("DEPLOY");
  return true;
}

// ── Virtualized, cursor-paginated list ────────────────────────────────────────

const ROW_ESTIMATE_PX = 68;
const LIST_HEIGHT_CLASS = "h-[65vh] min-h-[420px] max-h-[780px]";

function ActivityList({
  visible,
  hasMore,
  isLoadingMore,
  loadMoreError,
  onLoadMore,
}: {
  visible: ActivityFeedEvent[];
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMoreError: string | null;
  onLoadMore: () => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  // One extra virtual row for the trailing loader / end-of-list marker.
  const rowCount = visible.length + 1;

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: 8,
    getItemKey: (index) =>
      index < visible.length ? activityEventKey(visible[index]) : "__tail__",
  });

  const virtualItems = rowVirtualizer.getVirtualItems();

  // Infinite loading: once the trailing sentinel row scrolls into range, fetch the next page.
  useEffect(() => {
    const last = virtualItems[virtualItems.length - 1];
    if (!last) return;
    if (last.index >= visible.length && hasMore && !isLoadingMore) {
      onLoadMore();
    }
  }, [virtualItems, visible.length, hasMore, isLoadingMore, onLoadMore]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const el = parentRef.current;
      if (!el) return;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          el.scrollBy({ top: ROW_ESTIMATE_PX, behavior: "smooth" });
          break;
        case "ArrowUp":
          e.preventDefault();
          el.scrollBy({ top: -ROW_ESTIMATE_PX, behavior: "smooth" });
          break;
        case "PageDown":
          e.preventDefault();
          el.scrollBy({ top: el.clientHeight * 0.9, behavior: "smooth" });
          break;
        case "PageUp":
          e.preventDefault();
          el.scrollBy({ top: -el.clientHeight * 0.9, behavior: "smooth" });
          break;
        case "Home":
          e.preventDefault();
          rowVirtualizer.scrollToIndex(0, { align: "start" });
          break;
        case "End":
          e.preventDefault();
          rowVirtualizer.scrollToIndex(rowCount - 1, { align: "end" });
          break;
        default:
          break;
      }
    },
    [rowVirtualizer, rowCount]
  );

  return (
    <div>
      <div
        ref={parentRef}
        className={`${LIST_HEIGHT_CLASS} overflow-y-auto overflow-x-hidden outline-none focus-visible:ring-1 focus-visible:ring-brand-400/60`}
        role="feed"
        aria-label="Marketplace activity"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        data-testid="activity-scroll-container"
      >
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {virtualItems.map((virtualRow) => {
            const isTailRow = virtualRow.index >= visible.length;
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {isTailRow ? (
                  <TailRow isLoadingMore={isLoadingMore} hasMore={hasMore} />
                ) : (
                  <ActivityRow event={visible[virtualRow.index]} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {loadMoreError && (
        <div className="flex items-center justify-between gap-3 px-4 py-2 border-t border-white/5 bg-red-500/5">
          <span className="text-xs text-red-400">Couldn&apos;t load more: {loadMoreError}</span>
          <button
            type="button"
            onClick={onLoadMore}
            className="text-xs text-brand-400 hover:text-brand-300 transition-colors shrink-0"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ActivityPage() {
  const [domainFilter, setDomainFilter] = useState<DomainFilter>("all");
  const {
    events,
    isLoading,
    isLoadingMore,
    error,
    loadMoreError,
    sseConnected,
    hasMore,
    pendingCount,
    refresh,
    loadMore,
    commitPending,
  } = useActivityFeed(50);

  const visible = useMemo(
    () => events.filter((e) => matchesDomainFilter(e, domainFilter)),
    [events, domainFilter]
  );

  return (
    <div className="min-h-screen bg-midnight-950 pt-20">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8">
        <Breadcrumb items={[{ label: "Activity" }]} className="mb-6" />

        {/* Header */}
        <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-brand-500/10">
              <ActivityIcon size={20} className="text-brand-400" />
            </div>
            <div>
              <h1 className="text-xl font-display font-bold text-white">Platform Activity</h1>
              <p className="text-xs text-gray-500 mt-0.5">Real-time marketplace events</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* SSE status indicator */}
            <span
              className="flex items-center gap-1.5 text-xs"
              title={sseConnected ? "Live updates active" : "Polling for updates"}
            >
              {sseConnected ? (
                <>
                  <Wifi size={12} className="text-mint-400" />
                  <span className="text-mint-400">Live</span>
                </>
              ) : (
                <>
                  <WifiOff size={12} className="text-gray-500" />
                  <span className="text-gray-500">Polling</span>
                </>
              )}
            </span>
            {/* Refresh button */}
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={isLoading}
              className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors disabled:opacity-50"
              aria-label="Refresh activity feed"
              data-testid="activity-refresh-btn"
            >
              <RefreshCw
                size={13}
                className={isLoading ? "animate-spin" : ""}
              />
              Refresh
            </button>
          </div>
        </div>

        {/* Issue #522 — non-blocking indexer freshness indicator */}
        {freshness.status !== "healthy" && (
          <div className="mb-4">
            <StaleBanner
              freshness={freshness.freshness}
              status={freshness.status}
              reorg={freshness.reorg}
              onRefresh={freshness.refresh}
              isRefreshing={freshness.isRefreshing}
            />
          </div>
        )}

        {/* Domain filter tabs */}
        <div className="flex gap-1 mb-4 flex-wrap" role="tablist" aria-label="Filter by domain">
          {(Object.keys(FILTER_LABELS) as DomainFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={domainFilter === f}
              onClick={() => setDomainFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                domainFilter === f
                  ? "bg-brand-500 text-white"
                  : "bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white"
              }`}
              data-testid={`activity-filter-${f}`}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>

        {/* New-activity pill — merges buffered SSE/poll events without ever
            auto-scrolling or shifting the list the user is currently browsing. */}
        {pendingCount > 0 && (
          <button
            type="button"
            onClick={commitPending}
            className="w-full mb-3 flex items-center justify-center gap-2 rounded-xl border border-brand-500/30 bg-brand-500/10 text-brand-300 hover:bg-brand-500/15 transition-colors text-xs font-medium px-3 py-2"
            data-testid="activity-new-events-pill"
          >
            <ArrowUp size={12} />
            {pendingCount} new event{pendingCount !== 1 ? "s" : ""} — click to view
          </button>
        )}

        {/* Content */}
        <div className="rounded-2xl border border-white/10 bg-midnight-900 overflow-hidden">
          {isLoading && events.length === 0 ? (
            <div className="space-y-0 animate-pulse">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-white/5">
                  <div className="w-4 h-4 rounded-full bg-white/10" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 bg-white/10 rounded w-3/4" />
                    <div className="h-2.5 bg-white/5 rounded w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : error && events.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center px-4">
              <AlertCircle size={32} className="text-red-400" />
              <p className="text-sm font-medium text-white">Failed to load activity</p>
              <p className="text-xs text-gray-500">{error}</p>
              <button
                type="button"
                onClick={() => void refresh()}
                className="mt-2 text-xs text-brand-400 hover:text-brand-300 transition-colors"
              >
                Try again
              </button>
            </div>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <TrendingUp size={36} className="text-gray-600" />
              <p className="text-sm font-medium text-gray-500">
                {domainFilter === "all"
                  ? "No activity yet"
                  : `No ${FILTER_LABELS[domainFilter].toLowerCase()} activity yet`}
              </p>
            </div>
          ) : (
            <ActivityList
              visible={visible}
              hasMore={hasMore}
              isLoadingMore={isLoadingMore}
              loadMoreError={loadMoreError}
              onLoadMore={() => void loadMore()}
            />
          )}
        </div>

        {/* Footer: event count */}
        {visible.length > 0 && (
          <p className="text-center text-[11px] text-gray-600 mt-3">
            Showing {visible.length} event{visible.length !== 1 ? "s" : ""}
            {!sseConnected && " · live updates paused"}
          </p>
        )}
      </div>
    </div>
  );
}
