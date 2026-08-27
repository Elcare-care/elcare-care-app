// ─────────────────────────────────────────────────────────────────────────────
// lib/serverTime.ts — Server/ledger clock synchronization (Issue #527)
//
// Countdown UIs (auction time-remaining, effective end time) must agree with
// the indexer's view of ledger time, not the viewer's local system clock —
// a client with a fast or slow clock would otherwise show a countdown that
// disagrees with when the contract will actually accept `finalize_auction`.
//
// There is no dedicated "current ledger timestamp" endpoint exposed without
// operator auth, so this module uses the indexer's public `/health` response
// (see indexer/src/index.ts `GET /health` — no auth required) as a wall-clock
// reference: Stellar ledgers close roughly every ~5s, so the indexer's own
// clock is always within a few seconds of true ledger time, which is well
// inside the tolerance countdowns need (seconds, not milliseconds).
//
// The offset is computed with a simple round-trip-latency correction (NTP-like
// halving of the request duration) and cached; callers should treat it as
// "best effort" — when the health check fails, offset falls back to 0 (trust
// the local clock) and `isSynced` is false so the UI can mark the countdown
// as unverified rather than silently wrong.
// ─────────────────────────────────────────────────────────────────────────────

import axios from "axios";
import { config } from "./config";

export interface ServerClockSample {
  /** Milliseconds to add to `Date.now()` to approximate server time. */
  offsetMs: number;
  /** Round-trip latency of the sample request, in ms. */
  latencyMs: number;
  /** Local `Date.now()` value when the sample was taken. */
  sampledAt: number;
}

/** Tolerance (ms) below which a countdown is considered "in sync" with the
 *  indexed end time for display purposes (Issue #527 acceptance criteria). */
export const SERVER_CLOCK_TOLERANCE_MS = 5_000;

const HEALTH_TIMEOUT_MS = 4_000;

/**
 * Fetch one clock-offset sample from the indexer's `/health` endpoint.
 * Returns `null` when the indexer is unreachable or the response is
 * malformed — callers should keep using the last-known-good offset (or 0).
 */
export async function sampleServerClockOffset(): Promise<ServerClockSample | null> {
  if (!config.indexerUrl) return null;
  const requestStart = Date.now();
  try {
    const res = await axios.get(`${config.indexerUrl}/health`, {
      timeout: HEALTH_TIMEOUT_MS,
      // /health returns 503 when a dependency is down but still carries a
      // valid timestamp — accept any response that parses.
      validateStatus: () => true,
    });
    const requestEnd = Date.now();
    const latencyMs = requestEnd - requestStart;

    const serverTimestamp = Number(res.data?.timestamp);
    if (!Number.isFinite(serverTimestamp) || serverTimestamp <= 0) return null;

    // Assume symmetric latency: the server's `timestamp` was captured
    // roughly latencyMs/2 after we sent the request.
    const estimatedServerNowAtReceive = serverTimestamp + latencyMs / 2;
    const offsetMs = estimatedServerNowAtReceive - requestEnd;

    return { offsetMs, latencyMs, sampledAt: requestEnd };
  } catch {
    return null;
  }
}
