"use client";

// ─────────────────────────────────────────────────────────────
// components/StaleBanner.tsx
//
// Issue #309 / #44 — Non-blocking stale-data indicator
//
// Shows a dismissible amber banner when the local data snapshot
// is older than the per-resource stale threshold.
//
// Also shows an SSE disconnected warning when the live update
// stream is unavailable — so users know the page is not live.
// ─────────────────────────────────────────────────────────────

import React, { useState, useEffect, useRef, useCallback } from "react";
import { RefreshCw, WifiOff, Clock, X } from "lucide-react";
import {
  FreshnessMetadata,
  isDataStale,
  STALE_THRESHOLDS_MS,
  makeFreshness,
} from "@/lib/indexer";
import { config } from "@/lib/config";

// ── StaleBanner ───────────────────────────────────────────────

interface StaleBannerProps {
  freshness: FreshnessMetadata | null;
  resourceType?: keyof typeof STALE_THRESHOLDS_MS;
  onRefresh: () => void;
  isRefreshing?: boolean;
}

export function StaleBanner({
  freshness,
  resourceType = "default",
  onRefresh,
  isRefreshing = false,
}: StaleBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  // Reset dismissal whenever new fresh data arrives
  useEffect(() => {
    setDismissed(false);
  }, [freshness?.fetchedAt]);

  const stale = freshness ? isDataStale(freshness, resourceType) : false;
  const sseDown = freshness ? !freshness.sseConnected : false;

  if (dismissed) return null;
  if (!stale && !sseDown) return null;

  const ageSeconds = freshness
    ? Math.round((Date.now() - freshness.fetchedAt) / 1000)
    : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
    >
      {sseDown ? (
        <WifiOff size={16} className="shrink-0" aria-hidden="true" />
      ) : (
        <Clock size={16} className="shrink-0" aria-hidden="true" />
      )}

      <span className="flex-1">
        {sseDown && !stale
          ? "Live updates are disconnected. Data may be outdated."
          : ageSeconds !== null
          ? `Data is ${ageSeconds}s old. Refresh before taking action.`
          : "Data may be outdated. Refresh before taking action."}
      </span>

      <button
        type="button"
        onClick={onRefresh}
        disabled={isRefreshing}
        className="flex items-center gap-1.5 rounded-lg bg-amber-100 px-3 py-1.5 font-semibold hover:bg-amber-200 transition disabled:opacity-50 shrink-0"
        aria-label="Refresh data"
      >
        <RefreshCw size={14} className={isRefreshing ? "animate-spin" : ""} aria-hidden="true" />
        Refresh
      </button>

      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="rounded-full p-1 hover:bg-amber-100 transition shrink-0"
        aria-label="Dismiss stale warning"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

// ── SSEDisconnectBanner ───────────────────────────────────────

interface SSEDisconnectBannerProps {
  sseConnected: boolean;
  onManualRefresh: () => void;
}

/**
 * Minimal non-intrusive SSE disconnect indicator.
 * Appears as a fixed bottom-right chip when the stream is disconnected.
 */
export function SSEDisconnectBanner({ sseConnected, onManualRefresh }: SSEDisconnectBannerProps) {
  if (sseConnected) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full bg-midnight-900 border border-white/10 px-4 py-2 text-xs text-white/70 shadow-xl"
    >
      <WifiOff size={12} aria-hidden="true" className="text-amber-400" />
      <span>Live updates paused</span>
      <button
        type="button"
        onClick={onManualRefresh}
        className="text-brand-400 hover:text-brand-300 font-semibold transition"
        aria-label="Reconnect live updates"
      >
        Reconnect
      </button>
    </div>
  );
}

// ── useSSEFreshness hook ────────────────────────────────────────

/**
 * Manages the SSE connection and returns a FreshnessMetadata snapshot
 * that is updated on every server-sent event.
 *
 * @param onUpdate - Callback invoked when the server emits an event.
 *                   Use this to trigger a data refresh.
 */
export function useSSEFreshness(onUpdate: () => void): {
  freshness: FreshnessMetadata;
  sseConnected: boolean;
} {
  const [sseConnected, setSseConnected] = useState(false);
  const [freshness, setFreshness] = useState<FreshnessMetadata>(() =>
    makeFreshness({ sseConnected: false })
  );
  const esRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    if (typeof window === "undefined" || !config.indexerUrl) return;

    esRef.current?.close();

    const es = new EventSource(`${config.indexerUrl}/events/stream`);
    esRef.current = es;

    es.onopen = () => {
      setSseConnected(true);
      setFreshness((prev) => ({ ...prev, sseConnected: true }));
    };

    es.onmessage = (evt: MessageEvent) => {
      let indexerUpdatedAt: number | null = null;
      try {
        const parsed = JSON.parse(evt.data as string) as { ledger?: number; timestamp?: number };
        if (parsed.timestamp) indexerUpdatedAt = parsed.timestamp;
      } catch {
        // non-JSON heartbeat — ignore
      }
      setFreshness(
        makeFreshness({ sseConnected: true, indexerUpdatedAt: indexerUpdatedAt ?? Date.now() })
      );
      onUpdate();
    };

    es.onerror = () => {
      setSseConnected(false);
      setFreshness((prev) => ({ ...prev, sseConnected: false }));
      es.close();
      esRef.current = null;
    };
  }, [onUpdate]);

  useEffect(() => {
    connect();
    return () => {
      esRef.current?.close();
    };
  }, [connect]);

  return { freshness, sseConnected };
}
