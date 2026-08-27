"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchActivityPage,
  fetchNextActivityPage,
  subscribeToMarketplaceEvents,
  summariseSSEEvent,
  activityEventKey,
  ActivityFeedEvent,
  MarketplaceSSEEvent,
} from "@/lib/indexer";
import { config } from "@/lib/config";

const DEFAULT_PAGE_LIMIT = 50;
const POLL_INTERVAL_MS = 30_000; // fallback poll when SSE is unavailable

export interface ActivityFeedState {
  /** Events currently rendered, oldest-loaded-page-last (newest first overall). */
  events: ActivityFeedEvent[];
  /** True only for the very first page load (or an explicit refresh). */
  isLoading: boolean;
  /** True while a next-page (cursor) fetch is in flight. */
  isLoadingMore: boolean;
  /** Error from the initial load / an explicit refresh. */
  error: string | null;
  /** Error from a loadMore() call — does not clear already-loaded events. */
  loadMoreError: string | null;
  sseConnected: boolean;
  /** Whether another (older) page is available via loadMore(). */
  hasMore: boolean;
  /** Number of live events buffered but not yet merged into `events`. */
  pendingCount: number;
  /** Reload the feed from the start (REST endpoint), resetting pagination. */
  refresh: () => Promise<void>;
  /** Fetch the next cursor page and append it. Safe to call repeatedly — guards duplicate/in-flight cursors. */
  loadMore: () => Promise<void>;
  /** Merge buffered live (SSE/poll) events into the visible list. */
  commitPending: () => void;
}

/** Convert an SSE event into an ActivityFeedEvent for local buffering. */
function sseToFeedEvent(event: MarketplaceSSEEvent): ActivityFeedEvent | null {
  const d = event.data ?? {};
  const listingId =
    event.listingId != null ? String(event.listingId) :
    d.listing_id != null   ? String(d.listing_id)    : null;

  return {
    id: 0, // no durable indexer row id yet — activityEventKey() falls back to a composite key
    eventType: event.type,
    listingId,
    actor: String(d.actor ?? d.artist ?? d.creator ?? d.bidder ?? d.offerer ?? ""),
    data: d,
    ledgerSequence: typeof d.ledger_sequence === "number" ? d.ledger_sequence : 0,
    ledgerTimestamp: event.timestamp ?? null,
    summary: summariseSSEEvent(event),
  };
}

/**
 * useActivityFeed
 *
 * Cursor-driven infinite loading over GET /activity/recent (the same
 * cursor_ledger/cursor_direction + X-Next-Cursor convention used by the
 * listings endpoints), with live updates streamed over SSE.
 *
 * Live (SSE and poll-fallback) events are never spliced directly into the
 * rendered `events` array — they land in a buffer (`pendingCount`) that the
 * caller merges explicitly via `commitPending()`. This guarantees an
 * incoming event can never shift the scroll position of a virtualized list
 * the user is currently browsing.
 */
export function useActivityFeed(limit = DEFAULT_PAGE_LIMIT): ActivityFeedState {
  const [events, setEvents] = useState<ActivityFeedEvent[]>([]);
  const [pending, setPending] = useState<ActivityFeedEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const seenKeysRef = useRef<Set<string>>(new Set());
  const cursorRef = useRef<string | null>(null);
  /** Cursors already requested (or in flight) — guards duplicate page fetches. */
  const fetchedCursorsRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef(false);
  const lastEventIdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsLoading(true);
    setError(null);
    setLoadMoreError(null);
    try {
      const page = await fetchActivityPage({ limit });
      seenKeysRef.current = new Set(page.events.map(activityEventKey));
      fetchedCursorsRef.current = new Set();
      cursorRef.current = page.nextCursor || null;
      setHasMore(Boolean(page.nextCursor) && page.events.length > 0);
      setEvents(page.events);
      setPending([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load activity");
    } finally {
      setIsLoading(false);
      inFlightRef.current = false;
    }
  }, [limit]);

  const loadMore = useCallback(async () => {
    const cursor = cursorRef.current;
    if (!cursor || inFlightRef.current) return;
    if (fetchedCursorsRef.current.has(cursor)) return; // already requested this cursor
    fetchedCursorsRef.current.add(cursor);
    inFlightRef.current = true;
    setIsLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await fetchNextActivityPage(cursor, { limit });
      const fresh = page.events.filter((e) => {
        const key = activityEventKey(e);
        if (seenKeysRef.current.has(key)) return false;
        seenKeysRef.current.add(key);
        return true;
      });
      if (fresh.length > 0) {
        setEvents((prev) => [...prev, ...fresh]);
      }
      cursorRef.current = page.nextCursor || null;
      setHasMore(Boolean(page.nextCursor) && page.events.length > 0);
    } catch (err) {
      setLoadMoreError(err instanceof Error ? err.message : "Failed to load more activity");
      // Allow retrying the same cursor since this attempt failed.
      fetchedCursorsRef.current.delete(cursor);
    } finally {
      setIsLoadingMore(false);
      inFlightRef.current = false;
    }
  }, [limit]);

  // Initial load
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  // SSE subscription for live updates — buffered, never mutates `events` directly.
  useEffect(() => {
    const sub = subscribeToMarketplaceEvents(config.indexerUrl, {
      lastEventId: lastEventIdRef.current ?? undefined,
      debounceMs: 200,
      onOpen: () => setSseConnected(true),
      onClose: () => setSseConnected(false),
      onEvent: (event: MarketplaceSSEEvent) => {
        const feedEvent = sseToFeedEvent(event);
        if (!feedEvent) return;
        const key = activityEventKey(feedEvent);
        if (seenKeysRef.current.has(key)) return;
        seenKeysRef.current.add(key);
        setPending((prev) => [feedEvent, ...prev]);
      },
    });

    return () => {
      lastEventIdRef.current = sub.getLastEventId();
      sub.close();
    };
  }, []);

  // Polling fallback: when SSE is not connected, periodically check the
  // newest page for events we haven't seen and buffer them (same as SSE) —
  // this deliberately avoids a full reload that would blow away the user's
  // loaded pages / scroll position.
  useEffect(() => {
    if (sseConnected) return;
    const timer = setInterval(async () => {
      if (inFlightRef.current) return;
      try {
        const page = await fetchActivityPage({ limit });
        const fresh = page.events.filter((e) => !seenKeysRef.current.has(activityEventKey(e)));
        if (fresh.length === 0) return;
        fresh.forEach((e) => seenKeysRef.current.add(activityEventKey(e)));
        setPending((prev) => [...fresh, ...prev]);
      } catch {
        // Best-effort fallback — stay silent, next tick will retry.
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [sseConnected, limit]);

  const commitPending = useCallback(() => {
    setPending((prevPending) => {
      if (prevPending.length === 0) return prevPending;
      setEvents((prevEvents) => [...prevPending, ...prevEvents]);
      return [];
    });
  }, []);

  return {
    events,
    isLoading,
    isLoadingMore,
    error,
    loadMoreError,
    sseConnected,
    hasMore,
    pendingCount: pending.length,
    refresh,
    loadMore,
    commitPending,
  };
}
