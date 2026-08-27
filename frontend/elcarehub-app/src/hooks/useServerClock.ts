// ─────────────────────────────────────────────────────────────
// hooks/useServerClock.ts — Drift-corrected clock for countdowns (Issue #527)
//
// Periodically resyncs against the indexer's /health timestamp and exposes
// a stable `offsetMs` (server time minus local time) plus a `getServerNow()`
// helper. Consumers add `offsetMs` to `Date.now()` instead of trusting the
// viewer's own clock — see lib/serverTime.ts for the sampling strategy and
// SERVER_CLOCK_TOLERANCE_MS for the documented tolerance.
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { sampleServerClockOffset, SERVER_CLOCK_TOLERANCE_MS } from "@/lib/serverTime";

const DEFAULT_RESYNC_INTERVAL_MS = 60_000;
/** Give up resyncing this often on failure before marking the clock stale. */
const STALE_AFTER_MS = 3 * DEFAULT_RESYNC_INTERVAL_MS;

export interface UseServerClockResult {
  /** Milliseconds to add to Date.now() to approximate server/ledger time. */
  offsetMs: number;
  /** True once at least one successful sample has been taken and it is
   *  recent enough (within STALE_AFTER_MS) to be trusted. */
  isSynced: boolean;
  /** Local Date.now() timestamp of the last successful sync, or null. */
  lastSyncedAt: number | null;
  /** Returns the current best estimate of server time, in ms since epoch. */
  getServerNow: () => number;
  /** Force an immediate resync. */
  resync: () => void;
}

export function useServerClock(
  resyncIntervalMs: number = DEFAULT_RESYNC_INTERVAL_MS
): UseServerClockResult {
  const [offsetMs, setOffsetMs] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const offsetRef = useRef(0);

  const sync = useCallback(async () => {
    const sample = await sampleServerClockOffset();
    if (!sample) return;
    offsetRef.current = sample.offsetMs;
    setOffsetMs(sample.offsetMs);
    setLastSyncedAt(sample.sampledAt);
  }, []);

  useEffect(() => {
    sync();
    const id = setInterval(sync, resyncIntervalMs);
    return () => clearInterval(id);
  }, [sync, resyncIntervalMs]);

  const getServerNow = useCallback(() => Date.now() + offsetRef.current, []);

  const isSynced =
    lastSyncedAt !== null && Date.now() - lastSyncedAt < STALE_AFTER_MS;

  return { offsetMs, isSynced, lastSyncedAt, getServerNow, resync: sync };
}

export { SERVER_CLOCK_TOLERANCE_MS };
