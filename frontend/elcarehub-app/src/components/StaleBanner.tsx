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
import Link from "next/link";
import { RefreshCw, WifiOff, Clock, X, ServerCrash, AlertTriangle } from "lucide-react";
import {
  FreshnessMetadata,
  isDataStale,
  STALE_THRESHOLDS_MS,
  makeFreshness,
} from "@/lib/indexer";
import type { IndexerFreshnessStatus, ReorgNotice } from "@/hooks/useIndexerFreshness";
import { config } from "@/lib/config";

// ── StaleBanner ───────────────────────────────────────────────
//
// Non-blocking status indicator for indexer-backed views.
//
// Two ways to drive it:
//   1. Pass `status` (+ optionally `reorg`) from useIndexerFreshness — the
//      hook's classification (healthy/lagging/unavailable/critical_reorg)
//      decides what renders. This is the preferred path for new call sites.
//   2. Omit `status` and pass only `freshness`/`resourceType` — legacy
//      two-state behaviour (stale / SSE-disconnected) is preserved for any
//      existing caller that predates the status-aware hook.
//
// In every state, the banner communicates via text + role="status"/"alert"
// and an icon — never color alone — and never blocks interaction with the
// rest of the page.

interface StaleBannerProps {
  freshness: FreshnessMetadata | null;
  resourceType?: keyof typeof STALE_THRESHOLDS_MS;
  onRefresh: () => void;
  isRefreshing?: boolean;
  /** Classification from useIndexerFreshness. When provided, this drives
   *  which variant renders instead of the legacy stale/SSE-down check. */
  status?: IndexerFreshnessStatus;
  /** Reorg details, used to enrich the "critical_reorg" message. */
  reorg?: ReorgNotice | null;
  /** Path to a transaction-status page (e.g. `/tx/<hash>`) for direct
   *  on-chain verification. Shown as a link on transaction-critical
   *  screens so users aren't stuck trusting only the indexer. */
  verifyHref?: string;
}

const STATUS_COPY: Record<
  Exclude<IndexerFreshnessStatus, "healthy">,
  { label: string; defaultMessage: string }
> = {
  lagging: {
    label: "Data may be out of date",
    defaultMessage: "The indexer is behind. Refresh before taking action.",
  },
  unavailable: {
    label: "Indexer unavailable",
    defaultMessage:
      "The indexer is unreachable right now. What you see here may be significantly out of date — verify on-chain before relying on it.",
  },
  critical_reorg: {
    label: "Chain reorganization detected",
    defaultMessage:
      "A chain reorganization was detected. Recent confirmations may be reverted — do not treat recent activity as final until this clears.",
  },
};

export function StaleBanner({
  freshness,
  resourceType = "default",
  onRefresh,
  isRefreshing = false,
  status,
  reorg = null,
  verifyHref,
}: StaleBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  // Reset dismissal whenever new fresh data arrives
  useEffect(() => {
    setDismissed(false);
  }, [freshness?.fetchedAt, status]);

  // ── Status-driven variant (preferred) ────────────────────────
  if (status !== undefined) {
    // Critical reorg is never dismissible — it's the one state where
    // silently hiding the warning could let a user treat reverted state
    // as final.
    if (status !== "critical_reorg" && dismissed) return null;
    if (status === "healthy") return null;

    const copy = STATUS_COPY[status];
    const isUrgent = status === "critical_reorg" || status === "unavailable";
    const ageSeconds = freshness
      ? Math.round((Date.now() - freshness.fetchedAt) / 1000)
      : null;

    const message =
      status === "critical_reorg" && reorg
        ? `A chain reorganization (depth ${reorg.depth}) was detected${
            reorg.message ? `: ${reorg.message}` : ""
          }. Recent confirmations may be reverted — do not treat recent activity as final until this clears.`
        : status === "lagging" && ageSeconds !== null
        ? `${copy.defaultMessage} Data is ${ageSeconds}s old.`
        : copy.defaultMessage;

    const Icon =
      status === "critical_reorg"
        ? AlertTriangle
        : status === "unavailable"
        ? ServerCrash
        : status === "lagging" && freshness && !freshness.sseConnected
        ? WifiOff
        : Clock;

    const palette = isUrgent
      ? "border-red-300 bg-red-50 text-red-800"
      : "border-amber-200 bg-amber-50 text-amber-800";
    const buttonPalette = isUrgent
      ? "bg-red-100 hover:bg-red-200"
      : "bg-amber-100 hover:bg-amber-200";

    return (
      <div
        role={isUrgent ? "alert" : "status"}
        aria-live={isUrgent ? "assertive" : "polite"}
        className={`flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 text-sm ${palette}`}
      >
        <Icon size={16} className="shrink-0" aria-hidden="true" />

        <span className="flex-1 min-w-[12rem]">
          <span className="font-semibold">{copy.label}.</span> {message}
        </span>

        <button
          type="button"
          onClick={onRefresh}
          disabled={isRefreshing}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-semibold transition disabled:opacity-50 shrink-0 ${buttonPalette}`}
          aria-label="Retry indexer refresh"
        >
          <RefreshCw size={14} className={isRefreshing ? "animate-spin" : ""} aria-hidden="true" />
          {isRefreshing ? "Checking…" : "Retry"}
        </button>

        {verifyHref && (
          <Link
            href={verifyHref}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-semibold transition shrink-0 underline decoration-dotted underline-offset-2 hover:no-underline`}
          >
            Verify on-chain
          </Link>
        )}

        {!isUrgent && (
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="rounded-full p-1 hover:bg-amber-100 transition shrink-0"
            aria-label="Dismiss stale warning"
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  }

  // ── Legacy freshness-driven variant ──────────────────────────

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
