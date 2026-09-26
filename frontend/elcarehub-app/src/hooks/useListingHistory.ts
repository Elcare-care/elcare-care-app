"use client";

/**
 * useListingHistory — paginated provenance history for a listing. (Issue #532)
 *
 * Fetches from GET /listings/:id/history with offset/limit pagination.
 * Supports "load more" by appending successive pages to the in-memory list.
 * Handles SSE reorg events by setting a reorgDetected flag so the UI can
 * prompt the user to refresh (without auto-duplicating canonical history).
 *
 * Supported event types: LISTED, OFFER_SUBMITTED, OFFER_ACCEPTED,
 * PURCHASE, SALE, ROYALTY, CANCELLED, TRANSFER, MINT, AUCTION_CREATED,
 * AUCTION_BID, AUCTION_FINALIZED, METADATA_UPDATED, PRICE_UPDATED.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { ActivityEvent, getListingHistory } from "@/lib/indexer";
import { config } from "@/lib/config";

const PAGE_SIZE = 20;

export interface UseListingHistoryResult {
  events: ActivityEvent[];
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  refresh: () => void;
  /** True when a chain reorg was detected via SSE — prompt user to refresh. */
  reorgDetected: boolean;
  /** Dismiss the reorg banner without refreshing. */
  dismissReorg: () => void;
}

export function useListingHistory(
  listingId: number | null
): UseListingHistoryResult {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [reorgDetected, setReorgDetected] = useState(false);
  const offsetRef = useRef(0);

  const fetchPage = useCallback(
    async (offset: number, append: boolean) => {
      if (listingId === null) return;
      if (append) setIsLoadingMore(true);
      else setIsLoading(true);
      setError(null);
      try {
        const page = await getListingHistory(listingId, offset, PAGE_SIZE);
        setEvents((prev) => (append ? [...prev, ...page.events] : page.events));
        setHasMore(page.hasMore);
        offsetRef.current = offset + page.events.length;
      } catch (err: unknown) {
        setError(
          err instanceof Error ? err.message : "Failed to load history"
        );
      } finally {
        if (append) setIsLoadingMore(false);
        else setIsLoading(false);
      }
    },
    [listingId]
  );

  const refresh = useCallback(() => {
    offsetRef.current = 0;
    setReorgDetected(false);
    fetchPage(0, false);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (!hasMore || isLoadingMore) return;
    fetchPage(offsetRef.current, true);
  }, [hasMore, isLoadingMore, fetchPage]);

  const dismissReorg = useCallback(() => {
    setReorgDetected(false);
  }, []);

  // Initial fetch
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Subscribe to SSE reorg events (Issue #532)
  // On a reorg notification, remove provisional events for the affected ledger
  // range and set reorgDetected so the UI can prompt for a full refresh.
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const indexerUrl = config.indexerUrl;
    if (!indexerUrl) return;

    const es = new EventSource(`${indexerUrl}/events`);

    const handleReorg = (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data ?? "{}");
        const rollbackLedger: number | undefined =
          typeof payload.rollbackLedger === "number"
            ? payload.rollbackLedger
            : typeof payload.safeLedger === "number"
            ? payload.safeLedger
            : undefined;

        if (rollbackLedger !== undefined) {
          // Remove any provisional events at or beyond the rollback ledger.
          setEvents((prev) =>
            prev.filter((evt) => {
              const seq = (evt as any).ledgerSequence as number | undefined;
              const confirmed = (evt as any).confirmed as boolean | undefined;
              // Keep confirmed events and events before the rollback.
              if (confirmed) return true;
              if (seq === undefined) return true;
              return seq < rollbackLedger;
            })
          );
        }
        setReorgDetected(true);
      } catch {
        // Malformed SSE payload — ignore
      }
    };

    es.addEventListener("reorg", handleReorg);

    return () => {
      es.removeEventListener("reorg", handleReorg);
      es.close();
    };
  }, []);

  return {
    events,
    isLoading,
    isLoadingMore,
    error,
    hasMore,
    loadMore,
    refresh,
    reorgDetected,
    dismissReorg,
  };
}
