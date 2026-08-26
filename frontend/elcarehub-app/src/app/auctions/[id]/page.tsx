// ─────────────────────────────────────────────────────────────
// app/auctions/[id]/page.tsx — Auction detail page (ISSUE-021)
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import {
  getAuction,
  stroopsToXlm,
  Auction,
  blockBidder,
  unblockBidder,
  getBlockedBidders,
} from "@/lib/contract";
import { StrKey } from "@stellar/stellar-sdk";
import { fetchMetadata, cidToGatewayUrl, ArtworkMetadata } from "@/lib/ipfs";
import {
  subscribeToMarketplaceEvents,
  getAuctionBidHistory,
  recordAuctionBidCount,
  type BidHistoryRecord,
} from "@/lib/indexer";
import { getReadableErrorMessage } from "@/lib/errors";
import { categorizePageError, PageStateError } from "@/lib/pageState";
import { useWalletContext } from "@/context/WalletContext";
import { usePlaceBid } from "@/hooks/usePlaceBid";
import { useFinalizeAuction } from "@/hooks/useAuctions";
import { useIndexerFreshness } from "@/hooks/useIndexerFreshness";
import { GuardButton } from "@/components/WalletGuard";
import { ResourceState } from "@/components/PageStates";
import { StaleBanner } from "@/components/StaleBanner";
import { config } from "@/lib/config";
import {
  ArrowLeft,
  Clock,
  Gavel,
  Trophy,
  History,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  User,
  Calendar,
  Tag,
  Hash,
  Hammer,
  Flag,
  ChevronLeft,
  ChevronRight,
  Ban,
  X,
} from "lucide-react";
import { Breadcrumb } from "@/components/Breadcrumb";

// ── useAuctionCountdown ──────────────────────────────────────
//
// Live countdown hook that can absorb endTime extensions
// delivered via the SSE AUCTION_EXTENDED event (ISSUE-021).

export function useAuctionCountdown(initialEndTime: number) {
  const [endTime, setEndTime] = useState(initialEndTime);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // Keep endTime in sync if the parent refreshes the auction object.
  useEffect(() => {
    setEndTime(initialEndTime);
  }, [initialEndTime]);

  // Tick every second.
  useEffect(() => {
    const id = setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      1_000
    );
    return () => clearInterval(id);
  }, []);

  const remaining = Math.max(0, endTime - now);
  const days = Math.floor(remaining / 86400);
  const hours = Math.floor((remaining % 86400) / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const seconds = remaining % 60;

  return {
    endTime,
    setEndTime,
    remaining,
    isExpired: remaining <= 0,
    days,
    hours,
    minutes,
    seconds,
  };
}

// ── Countdown component ──────────────────────────────────────

interface CountdownProps {
  endTime: number;
  /** Called when the countdown receives an extension via SSE. */
  onExtend?: (newEndTime: number) => void;
}

export function Countdown({ endTime, onExtend }: CountdownProps) {
  const { days, hours, minutes, seconds, isExpired, setEndTime } =
    useAuctionCountdown(endTime);

  // Allow parent to push an extended endTime in.
  useEffect(() => {
    setEndTime(endTime);
  }, [endTime, setEndTime]);

  if (isExpired) {
    return (
      <span
        data-testid="countdown-expired"
        className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-3 py-1 text-sm font-semibold text-red-600"
      >
        <Flag size={13} />
        Auction Ended
      </span>
    );
  }

  return (
    <div data-testid="countdown" className="flex items-center gap-3">
      {(
        [
          { label: "Days", value: days },
          { label: "Hours", value: hours },
          { label: "Min", value: minutes },
          { label: "Sec", value: seconds },
        ] as const
      ).map(({ label, value }) => (
        <div
          key={label}
          className="flex flex-col items-center rounded-xl bg-brand-50 px-3 py-2 min-w-[52px]"
        >
          <span className="font-mono text-2xl font-bold text-brand-700 leading-none">
            {String(value).padStart(2, "0")}
          </span>
          <span className="mt-1 text-[10px] uppercase tracking-wide text-brand-400">
            {label}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Bid history row ──────────────────────────────────────────

function BidHistoryRow({ bid }: { bid: BidHistoryRecord }) {
  const amountXlm = (Number(bid.amount) / 10_000_000).toLocaleString(undefined, {
    maximumFractionDigits: 4,
  });

  const shortAddr = (addr: string) =>
    addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;

  const formattedTime = bid.timestamp
    ? new Date(bid.timestamp).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : `Ledger ${bid.ledger}`;

  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-3 rounded-xl border border-gray-100 bg-white px-4 py-3 text-sm">
      {/* Bidder */}
      <div className="flex items-center gap-2 text-gray-700 min-w-0">
        <User size={13} className="shrink-0 text-gray-400" />
        <span className="truncate font-mono text-xs">{shortAddr(bid.bidder)}</span>
      </div>
      {/* Amount */}
      <span className="font-semibold text-brand-600 whitespace-nowrap">{amountXlm} XLM</span>
      {/* Time */}
      <span className="text-xs text-gray-400 whitespace-nowrap text-right">{formattedTime}</span>
    </div>
  );
}

// ── Paginated bid history table ──────────────────────────────

const BID_PAGE_SIZE = 10;

interface BidHistoryTableProps {
  auctionId: number;
  /** Called once we know the total stored bid count — feeds the histogram. */
  onTotalKnown?: (total: number) => void;
}

function BidHistoryTable({ auctionId, onTotalKnown }: BidHistoryTableProps) {
  const [bids, setBids] = useState<BidHistoryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (pageOffset: number) => {
      setIsLoading(true);
      setError(null);
      try {
        const page = await getAuctionBidHistory(auctionId, pageOffset, BID_PAGE_SIZE);
        setBids(page.bids);
        setTotal(page.total);
        onTotalKnown?.(page.total);
      } catch (e) {
        setError(getReadableErrorMessage(e, "Failed to load bid history"));
      } finally {
        setIsLoading(false);
      }
    },
    [auctionId, onTotalKnown]
  );

  // Initial load
  useEffect(() => {
    fetchPage(0);
  }, [fetchPage]);

  const totalPages = Math.max(1, Math.ceil(total / BID_PAGE_SIZE));
  const currentPage = Math.floor(offset / BID_PAGE_SIZE) + 1;

  const goToPrev = () => {
    const newOffset = Math.max(0, offset - BID_PAGE_SIZE);
    setOffset(newOffset);
    fetchPage(newOffset);
  };

  const goToNext = () => {
    const newOffset = offset + BID_PAGE_SIZE;
    if (newOffset < total) {
      setOffset(newOffset);
      fetchPage(newOffset);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-2 animate-pulse">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-12 rounded-xl bg-gray-100" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">
        <AlertCircle size={14} />
        {error}
      </div>
    );
  }

  if (bids.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-gray-100 bg-white py-16">
        <History size={32} className="text-gray-300 mb-3" />
        <p className="text-sm text-gray-500">No bids placed yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Column headers */}
      <div className="grid grid-cols-[1fr_auto_auto] gap-3 px-4 text-[10px] uppercase tracking-wide text-gray-400 font-semibold">
        <span>Bidder</span>
        <span>Amount</span>
        <span className="text-right">Time</span>
      </div>

      {/* Rows */}
      <div className="space-y-2">
        {bids.map((bid, i) => (
          <BidHistoryRow key={`${bid.ledger}-${bid.bidder}-${i}`} bid={bid} />
        ))}
      </div>

      {/* Pagination controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <button
            onClick={goToPrev}
            disabled={offset === 0}
            aria-label="Previous page"
            className="flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            <ChevronLeft size={14} /> Prev
          </button>

          <span className="text-xs text-gray-500">
            Page {currentPage} of {totalPages}
            <span className="ml-1 text-gray-400">({total} total)</span>
          </span>

          <button
            onClick={goToNext}
            disabled={offset + BID_PAGE_SIZE >= total}
            aria-label="Next page"
            className="flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

// ── Blocked Bidders section (Issue #199) ─────────────────────
//
// Anti-shill-bidding registry management, shown only to the auction creator.
// Blocking bars an address from all future bids on this auction; it does not
// evict an already-escrowed highest bid.

function BlockedBiddersSection({
  auctionId,
  creatorPublicKey,
}: {
  auctionId: number;
  creatorPublicKey: string;
}) {
  const [blocked, setBlocked] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [addressInput, setAddressInput] = useState("");
  const [pending, setPending] = useState<{
    action: "block" | "unblock";
    address: string;
  } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const shortAddr = (addr: string) =>
    addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;

  const loadBlocked = useCallback(async () => {
    setIsLoading(true);
    try {
      setBlocked(await getBlockedBidders(auctionId));
    } catch {
      // Registry read failures are non-fatal — leave the last-known list.
    } finally {
      setIsLoading(false);
    }
  }, [auctionId]);

  useEffect(() => {
    loadBlocked();
  }, [loadBlocked]);

  const isValidAddress = (addr: string) =>
    StrKey.isValidEd25519PublicKey(addr.trim()) ||
    StrKey.isValidContract(addr.trim());

  const requestBlock = () => {
    const addr = addressInput.trim();
    setError(null);
    setSuccess(null);
    if (!isValidAddress(addr)) {
      setError("Enter a valid Stellar address (G… or C…).");
      return;
    }
    if (addr === creatorPublicKey) {
      setError("You cannot block your own address.");
      return;
    }
    if (blocked.includes(addr)) {
      setError("This address is already blocked.");
      return;
    }
    setPending({ action: "block", address: addr });
  };

  const confirmPending = async () => {
    if (!pending) return;
    setIsSubmitting(true);
    setError(null);
    try {
      if (pending.action === "block") {
        await blockBidder(creatorPublicKey, auctionId, pending.address);
        setSuccess(`Blocked ${shortAddr(pending.address)}.`);
        setAddressInput("");
      } else {
        await unblockBidder(creatorPublicKey, auctionId, pending.address);
        setSuccess(`Unblocked ${shortAddr(pending.address)}.`);
      }
      setPending(null);
      await loadBlocked();
    } catch (err) {
      setError(
        getReadableErrorMessage(
          err,
          pending.action === "block"
            ? "Failed to block bidder"
            : "Failed to unblock bidder"
        )
      );
      setPending(null);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mt-12" data-testid="blocked-bidders-section">
      <div className="mb-4 flex items-center gap-2">
        <Ban size={16} className="text-red-500" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Blocked Bidders
        </h2>
        {!isLoading && (
          <span className="text-xs text-gray-400">({blocked.length}/50)</span>
        )}
      </div>

      <div className="rounded-2xl border border-gray-100 bg-white p-5 space-y-4">
        <p className="text-xs text-gray-500">
          Blocked addresses cannot place bids on this auction. Blocking is not
          retroactive — an existing highest bid stays in place.
        </p>

        {/* Add-address input */}
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="G… or C… address to block"
            value={addressInput}
            onChange={(e) => setAddressInput(e.target.value)}
            className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-2.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-brand-400"
          />
          <button
            onClick={requestBlock}
            disabled={isSubmitting || !addressInput.trim()}
            className="rounded-xl bg-red-500 px-5 py-2.5 text-sm font-bold text-white hover:bg-red-600 disabled:opacity-50 transition-all"
          >
            <span className="flex items-center gap-1.5">
              <Ban size={14} /> Block
            </span>
          </button>
        </div>

        {error && <p className="text-xs text-red-500">{error}</p>}
        {success && (
          <p className="flex items-center gap-1 text-xs text-green-600">
            <CheckCircle2 size={13} /> {success}
          </p>
        )}

        {/* Current registry */}
        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-xs text-gray-400">
            <RefreshCw size={12} className="animate-spin" /> Loading blocked
            bidders…
          </div>
        ) : blocked.length === 0 ? (
          <p className="py-2 text-xs text-gray-400">
            No addresses are blocked for this auction.
          </p>
        ) : (
          <div className="space-y-2">
            {blocked.map((addr) => (
              <div
                key={addr}
                className="flex items-center justify-between rounded-xl border border-gray-100 bg-gray-50 px-4 py-2.5"
              >
                <span className="truncate font-mono text-xs text-gray-700">
                  {shortAddr(addr)}
                </span>
                <button
                  onClick={() => {
                    setError(null);
                    setSuccess(null);
                    setPending({ action: "unblock", address: addr });
                  }}
                  disabled={isSubmitting}
                  className="text-xs font-semibold text-brand-600 hover:text-brand-700 disabled:opacity-50 transition-colors"
                >
                  Unblock
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Confirmation modal */}
      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between">
              <h3 className="text-base font-bold text-gray-900">
                {pending.action === "block" ? "Block bidder?" : "Unblock bidder?"}
              </h3>
              <button
                onClick={() => setPending(null)}
                disabled={isSubmitting}
                className="text-gray-400 hover:text-gray-600"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <p className="mt-3 text-sm text-gray-600">
              {pending.action === "block"
                ? "This address will no longer be able to bid on this auction:"
                : "This address will be able to bid on this auction again:"}
            </p>
            <p className="mt-2 break-all rounded-xl bg-gray-50 px-3 py-2 font-mono text-xs text-gray-700">
              {pending.address}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setPending(null)}
                disabled={isSubmitting}
                className="rounded-xl bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-200 disabled:opacity-50 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={confirmPending}
                disabled={isSubmitting}
                className={`rounded-xl px-4 py-2 text-sm font-bold text-white disabled:opacity-50 transition-all ${
                  pending.action === "block"
                    ? "bg-red-500 hover:bg-red-600"
                    : "bg-brand-500 hover:bg-brand-600"
                }`}
              >
                {isSubmitting ? (
                  <span className="flex items-center gap-1.5">
                    <RefreshCw size={13} className="animate-spin" /> Submitting…
                  </span>
                ) : pending.action === "block" ? (
                  "Block"
                ) : (
                  "Unblock"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────

export default function AuctionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { publicKey } = useWalletContext();

  const [auction, setAuction] = useState<Auction | null>(null);
  const [metadata, setMetadata] = useState<ArtworkMetadata | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pageError, setPageError] = useState<PageStateError | null>(null);
  const [activeTab, setActiveTab] = useState<"details" | "bids">("details");
  const [bidAmountXlm, setBidAmountXlm] = useState("");
  const [bidSuccess, setBidSuccess] = useState(false);
  const [finalizeSuccess, setFinalizeSuccess] = useState(false);

  // Tracks the live end time — may be updated by an SSE AUCTION_EXTENDED event.
  const [liveEndTime, setLiveEndTime] = useState<number>(0);

  // Total bid count received from BidHistoryTable — fed to the histogram.
  const [bidTotal, setBidTotal] = useState<number | null>(null);

  const { bid, isBidding, error: bidError } = usePlaceBid(publicKey);
  const { finalize, isFinalizing, error: finalizeError } =
    useFinalizeAuction(publicKey);

  // ── Data loader ──────────────────────────────────────────

  const loadData = useCallback(async () => {
    if (!id) return;
    setIsLoading(true);
    setPageError(null);
    try {
      const auctionData = await getAuction(Number(id));
      setAuction(auctionData);
      setLiveEndTime(auctionData.end_time);

      const meta = await fetchMetadata(auctionData.metadata_cid).catch(() => null);
      setMetadata(meta);
    } catch (err) {
      // Distinguishes "this auction id doesn't exist" from "the indexer/RPC
      // is unreachable" so an outage never masquerades as a 404.
      setPageError(
        categorizePageError(err, {
          resourceLabel: "auction",
          notFoundMessage: "This auction does not exist or has been removed.",
        })
      );
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Issue #522 — indexer freshness/health for this auction. Reuses the SSE
  // subscription below (subscribeToEvents: false) rather than opening a
  // second connection, so it's fed via reportSSEEvent/reportSSEConnected.
  const freshness = useIndexerFreshness({
    resourceType: "auction",
    subscribeToEvents: false,
    onRefresh: loadData,
  });
  useEffect(() => {
    if (auction) freshness.markUpdated();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auction]);

  // ── SSE subscription — live event streaming (ISSUE-021) ──

  useEffect(() => {
    if (!id) return;
    const auctionId = Number(id);

    const sub = subscribeToMarketplaceEvents(config.indexerUrl, {
      debounceMs: 0,
      onOpen: () => freshness.reportSSEConnected(true),
      onClose: () => freshness.reportSSEConnected(false),
      onEvent(event) {
        // Feed every event (including REORG/CRITICAL_REORG, which never
        // carry an auctionId) into the freshness hook regardless of the
        // per-auction filter below.
        freshness.reportSSEEvent(event);

        // Only process events for this auction.
        if (event.auctionId !== undefined && event.auctionId !== auctionId) {
          return;
        }

        switch (event.type) {
          // A bid was placed — refresh auction data so highest_bid is up to date.
          case "BID_PLACED":
            loadData();
            break;

          // Auction extended: update endTime in place without a full reload.
          case "AUCTION_EXTENDED": {
            const newEndTime =
              event.data?.new_end_time != null
                ? Number(event.data.new_end_time)
                : undefined;
            if (newEndTime && newEndTime > 0) {
              setLiveEndTime(newEndTime);
              // Patch auction state so metadata details stay consistent.
              setAuction((prev) =>
                prev ? { ...prev, end_time: newEndTime } : prev
              );
            }
            break;
          }

          // Auction finalized or cancelled — do a full refresh to update status.
          case "AUCTION_FINALIZED":
          case "AUCTION_CANCELLED":
            loadData();
            break;
        }
      },
    });

    return () => sub.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, loadData]);

  // ── Handlers ──────────────────────────────────────────────

  const handleBid = async () => {
    if (!auction) return;
    const amountXlm = parseFloat(bidAmountXlm);
    if (!amountXlm || amountXlm <= 0) return;
    const ok = await bid(auction.auction_id, amountXlm);
    if (ok) {
      setBidSuccess(true);
      setBidAmountXlm("");
      setTimeout(() => setBidSuccess(false), 3000);
      loadData();
    }
  };

  const handleFinalize = async () => {
    if (!auction) return;
    const ok = await finalize(auction.auction_id);
    if (ok) {
      setFinalizeSuccess(true);
      loadData();
    }
  };

  // ── Derived state ─────────────────────────────────────────

  const now = Math.floor(Date.now() / 1000);
  // Use liveEndTime (updated by SSE) for expiry calculations.
  const isExpired = liveEndTime > 0 ? now >= liveEndTime : false;
  const isActive = auction?.status === "Active";
  const isFinalized = auction?.status === "Finalized";
  const isCancelled = auction?.status === "Cancelled";
  const canFinalize = isActive && isExpired;
  const canBid = isActive && !isExpired;

  const imageUrl = metadata?.image ? cidToGatewayUrl(metadata.image) : null;
  const highestBidXlm = auction ? stroopsToXlm(auction.highest_bid) : "0";
  const reserveXlm = auction ? stroopsToXlm(auction.reserve_price) : "0";

  // ── Loading skeleton ──────────────────────────────────────

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 pt-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div role="status" aria-live="polite" className="animate-pulse grid gap-8 lg:grid-cols-2">
            <span className="sr-only">Loading auction…</span>
            <div className="aspect-square rounded-3xl bg-gray-200" />
            <div className="space-y-4 pt-4">
              <div className="h-8 w-3/4 rounded-xl bg-gray-200" />
              <div className="h-5 w-1/2 rounded-xl bg-gray-200" />
              <div className="h-24 rounded-2xl bg-gray-200" />
              <div className="h-12 rounded-2xl bg-gray-200" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (pageError || !auction) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 pt-24">
        <ResourceState
          isLoading={false}
          error={
            pageError ??
            categorizePageError(new Error("Auction not found"), {
              resourceLabel: "auction",
              notFoundMessage: "This auction does not exist or has been removed.",
            })
          }
          onRetry={loadData}
          notFoundAction={{ label: "Back to Auctions", href: "/auctions" }}
        />
      </div>
    );
  }

  const artworkTitle = metadata?.title ?? `Auction #${auction.auction_id}`;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Back nav + Breadcrumb */}
      <div className="pt-20 pb-4">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <Breadcrumb
            items={[
              { label: "Auctions", href: "/auctions" },
              { label: artworkTitle },
            ]}
          />
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-4 sm:px-6 pb-16">
        {/* Issue #522 — non-blocking indexer freshness indicator. Critical
            for auctions: the countdown and highest-bid figures come straight
            from indexed events, so a lagging/unavailable indexer or a reorg
            must never be silently trusted as final. */}
        {freshness.status !== "healthy" && (
          <div className="mb-6">
            <StaleBanner
              freshness={freshness.freshness}
              status={freshness.status}
              reorg={freshness.reorg}
              onRefresh={freshness.refresh}
              isRefreshing={freshness.isRefreshing}
            />
          </div>
        )}

        <div className="grid gap-10 lg:grid-cols-[1fr_420px]">
          {/* Artwork image */}
          <div className="relative aspect-square overflow-hidden rounded-3xl bg-brand-50 shadow-md">
            {imageUrl ? (
              <Image
                src={imageUrl}
                alt={metadata?.title ?? `Auction #${auction.auction_id}`}
                fill
                className="object-cover"
                unoptimized
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <Gavel size={64} className="text-brand-200" />
              </div>
            )}

            {/* Status badge */}
            <span
              className={`absolute left-4 top-4 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider ${
                isActive
                  ? "bg-green-500 text-white"
                  : isFinalized
                  ? "bg-blue-500 text-white"
                  : "bg-gray-400 text-white"
              }`}
            >
              {auction.status}
            </span>
          </div>

          {/* Info panel */}
          <div className="flex flex-col gap-6">
            {/* Title */}
            <div>
              <h1 className="text-3xl font-display font-bold text-gray-900 leading-tight">
                {metadata?.title ?? `Auction #${auction.auction_id}`}
              </h1>
              {metadata?.description && (
                <p className="mt-2 text-sm text-gray-500 line-clamp-3">
                  {metadata.description}
                </p>
              )}
            </div>

            {/* Countdown — uses liveEndTime so SSE extensions are reflected. */}
            {isActive && (
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400 flex items-center gap-1">
                  <Clock size={12} />
                  Time Remaining
                </p>
                <Countdown endTime={liveEndTime} />
                
                {/* Extension count display */}
                {auction.extension_count !== undefined && auction.extension_count > 0 && (
                  <div className="mt-3 flex items-center gap-2">
                    <span className="text-xs text-gray-500">
                      Extended {auction.extension_count} time{auction.extension_count !== 1 ? 's' : ''}
                    </span>
                    {auction.max_extensions && auction.extension_count >= auction.max_extensions && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-600">
                        <AlertCircle size={10} />
                        Max extensions reached
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Bid summary */}
            <div className="rounded-2xl border border-gray-100 bg-white p-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-sm text-gray-500">
                  <Trophy size={14} className="text-brand-500" />
                  Current Bid
                </span>
                <span className="text-xl font-bold text-gray-900">
                  {auction.highest_bid > 0n
                    ? `${highestBidXlm} XLM`
                    : "No bids yet"}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">Reserve Price</span>
                <span className="font-medium text-gray-700">
                  {reserveXlm} XLM
                </span>
              </div>
              {auction.highest_bidder && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">Highest Bidder</span>
                  <span className="font-mono text-xs text-gray-700 truncate max-w-[180px]">
                    {auction.highest_bidder}
                  </span>
                </div>
              )}
            </div>

            {/* Place bid */}
            {canBid && (
              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                  Place a Bid
                </p>
                <div className="flex gap-2">
                  <input
                    type="number"
                    min="0"
                    step="0.0000001"
                    placeholder={`Min. ${reserveXlm} XLM`}
                    value={bidAmountXlm}
                    onChange={(e) => setBidAmountXlm(e.target.value)}
                    className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                  <GuardButton
                    onClick={handleBid}
                    disabled={isBidding || !bidAmountXlm}
                    className="rounded-xl bg-brand-500 px-5 py-2.5 text-sm font-bold text-white hover:bg-brand-600 disabled:opacity-50 transition-all"
                  >
                    {isBidding ? (
                      <RefreshCw size={14} className="animate-spin" />
                    ) : (
                      <span className="flex items-center gap-1.5">
                        <Hammer size={14} /> Bid
                      </span>
                    )}
                  </GuardButton>
                </div>
                {bidError && (
                  <p className="text-xs text-red-500">{bidError}</p>
                )}
                {bidSuccess && (
                  <p className="flex items-center gap-1 text-xs text-green-600">
                    <CheckCircle2 size={13} /> Bid placed successfully!
                  </p>
                )}
              </div>
            )}

            {/* Finalize CTA — available to any user once the auction has expired. */}
            {canFinalize && !finalizeSuccess && (
              <div className="space-y-2">
                <GuardButton
                  onClick={handleFinalize}
                  disabled={isFinalizing}
                  data-testid="finalize-btn"
                  className="w-full rounded-xl bg-midnight-900 px-5 py-3 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50 transition-all"
                >
                  {isFinalizing ? (
                    <span className="flex items-center justify-center gap-2">
                      <RefreshCw size={14} className="animate-spin" />{" "}
                      Finalizing…
                    </span>
                  ) : (
                    <span className="flex items-center justify-center gap-2">
                      <Flag size={14} /> Finalize Auction
                    </span>
                  )}
                </GuardButton>
                {finalizeError && (
                  <p className="text-xs text-red-500">{finalizeError}</p>
                )}
              </div>
            )}

            {finalizeSuccess && (
              <div className="flex items-center gap-2 rounded-xl bg-green-50 px-4 py-3 text-sm text-green-700">
                <CheckCircle2 size={16} />
                Auction finalized successfully!
              </div>
            )}

            {(isFinalized || isCancelled) && !finalizeSuccess && (
              <div
                className={`flex items-center gap-2 rounded-xl px-4 py-3 text-sm ${
                  isFinalized
                    ? "bg-blue-50 text-blue-700"
                    : "bg-gray-100 text-gray-600"
                }`}
              >
                <CheckCircle2 size={16} />
                {isFinalized
                  ? `Won by ${
                      auction.highest_bidder
                        ? `${auction.highest_bidder.slice(0, 8)}…`
                        : "unknown"
                    } for ${highestBidXlm} XLM`
                  : "Auction ended with no bids"}
              </div>
            )}

            {/* Metadata details */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              {(
                [
                  {
                    icon: Hash,
                    label: "Auction ID",
                    value: `#${auction.auction_id}`,
                  },
                  {
                    icon: User,
                    label: "Creator",
                    value: `${auction.creator.slice(0, 8)}…`,
                  },
                  {
                    icon: Tag,
                    label: "Artist",
                    value: metadata?.artist ?? "—",
                  },
                  {
                    icon: Calendar,
                    label: "End Time",
                    value: new Date(liveEndTime * 1000).toLocaleString(),
                  },
                ] as const
              ).map(({ icon: Icon, label, value }) => (
                <div
                  key={label}
                  className="flex items-start gap-2 rounded-xl border border-gray-100 bg-white p-3"
                >
                  <Icon size={13} className="mt-0.5 shrink-0 text-gray-400" />
                  <div className="min-w-0">
                    <p className="text-[10px] uppercase tracking-wide text-gray-400">
                      {label}
                    </p>
                    <p className="truncate font-medium text-gray-700">
                      {value}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {/* Refresh */}
            <button
              onClick={loadData}
              className="flex items-center gap-1.5 self-start text-xs text-gray-400 hover:text-brand-500 transition-colors"
            >
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        </div>

        {/* Bid History section */}
        <div className="mt-12">
          <div className="flex items-center gap-3 mb-4">
            {(["details", "bids"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setActiveTab(t)}
                className={`rounded-full px-4 py-1.5 text-sm font-medium transition-all ${
                  activeTab === t
                    ? "bg-brand-500 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {t === "details" ? "Details" : "Bid History"}
                {t === "bids" && bidTotal !== null && bidTotal > 0 && (
                  <span className="ml-1.5 text-xs opacity-70">({bidTotal})</span>
                )}
              </button>
            ))}
          </div>

          {activeTab === "details" && (
            <div className="rounded-2xl border border-gray-100 bg-white p-6 space-y-4">
              {metadata?.description && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">
                    Description
                  </h3>
                  <p className="text-sm text-gray-700 leading-relaxed">
                    {metadata.description}
                  </p>
                </div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
                {metadata?.category && (
                  <div>
                    <p className="text-xs text-gray-400">Category</p>
                    <p className="font-medium text-gray-700">
                      {metadata.category}
                    </p>
                  </div>
                )}
                {metadata?.year && (
                  <div>
                    <p className="text-xs text-gray-400">Year</p>
                    <p className="font-medium text-gray-700">{metadata.year}</p>
                  </div>
                )}
                <div>
                  <p className="text-xs text-gray-400">Royalty</p>
                  <p className="font-medium text-gray-700">
                    Enforced natively
                  </p>
                </div>
              </div>
            </div>
          )}

          {activeTab === "bids" && auction && (
            <BidHistoryTable
              auctionId={auction.auction_id}
              onTotalKnown={(total) => {
                setBidTotal(total);
                // Record into the Prometheus histogram whenever we learn the
                // bid count for this auction (fires on every page load/refresh).
                recordAuctionBidCount(total, config.indexerUrl);
              }}
            />
          )}
        </div>

        {/* Blocked Bidders — creator-only registry management (Issue #199) */}
        {publicKey && publicKey === auction.creator && (
          <BlockedBiddersSection
            auctionId={auction.auction_id}
            creatorPublicKey={publicKey}
          />
        )}
      </div>
    </div>
  );
}
