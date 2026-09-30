// ─────────────────────────────────────────────────────────────
// hooks/useIndexerFreshness.ts — Shared indexer freshness hook
//
// Issue #522 — Stale indexer data indicators
//
// Consumers reading from the indexer (listing detail, auction countdown,
// wallet activity, admin views) use this hook to classify how trustworthy
// the data currently on screen is, and to surface a non-blocking status
// the UI can render via <StaleBanner />.
//
// Classification (in priority order):
//   1. "critical_reorg" — the indexer reported a CRITICAL_REORG event that
//      hasn't expired yet. Recently "confirmed" chain state may be reverted.
//      Nothing should be presented as final while this is active.
//   2. "unavailable"    — the indexer's /health endpoint is unreachable or
//      reports "down" (DB/RPC dependency failing).
//   3. "lagging"        — the indexer is reachable but degraded, the local
//      snapshot has crossed its per-resource stale threshold
//      (see STALE_THRESHOLDS_MS), the live event stream is disconnected,
//      or a (non-critical) reorg was recently observed.
//   4. "healthy"        — none of the above.
//
// This hook manages its own lightweight SSE subscription (reusing
// subscribeToMarketplaceEvents from lib/indexer.ts) purely to track live
// connectivity and catch REORG/CRITICAL_REORG events — callers that already
// subscribe to the marketplace SSE stream for their own purposes (e.g. the
// auction detail page) are unaffected and can keep their existing
// subscription for data updates.
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  FreshnessMetadata,
  STALE_THRESHOLDS_MS,
  isDataStale,
  makeFreshness,
  subscribeToMarketplaceEvents,
  type MarketplaceSSEEvent,
} from "@/lib/indexer";
import { fetchIndexerHealth, type IndexerHealthSnapshot } from "@/lib/indexerStatus";
import { config } from "@/lib/config";

// ── Types ─────────────────────────────────────────────────────

export type IndexerFreshnessStatus =
  | "healthy"
  | "lagging"
  | "unavailable"
  | "critical_reorg";

export interface ReorgNotice {
  /** Number of ledgers rolled back. */
  depth: number;
  fromLedger?: number;
  toLedger?: number;
  message?: string;
  /** When this client observed the notice. */
  detectedAt: number;
  critical: boolean;
}

// Reorg notices auto-expire so a one-off event doesn't haunt the UI forever.
// Critical notices live longer since the consequences (mis-stated finality)
// are worse than a lingering warning.
const REORG_NOTICE_TTL_MS = 5 * 60_000;
const DEFAULT_HEALTH_POLL_MS = 20_000;
// Grace period before a disconnected SSE stream counts toward "lagging" —
// avoids flashing a stale banner on every page load while the connection
// is still being established.
const SSE_DISCONNECT_GRACE_MS = 5_000;

export interface UseIndexerFreshnessOptions {
  /** Which per-resource stale threshold to apply. Defaults to "default". */
  resourceType?: keyof typeof STALE_THRESHOLDS_MS;
  /** How often to poll GET /health. Pass 0 to disable polling entirely. */
  healthPollIntervalMs?: number;
  /** Whether this hook should open its own SSE connection to track live
   *  connectivity + reorg events. Defaults to true. Set to false when the
   *  caller already manages an SSE subscription and will report events via
   *  `reportSSEEvent`/`reportSSEConnected` instead (avoids duplicate
   *  connections to the same stream). */
  subscribeToEvents?: boolean;
  /** Invoked when the user requests a refresh — use it to re-fetch the
   *  resource-specific data the caller owns (listing, auction, activity…). */
  onRefresh?: () => void | Promise<void>;
}

export interface UseIndexerFreshnessResult {
  status: IndexerFreshnessStatus;
  freshness: FreshnessMetadata;
  isStale: boolean;
  sseConnected: boolean;
  health: IndexerHealthSnapshot | null;
  /** Set when the health check itself failed (network/timeout), distinct
   *  from the indexer reporting a "down" status in a valid response. */
  healthCheckFailed: boolean;
  reorg: ReorgNotice | null;
  isRefreshing: boolean;
  /** Re-checks indexer health and (if provided) re-runs the caller's own
   *  data refresh. Also resets the freshness snapshot's `fetchedAt`. */
  refresh: () => Promise<void>;
  /** Call after the caller fetches fresh resource data through its own
   *  path (e.g. after loadData() resolves) so `isStale` reflects reality
   *  rather than only the last health poll. */
  markUpdated: (
    extra?: Partial<Pick<FreshnessMetadata, "lastIndexedLedger" | "indexerUpdatedAt">>
  ) => void;
  /** For callers with `subscribeToEvents: false` that manage their own SSE
   *  subscription — feed events through so reorgs are still detected. */
  reportSSEEvent: (event: MarketplaceSSEEvent) => void;
  /** For callers with `subscribeToEvents: false` — report connect state. */
  reportSSEConnected: (connected: boolean) => void;
}

// ── Hook ──────────────────────────────────────────────────────

export function useIndexerFreshness(
  opts: UseIndexerFreshnessOptions = {}
): UseIndexerFreshnessResult {
  const {
    resourceType = "default",
    healthPollIntervalMs = DEFAULT_HEALTH_POLL_MS,
    subscribeToEvents = true,
    onRefresh,
  } = opts;

  const [freshness, setFreshness] = useState<FreshnessMetadata>(() => makeFreshness());
  const [sseConnected, setSseConnected] = useState(false);
  const [health, setHealth] = useState<IndexerHealthSnapshot | null>(null);
  const [healthCheckFailed, setHealthCheckFailed] = useState(false);
  const [reorg, setReorg] = useState<ReorgNotice | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // See SSE_DISCONNECT_GRACE_MS — avoids an initial-mount flash.
  const [sseGracePassed, setSseGracePassed] = useState(false);

  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    const t = setTimeout(() => setSseGracePassed(true), SSE_DISCONNECT_GRACE_MS);
    return () => clearTimeout(t);
  }, []);

  // ── Health polling ─────────────────────────────────────────

  const pollHealth = useCallback(async () => {
    const snapshot = await fetchIndexerHealth();
    if (snapshot) {
      setHealth(snapshot);
      setHealthCheckFailed(false);
    } else {
      setHealth(null);
      setHealthCheckFailed(true);
    }
  }, []);

  useEffect(() => {
    pollHealth();
    if (healthPollIntervalMs <= 0) return;
    const id = setInterval(pollHealth, healthPollIntervalMs);
    return () => clearInterval(id);
  }, [pollHealth, healthPollIntervalMs]);

  // ── Reorg notice handling ─────────────────────────────────

  const handleSSEEvent = useCallback((event: MarketplaceSSEEvent) => {
    if (event.type === "REORG" || event.type === "CRITICAL_REORG") {
      setReorg({
        depth: event.depth ?? 0,
        fromLedger: event.from_ledger,
        toLedger: event.to_ledger,
        message: event.message,
        detectedAt: Date.now(),
        critical: event.type === "CRITICAL_REORG",
      });
    }
    // Any event on the stream means the indexer is actively pushing data —
    // treat this as a fresh signal for this resource type's data.
    setFreshness((prev) =>
      makeFreshness({
        lastIndexedLedger: prev.lastIndexedLedger,
        sseConnected: true,
        indexerUpdatedAt: Date.now(),
      })
    );
  }, []);

  // Expire stale reorg notices.
  useEffect(() => {
    if (!reorg) return;
    const remaining = REORG_NOTICE_TTL_MS - (Date.now() - reorg.detectedAt);
    if (remaining <= 0) {
      setReorg(null);
      return;
    }
    const t = setTimeout(() => setReorg(null), remaining);
    return () => clearTimeout(t);
  }, [reorg]);

  // ── Optional self-managed SSE subscription ────────────────

  useEffect(() => {
    if (!subscribeToEvents) return;
    if (typeof window === "undefined" || !config.indexerUrl) return;

    const sub = subscribeToMarketplaceEvents(config.indexerUrl, {
      debounceMs: 0,
      onOpen: () => setSseConnected(true),
      onClose: () => setSseConnected(false),
      onEvent: handleSSEEvent,
    });

    return () => sub.close();
  }, [subscribeToEvents, handleSSEEvent]);

  // ── External SSE reporting (for callers managing their own stream) ────

  const reportSSEEvent = useCallback(
    (event: MarketplaceSSEEvent) => {
      if (subscribeToEvents) return; // avoid double-processing
      handleSSEEvent(event);
    },
    [subscribeToEvents, handleSSEEvent]
  );

  const reportSSEConnected = useCallback(
    (connected: boolean) => {
      if (subscribeToEvents) return;
      setSseConnected(connected);
    },
    [subscribeToEvents]
  );

  // ── Actions ────────────────────────────────────────────────

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([pollHealth(), onRefreshRef.current?.()]);
      setFreshness((prev) =>
        makeFreshness({ lastIndexedLedger: prev.lastIndexedLedger, sseConnected })
      );
      // A manual refresh clears a non-critical reorg notice (the user has
      // seen up-to-date data); a critical one persists until it expires or
      // the indexer confirms recovery, since silently clearing it would risk
      // presenting recently-reverted state as final again.
      setReorg((prev) => (prev && !prev.critical ? null : prev));
    } finally {
      setIsRefreshing(false);
    }
  }, [pollHealth, sseConnected]);

  const markUpdated = useCallback(
    (
      extra?: Partial<Pick<FreshnessMetadata, "lastIndexedLedger" | "indexerUpdatedAt">>
    ) => {
      setFreshness(makeFreshness({ ...extra, sseConnected }));
    },
    [sseConnected]
  );

  // ── Derived status ─────────────────────────────────────────

  const isStale = isDataStale(freshness, resourceType);

  let status: IndexerFreshnessStatus;
  if (reorg?.critical) {
    status = "critical_reorg";
  } else if (healthCheckFailed || health?.status === "down") {
    status = "unavailable";
  } else if (
    health?.status === "degraded" ||
    isStale ||
    (!sseConnected && sseGracePassed) ||
    reorg
  ) {
    status = "lagging";
  } else {
    status = "healthy";
  }

  return {
    status,
    freshness,
    isStale,
    sseConnected,
    health,
    healthCheckFailed,
    reorg,
    isRefreshing,
    refresh,
    markUpdated,
    reportSSEEvent,
    reportSSEConnected,
  };
}
