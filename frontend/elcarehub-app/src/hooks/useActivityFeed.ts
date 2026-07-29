"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchRecentActivity,
  subscribeToMarketplaceEvents,
  summariseSSEEvent,
  ActivityFeedEvent,
  MarketplaceSSEEvent,
} from "@/lib/indexer";
import { config } from "@/lib/config";

const FEED_MAX = 100;
const POLL_INTERVAL_MS = 30_000; // fallback poll when SSE is unavailable

export interface ActivityFeedState {
  events: ActivityFeedEvent[];
  isLoading: boolean;
  error: string | null;
  sseConnected: boolean;
  /** Reload the feed from the REST endpoint. */
  refresh: () => Promise<void>;
}

/** Convert an SSE event into an ActivityFeedEvent for local prepending. */
function sseToFeedEvent(event: MarketplaceSSEEvent): ActivityFeedEvent | null {
  const d = event.data ?? {};
  const listingId =
    event.listingId != null ? String(event.listingId) :
    d.listing_id != null   ? String(d.listing_id)    : null;

  return {
    id: Date.now(),           // ephemeral local id before page reload
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
 * Fetches the initial recent-activity list from GET /activity/recent and
 * then subscribes to the SSE stream to prepend live events as they arrive.
 * Falls back to periodic REST polling when SSE is not available.
 */
export function useActivityFeed(limit = 20): ActivityFeedState {
  const [events, setEvents] = useState<ActivityFeedEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const lastEventIdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const fresh = await fetchRecentActivity(limit);
      seenIdsRef.current = new Set(fresh.map((e) => String(e.id)));
      setEvents(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load activity");
    } finally {
      setIsLoading(false);
    }
  }, [limit]);

  // Initial load
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // SSE subscription for live updates
  useEffect(() => {
    const sub = subscribeToMarketplaceEvents(config.indexerUrl, {
      lastEventId: lastEventIdRef.current ?? undefined,
      debounceMs: 200,
      onOpen: () => setSseConnected(true),
      onClose: () => setSseConnected(false),
      onEvent: (event: MarketplaceSSEEvent) => {
        const feedEvent = sseToFeedEvent(event);
        if (!feedEvent) return;
        const dedupKey = `${feedEvent.eventType}:${feedEvent.listingId ?? ""}:${feedEvent.ledgerSequence}`;
        if (seenIdsRef.current.has(dedupKey)) return;
        seenIdsRef.current.add(dedupKey);
        setEvents((prev) => [feedEvent, ...prev].slice(0, FEED_MAX));
      },
    });

    return () => {
      lastEventIdRef.current = sub.getLastEventId();
      sub.close();
    };
  }, []);

  // Polling fallback: when SSE is not connected, refresh periodically
  useEffect(() => {
    if (sseConnected) return;
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [sseConnected, refresh]);

  return { events, isLoading, error, sseConnected, refresh };
}
