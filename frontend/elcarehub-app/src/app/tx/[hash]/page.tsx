// ─────────────────────────────────────────────────────────────────────────────
// app/tx/[hash]/page.tsx — Transaction status and recovery page (Issue #301)
//
// Accepts a Stellar transaction hash in the URL, reads authoritative chain
// status from the indexer API, and presents a clear timeline with:
//   - Chain confirmation status (distinct from indexer ingestion status)
//   - Stale-indexer messaging when the chain confirms but indexer hasn't yet
//   - Explorer link built from the configured network
//   - Links to affected resources (listing, auction, offer)
//   - Safe retry / refresh actions
//   - Mobile-friendly layout preserving all critical recovery actions
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { config } from "@/lib/config";

// ── Types ─────────────────────────────────────────────────────────────────────

type ChainStatus = "success" | "failed" | "pending" | "unknown";
type IndexerStatus = "confirmed" | "pending" | "not_found";

interface TxEvent {
  id: number;
  eventType: string;
  listingId?: string | null;
  actor: string;
  ledgerSequence: number;
  ledgerTimestamp?: string | null;
  contractId?: string | null;
}

interface TxStatusResponse {
  hash: string;
  chain_status: ChainStatus;
  indexer_status: IndexerStatus;
  stale_indexer: boolean;
  explorer_url: string;
  events: TxEvent[];
  related_resources: {
    listing_id?: string | null;
    auction_id?: string | null;
    offer_id?: string | null;
  };
  network: string;
}

// ── Polling backoff helper ────────────────────────────────────────────────────

const POLL_INTERVALS_MS = [3_000, 5_000, 10_000, 15_000, 30_000];

function nextInterval(attempt: number): number {
  return POLL_INTERVALS_MS[Math.min(attempt, POLL_INTERVALS_MS.length - 1)];
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    success:   "bg-green-100 text-green-800 border border-green-300",
    confirmed: "bg-green-100 text-green-800 border border-green-300",
    failed:    "bg-red-100 text-red-800 border border-red-300",
    pending:   "bg-yellow-100 text-yellow-800 border border-yellow-300",
    unknown:   "bg-gray-100 text-gray-700 border border-gray-300",
    not_found: "bg-gray-100 text-gray-700 border border-gray-300",
  };
  const cls = styles[status] ?? styles.unknown;
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {status.replace("_", " ")}
    </span>
  );
}

// ── Timeline step ─────────────────────────────────────────────────────────────

function TimelineStep({
  label,
  done,
  active,
  failed,
}: {
  label: string;
  done: boolean;
  active: boolean;
  failed?: boolean;
}) {
  const icon = failed
    ? "✗"
    : done
    ? "✓"
    : active
    ? "⟳"
    : "○";
  const iconCls = failed
    ? "text-red-500"
    : done
    ? "text-green-500"
    : active
    ? "text-yellow-500 animate-spin"
    : "text-gray-300";

  return (
    <div className="flex items-start gap-3">
      <span className={`text-xl font-bold w-6 text-center ${iconCls}`}>{icon}</span>
      <span className={`text-sm mt-0.5 ${done || active ? "text-gray-900" : "text-gray-400"}`}>
        {label}
      </span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface PageProps {
  params: { hash: string };
}

export default function TxStatusPage({ params }: PageProps) {
  const { hash } = params;

  const [data, setData] = useState<TxStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pollAttempt, setPollAttempt] = useState(0);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  // Validate hash format client-side to give instant feedback
  const isValidHash = /^[0-9a-fA-F]{64}$/.test(hash ?? "");

  const fetchStatus = useCallback(async () => {
    if (!isValidHash) {
      setError("Invalid transaction hash — must be 64 hex characters.");
      setLoading(false);
      return;
    }

    setError(null);
    try {
      const url = `${config.indexerUrl}/transactions/${hash}`;
      const res = await fetch(url);
      if (res.status === 400) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error?.message ?? "Invalid transaction hash.");
        setLoading(false);
        return;
      }
      if (res.status === 404) {
        setError("Transaction not found on this network.");
        setLoading(false);
        return;
      }
      if (!res.ok) {
        throw new Error(`Server error ${res.status}`);
      }
      const json: TxStatusResponse = await res.json();
      setData(json);
      setLastRefreshed(new Date());
    } catch (e: unknown) {
      setError(
        e instanceof Error ? e.message : "Failed to load transaction status."
      );
    } finally {
      setLoading(false);
    }
  }, [hash, isValidHash]);

  // Initial fetch
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Auto-poll while the tx is still pending / stale
  useEffect(() => {
    if (!data) return;
    if (data.chain_status === "success" && !data.stale_indexer) return;
    if (data.chain_status === "failed") return;

    const delay = nextInterval(pollAttempt);
    const timer = setTimeout(() => {
      setPollAttempt((a) => a + 1);
      fetchStatus();
    }, delay);
    return () => clearTimeout(timer);
  }, [data, pollAttempt, fetchStatus]);

  // ── Render states ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="text-center">
          <div className="text-4xl mb-4 animate-spin inline-block">⟳</div>
          <p className="text-gray-600">Looking up transaction…</p>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow p-6 max-w-lg w-full">
          <h1 className="text-xl font-semibold text-red-700 mb-2">
            Transaction Not Found
          </h1>
          <p className="text-gray-700 text-sm mb-4">{error}</p>
          <p className="text-xs text-gray-500 mb-6">
            Hash: <code className="break-all font-mono">{hash}</code>
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/"
              className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-lg text-sm"
            >
              ← Back to marketplace
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (!data) return null;

  const isSuccess    = data.chain_status === "success";
  const isFailed     = data.chain_status === "failed";
  const isPending    = data.chain_status === "pending";
  const isUnknown    = data.chain_status === "unknown";
  const indexerDone  = data.indexer_status === "confirmed";

  return (
    <main className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-2xl mx-auto space-y-6">

        {/* Header */}
        <div>
          <Link href="/" className="text-sm text-blue-600 hover:underline">
            ← Back to marketplace
          </Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-2">
            Transaction Status
          </h1>
          <p className="text-xs text-gray-500 font-mono break-all mt-1">
            {data.hash}
          </p>
        </div>

        {/* Status summary card */}
        <div className="bg-white rounded-xl shadow p-5 space-y-4">
          <div className="flex flex-wrap gap-4">
            <div>
              <p className="text-xs text-gray-500 mb-1">Chain status</p>
              <StatusBadge status={data.chain_status} />
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Indexer status</p>
              <StatusBadge status={data.indexer_status} />
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Network</p>
              <span className="text-sm font-medium text-gray-700 capitalize">
                {data.network}
              </span>
            </div>
          </div>

          {/* Stale-indexer warning */}
          {data.stale_indexer && (
            <div
              role="alert"
              className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-900"
            >
              <strong>Indexer is still catching up.</strong> Your transaction was
              confirmed on-chain but hasn&apos;t been picked up by the indexer yet.
              The marketplace will update automatically — no action needed. You can
              refresh below to check for progress.
            </div>
          )}

          {/* Failed warning */}
          {isFailed && (
            <div
              role="alert"
              className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-900"
            >
              <strong>Transaction failed on-chain.</strong> No funds or NFTs were
              transferred. It is safe to retry this action.
            </div>
          )}

          {/* Unknown — do NOT tell user to retry potentially successful payment */}
          {isUnknown && (
            <div
              role="alert"
              className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm text-gray-800"
            >
              <strong>Status unknown.</strong> This hash was not found on the
              current network. If you recently submitted this transaction, it may
              still be propagating. Wait a few seconds and refresh.{" "}
              <em>
                Do not re-submit a payment until you have confirmed the original
                transaction failed — submitting twice could result in a double
                payment.
              </em>
            </div>
          )}
        </div>

        {/* Lifecycle timeline */}
        <div className="bg-white rounded-xl shadow p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">
            Lifecycle Timeline
          </h2>
          <div className="space-y-3">
            <TimelineStep
              label="Transaction submitted to network"
              done={isSuccess || isFailed}
              active={isPending}
              failed={isFailed}
            />
            <TimelineStep
              label="Confirmed in a finalized ledger"
              done={isSuccess}
              active={isPending && !isUnknown}
              failed={isFailed}
            />
            <TimelineStep
              label="Indexed by marketplace"
              done={indexerDone}
              active={isSuccess && data.stale_indexer}
              failed={false}
            />
          </div>
        </div>

        {/* Related resources */}
        {(data.related_resources.listing_id ||
          data.related_resources.auction_id ||
          data.related_resources.offer_id) && (
          <div className="bg-white rounded-xl shadow p-5">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">
              Affected Resources
            </h2>
            <div className="flex flex-wrap gap-3 text-sm">
              {data.related_resources.listing_id && (
                <Link
                  href={`/listings/${data.related_resources.listing_id}`}
                  className="text-blue-600 hover:underline"
                >
                  View listing #{data.related_resources.listing_id}
                </Link>
              )}
              {data.related_resources.auction_id && (
                <Link
                  href={`/auctions/${data.related_resources.auction_id}`}
                  className="text-blue-600 hover:underline"
                >
                  View auction #{data.related_resources.auction_id}
                </Link>
              )}
              {data.related_resources.offer_id && (
                <Link
                  href={`/offers/${data.related_resources.offer_id}`}
                  className="text-blue-600 hover:underline"
                >
                  View offer #{data.related_resources.offer_id}
                </Link>
              )}
            </div>
          </div>
        )}

        {/* Events list */}
        {data.events.length > 0 && (
          <div className="bg-white rounded-xl shadow p-5">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">
              Indexed Events ({data.events.length})
            </h2>
            <ul className="divide-y divide-gray-100 text-sm">
              {data.events.map((ev) => (
                <li key={ev.id} className="py-2">
                  <span className="font-medium text-gray-800">{ev.eventType}</span>
                  {ev.ledgerSequence > 0 && (
                    <span className="ml-2 text-xs text-gray-500">
                      ledger {ev.ledgerSequence}
                    </span>
                  )}
                  {ev.ledgerTimestamp && (
                    <span className="ml-2 text-xs text-gray-400">
                      {new Date(ev.ledgerTimestamp).toLocaleString()}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Actions */}
        <div className="bg-white rounded-xl shadow p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Actions</h2>
          <div className="flex flex-wrap gap-3">
            {/* Explorer link — network-aware, never hard-coded */}
            <a
              href={data.explorer_url}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium"
            >
              View on Stellar Expert ↗
            </a>

            {/* Refresh — always safe */}
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                fetchStatus();
              }}
              className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-lg text-sm"
            >
              Refresh status
            </button>

            <Link
              href="/"
              className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-lg text-sm"
            >
              Back to marketplace
            </Link>
          </div>

          {lastRefreshed && (
            <p className="text-xs text-gray-400 mt-3">
              Last checked: {lastRefreshed.toLocaleTimeString()}
              {(isPending || data.stale_indexer) && " · auto-refreshing…"}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
