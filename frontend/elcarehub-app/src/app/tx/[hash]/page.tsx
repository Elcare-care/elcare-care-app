// ─────────────────────────────────────────────────────────────────────────────
// app/tx/[hash]/page.tsx — Transaction status and recovery page (Issue #301)
//
// Accepts a Stellar transaction hash in the URL and presents a clear recovery
// timeline. Relies on lib/txLookup.ts for all data-fetching so this file stays
// purely presentational.
//
// States handled:
//   success       — confirmed on-chain; may show stale-indexer warning
//   failed        — included but reverted; safe to retry
//   pending       — not yet included; auto-polls
//   not_found     — no record on RPC or indexer; may still be propagating
//   wrong_network — hash belongs to a different network
//   rpc_error     — the RPC is temporarily unreachable
//
// Security:
//   - Never asks for secret keys or XDR
//   - Does not expose raw error XDR to non-technical users
//   - "Do not re-submit" warning guards against double-payment
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import {
  lookupTx,
  isValidTxHash,
  isTxLookupTerminal,
  nextTxPageInterval,
  type TxLookupResult,
  type TxChainStatus,
  type TxIndexerStatus,
} from "@/lib/txLookup";

// ── Status badge ──────────────────────────────────────────────────────────────

const BADGE_STYLES: Record<string, string> = {
  success:       "bg-green-100 text-green-800 border border-green-300",
  confirmed:     "bg-green-100 text-green-800 border border-green-300",
  failed:        "bg-red-100 text-red-800 border border-red-300",
  pending:       "bg-yellow-100 text-yellow-800 border border-yellow-300",
  not_found:     "bg-gray-100 text-gray-700 border border-gray-300",
  wrong_network: "bg-orange-100 text-orange-800 border border-orange-300",
  rpc_error:     "bg-gray-100 text-gray-700 border border-gray-300",
  unknown:       "bg-gray-100 text-gray-700 border border-gray-300",
};

function StatusBadge({ status }: { status: string }) {
  const cls = BADGE_STYLES[status] ?? BADGE_STYLES.unknown;
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${cls}`}
    >
      {status.replace(/_/g, " ")}
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
  const icon = failed ? "✗" : done ? "✓" : active ? "⟳" : "○";
  const iconCls = failed
    ? "text-red-500"
    : done
    ? "text-green-500"
    : active
    ? "text-yellow-500 animate-spin"
    : "text-gray-300";

  return (
    <div className="flex items-start gap-3">
      <span className={`text-xl font-bold w-6 text-center ${iconCls}`} aria-hidden="true">
        {icon}
      </span>
      <span
        className={`text-sm mt-0.5 ${done || active ? "text-gray-900" : "text-gray-400"}`}
      >
        {label}
      </span>
    </div>
  );
}

// ── Alert banner ──────────────────────────────────────────────────────────────

function AlertBanner({
  severity,
  children,
}: {
  severity: "info" | "warning" | "error" | "neutral";
  children: React.ReactNode;
}) {
  const styles = {
    info:    "bg-blue-50 border-blue-200 text-blue-900",
    warning: "bg-yellow-50 border-yellow-200 text-yellow-900",
    error:   "bg-red-50 border-red-200 text-red-900",
    neutral: "bg-gray-50 border-gray-200 text-gray-800",
  };
  return (
    <div
      role="alert"
      className={`border rounded-lg p-3 text-sm ${styles[severity]}`}
    >
      {children}
    </div>
  );
}

// ── Loading screen ────────────────────────────────────────────────────────────

function LoadingScreen() {
  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="text-center">
        <div className="text-4xl mb-4 animate-spin inline-block" aria-hidden="true">
          ⟳
        </div>
        <p className="text-gray-600">Looking up transaction…</p>
      </div>
    </main>
  );
}

// ── Error screen (invalid hash / not found) ───────────────────────────────────

function ErrorScreen({ hash, message }: { hash: string; message: string }) {
  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow p-6 max-w-lg w-full">
        <h1 className="text-xl font-semibold text-red-700 mb-2">
          Transaction Not Found
        </h1>
        <p className="text-gray-700 text-sm mb-4">{message}</p>
        <p className="text-xs text-gray-500 mb-6">
          Hash:{" "}
          <code className="break-all font-mono">{hash}</code>
        </p>
        <Link
          href="/"
          className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-lg text-sm"
        >
          ← Back to marketplace
        </Link>
      </div>
    </main>
  );
}

// ── Wrong-network screen ──────────────────────────────────────────────────────

function WrongNetworkScreen({
  hash,
  message,
}: {
  hash: string;
  message: string;
}) {
  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow p-6 max-w-lg w-full space-y-4">
        <h1 className="text-xl font-semibold text-orange-700">
          Wrong Network
        </h1>
        <AlertBanner severity="warning">
          <strong>Network mismatch.</strong> {message}
        </AlertBanner>
        <p className="text-xs text-gray-500">
          Hash: <code className="break-all font-mono">{hash}</code>
        </p>
        <p className="text-sm text-gray-600">
          Switch your wallet to the correct network and try again. No funds
          were moved by visiting this page.
        </p>
        <Link
          href="/"
          className="inline-block px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-lg text-sm"
        >
          ← Back to marketplace
        </Link>
      </div>
    </main>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

interface PageProps {
  params: { hash: string };
}

export default function TxStatusPage({ params }: PageProps) {
  const { hash } = params;

  const [data, setData]             = useState<TxLookupResult | null>(null);
  const [loading, setLoading]       = useState(true);
  const [pollAttempt, setPollAttempt] = useState(0);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  // AbortController lets us cancel in-flight lookups on unmount / new fetch
  const abortRef = useRef<AbortController | null>(null);

  // Client-side hash format validation — gives instant feedback without a
  // round trip and prevents the RPC from receiving garbage hashes.
  const isValidHash = isValidTxHash(hash ?? "");

  const fetchStatus = useCallback(async () => {
    if (!isValidHash) {
      setData(null);
      setLoading(false);
      return;
    }

    // Cancel any previous in-flight request
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setLoading(true);
    try {
      const result = await lookupTx(hash, {
        // Single-pass lookup on the page: the auto-poll loop handles retries.
        // Use a short RPC poll (1 attempt) so the page renders quickly and the
        // polling useEffect handles the wait-and-retry logic.
        maxPollAttempts: 1,
        signal: ac.signal,
      });

      if (ac.signal.aborted) return;

      setData(result);
      setLastRefreshed(new Date());
    } catch {
      // Aborted or unexpected error — leave previous data visible if any
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [hash, isValidHash]);

  // Initial fetch
  useEffect(() => {
    fetchStatus();
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchStatus]);

  // Auto-poll while the tx is not yet terminal
  useEffect(() => {
    if (!data) return;
    if (isTxLookupTerminal(data)) return;

    const delay = nextTxPageInterval(pollAttempt);
    const timer = setTimeout(() => {
      setPollAttempt((a) => a + 1);
      fetchStatus();
    }, delay);
    return () => clearTimeout(timer);
  }, [data, pollAttempt, fetchStatus]);

  // Cleanup on unmount
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // ── Render guards ──────────────────────────────────────────────────────────

  if (loading && !data) return <LoadingScreen />;

  if (!isValidHash) {
    return (
      <ErrorScreen
        hash={hash}
        message="Invalid transaction hash — must be 64 hexadecimal characters."
      />
    );
  }

  if (!data) return <LoadingScreen />;

  if (data.chainStatus === "wrong_network") {
    return (
      <WrongNetworkScreen
        hash={hash}
        message={
          data.lookupError ??
          "This transaction was submitted on a different network."
        }
      />
    );
  }

  // "not_found" after the initial call — show a soft message; auto-poll continues
  const showNotFoundWarning =
    data.chainStatus === "not_found" && !loading;

  const isSuccess   = data.chainStatus === "success";
  const isFailed    = data.chainStatus === "failed";
  const isPending   = data.chainStatus === "pending" || data.chainStatus === "not_found";
  const isRpcError  = data.chainStatus === "rpc_error";
  const indexerDone = data.indexerStatus === "confirmed";

  const isAutoPolling = !isTxLookupTerminal(data);

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
              <StatusBadge status={data.chainStatus} />
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Indexer status</p>
              <StatusBadge status={data.indexerStatus} />
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Network</p>
              <span className="text-sm font-medium text-gray-700 capitalize">
                {data.network}
              </span>
            </div>
          </div>

          {/* ── Contextual alerts ── */}

          {/* Stale indexer: on-chain confirmed but indexer catching up */}
          {data.staleIndexer && (
            <AlertBanner severity="warning">
              <strong>Indexer is still catching up.</strong> Your transaction
              was confirmed on-chain but hasn&apos;t been picked up by the
              indexer yet. The marketplace will update automatically — no action
              needed. You can refresh below to check for progress.
            </AlertBanner>
          )}

          {/* Failed: safe to retry */}
          {isFailed && (
            <AlertBanner severity="error">
              <strong>Transaction failed on-chain.</strong> No funds or NFTs
              were transferred. It is safe to retry this action.
            </AlertBanner>
          )}

          {/* RPC error: transient */}
          {isRpcError && (
            <AlertBanner severity="neutral">
              <strong>RPC temporarily unavailable.</strong> The Stellar RPC
              could not be reached. This is usually a transient issue — the
              page will retry automatically.
            </AlertBanner>
          )}

          {/* Not found: may still be propagating — WARN against double-spend */}
          {showNotFoundWarning && (
            <AlertBanner severity="neutral">
              <strong>Status unknown.</strong> This hash was not found on the
              current network. If you recently submitted this transaction, it
              may still be propagating. Wait a few seconds and refresh.{" "}
              <em>
                Do not re-submit a payment until you have confirmed the original
                transaction failed — submitting twice could result in a double
                payment.
              </em>
            </AlertBanner>
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
              active={isPending && !showNotFoundWarning}
              failed={isFailed}
            />
            <TimelineStep
              label="Confirmed in a finalized ledger"
              done={isSuccess}
              active={isPending}
              failed={isFailed}
            />
            <TimelineStep
              label="Indexed by marketplace"
              done={indexerDone}
              active={isSuccess && data.staleIndexer}
              failed={false}
            />
          </div>
        </div>

        {/* Related resources */}
        {(data.relatedResources.listing_id ||
          data.relatedResources.auction_id ||
          data.relatedResources.offer_id) && (
          <div className="bg-white rounded-xl shadow p-5">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">
              Affected Resources
            </h2>
            <div className="flex flex-wrap gap-3 text-sm">
              {data.relatedResources.listing_id && (
                <Link
                  href={`/listings/${data.relatedResources.listing_id}`}
                  className="text-blue-600 hover:underline"
                >
                  View listing #{data.relatedResources.listing_id}
                </Link>
              )}
              {data.relatedResources.auction_id && (
                <Link
                  href={`/auctions/${data.relatedResources.auction_id}`}
                  className="text-blue-600 hover:underline"
                >
                  View auction #{data.relatedResources.auction_id}
                </Link>
              )}
              {data.relatedResources.offer_id && (
                <Link
                  href={`/offers/${data.relatedResources.offer_id}`}
                  className="text-blue-600 hover:underline"
                >
                  View offer #{data.relatedResources.offer_id}
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
                  <span className="font-medium text-gray-800">
                    {ev.eventType}
                  </span>
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
              href={data.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium"
            >
              View on Stellar Expert ↗
            </a>

            {/* Manual refresh — always safe */}
            <button
              type="button"
              onClick={() => {
                setPollAttempt(0);
                fetchStatus();
              }}
              className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-lg text-sm"
            >
              {loading ? "Refreshing…" : "Refresh status"}
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
              {isAutoPolling && " · auto-refreshing…"}
            </p>
          )}
        </div>

        {/* Support diagnostic — no secret keys involved */}
        {(isFailed || isRpcError) && (
          <div className="bg-white rounded-xl shadow p-5 text-sm text-gray-600 space-y-2">
            <h2 className="font-semibold text-gray-700">Need help?</h2>
            <p>
              Share the transaction hash above with{" "}
              <Link href="/support" className="text-blue-600 hover:underline">
                support
              </Link>{" "}
              and we can investigate. You will never need to share your secret
              key or seed phrase.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
