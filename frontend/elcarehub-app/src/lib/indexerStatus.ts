// ─────────────────────────────────────────────────────────────
// lib/indexerStatus.ts — Lightweight indexer status client
//
// Issue #522 — Stale indexer data indicators
//
// Talks to the indexer's aggregate `/health` endpoint (see
// indexer/src/health.ts + indexer/src/index.ts) so the frontend can tell
// the difference between:
//   - the indexer being fully caught up ("ok")
//   - the indexer lagging behind the chain tip or a dependency being
//     degraded ("degraded")
//   - the indexer being unreachable or fully down ("down")
//
// This intentionally reuses the same axios + config.indexerUrl pattern as
// the rest of lib/indexer.ts rather than introducing a new HTTP layer.
// `/health` requires no auth (unlike `/health/details`), so this is safe
// to call directly from the browser.
// ─────────────────────────────────────────────────────────────

import axios from "axios";
import { config } from "./config";

const HEALTH_TIMEOUT_MS = 6_000;

/** Mirrors CheckStatus in indexer/src/health.ts. */
export type IndexerCheckStatus = "ok" | "degraded" | "down";

/** Mirrors HealthCheckResult in indexer/src/health.ts, plus optional
 *  per-check extras (e.g. sync_lag's `lagLedgers`) surfaced when present. */
export interface IndexerHealthCheckResult {
  status: IndexerCheckStatus;
  latencyMs: number;
  message?: string;
  /** Ledgers behind the network tip — present on the `sync_lag` check. */
  lagLedgers?: number;
  /** Present on the `confirmation_depth` check. */
  pendingConfirmationCount?: number;
}

/** Mirrors AggregateHealth in indexer/src/health.ts. */
export interface IndexerHealthSnapshot {
  /** Overall status — worst of all individual checks. */
  status: IndexerCheckStatus;
  checks: Record<string, IndexerHealthCheckResult>;
  /** Unix ms timestamp when the indexer took this snapshot. */
  timestamp: number;
  /** Unix ms timestamp when this client received the response. */
  fetchedAt: number;
  version?: { app?: string; gitSha?: string; [key: string]: unknown };
}

function isIndexerCheckStatus(v: unknown): v is IndexerCheckStatus {
  return v === "ok" || v === "degraded" || v === "down";
}

function isHealthCheckResult(v: unknown): v is IndexerHealthCheckResult {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return isIndexerCheckStatus(o.status) && typeof o.latencyMs === "number";
}

function parseHealthSnapshot(data: unknown): IndexerHealthSnapshot | null {
  if (data === null || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (!isIndexerCheckStatus(o.status)) return null;
  if (typeof o.checks !== "object" || o.checks === null) return null;

  const checks: Record<string, IndexerHealthCheckResult> = {};
  for (const [key, val] of Object.entries(o.checks as Record<string, unknown>)) {
    if (isHealthCheckResult(val)) checks[key] = val;
  }

  return {
    status: o.status,
    checks,
    timestamp: typeof o.timestamp === "number" ? o.timestamp : Date.now(),
    fetchedAt: Date.now(),
    version:
      typeof o.version === "object" && o.version !== null
        ? (o.version as IndexerHealthSnapshot["version"])
        : undefined,
  };
}

/**
 * Fetches the indexer's aggregate health snapshot.
 *
 * Returns `null` when the indexer is unreachable (network error, timeout,
 * or an unparseable response) rather than throwing — callers should treat
 * a `null` result as "unavailable".
 *
 * Note: `/health` responds with HTTP 503 when the aggregate status is
 * "down", but the body still carries a valid, parseable snapshot — so this
 * accepts any status code and only fails on transport-level errors.
 */
export async function fetchIndexerHealth(): Promise<IndexerHealthSnapshot | null> {
  try {
    const res = await axios.get(`${config.indexerUrl}/health`, {
      timeout: HEALTH_TIMEOUT_MS,
      validateStatus: () => true,
    });
    return parseHealthSnapshot(res.data);
  } catch (e) {
    console.warn(
      "[indexerStatus] fetchIndexerHealth:",
      e instanceof Error ? e.message : e
    );
    return null;
  }
}

/** Convenience accessor for the sync-lag ledger count, when reported. */
export function getSyncLagLedgers(
  snapshot: IndexerHealthSnapshot | null
): number | null {
  const lag = snapshot?.checks?.sync_lag?.lagLedgers;
  return typeof lag === "number" && lag >= 0 ? lag : null;
}
