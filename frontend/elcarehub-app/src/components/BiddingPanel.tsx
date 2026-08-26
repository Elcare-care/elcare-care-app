// ─────────────────────────────────────────────────────────────
// components/BiddingPanel.tsx — Auction bidding UI (ISSUE-019)
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useEffect, useId, useMemo } from "react";
import { Auction, stroopsToXlm } from "@/lib/contract";
import { useWalletContext } from "@/context/WalletContext";
import { usePlaceBid } from "@/hooks/usePlaceBid";
import { useFinalizeAuction } from "@/hooks/useAuctions";
import { GuardButton } from "@/components/WalletGuard";
import { TxErrorPanel } from "@/components/TxErrorPanel";
import { useTxLifecycle, txStateLabel, isTxActive } from "@/hooks/useTxLifecycle";
import { config } from "@/lib/config";
import Link from "next/link";
import {
  Gavel,
  Clock,
  Trophy,
  User,
  CheckCircle,
  Loader2,
} from "lucide-react";

interface BiddingPanelProps {
  auction: Auction;
  onBidPlaced?: () => void;
  onFinalized?: () => void;
}

const STATUS_COLOR: Record<string, string> = {
  Active: "text-green-600 bg-green-50",
  Finalized: "text-blue-600 bg-blue-50",
  Cancelled: "text-gray-500 bg-gray-100",
};

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function useCountdown(endTime: number) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const remaining = Math.max(0, endTime - now);
  const days = Math.floor(remaining / 86400);
  const hours = Math.floor((remaining % 86400) / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const seconds = remaining % 60;
  const isExpired = remaining <= 0;

  return { days, hours, minutes, seconds, remaining, isExpired };
}

export function BiddingPanel({
  auction,
  onBidPlaced,
  onFinalized,
}: BiddingPanelProps) {
  const { publicKey } = useWalletContext();
  const { bid } = usePlaceBid(publicKey);
  const { finalize } = useFinalizeAuction(publicKey);

  // Single lifecycle instance shared by both bid and finalize actions.
  // The duplicate-submission guard in useTxLifecycle prevents concurrent runs.
  const { txState, isActive, run, reset } = useTxLifecycle({
    persistKey: `biddingPanel:${auction.auction_id}`,
    action: "Bid",
  });

  const { days, hours, minutes, seconds, isExpired } = useCountdown(
    auction.end_time
  );

  const [bidAmount, setBidAmount] = useState("");
  const [bidSuccess, setBidSuccess] = useState(false);
  const bidErrorId = useId();

  const currentBidXlm = parseFloat(stroopsToXlm(auction.highest_bid));
  const reserveXlm = parseFloat(stroopsToXlm(auction.reserve_price));

  // ISSUE-019: minimum next bid = current highest bid + 1 stroop increment.
  // If no bid yet, minimum is the reserve price.
  const MIN_INCREMENT_XLM = 0.0000001; // 1 stroop
  const minimumNextBid =
    currentBidXlm > 0 ? currentBidXlm + MIN_INCREMENT_XLM : reserveXlm;

  const isOwn = publicKey === auction.creator;
  const isAuctionActive = auction.status === "Active";
  const canBid = isAuctionActive && !isExpired && !isOwn;
  const canFinalize = isAuctionActive && isExpired;

  const isBidding = isActive && txState.txHash === null;
  const isFinalizing = isActive;

  // Pre-fill input with minimum next bid when the panel first becomes interactive.
  useEffect(() => {
    if (canBid && !bidAmount) {
      setBidAmount(minimumNextBid.toFixed(7));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canBid]);

  // ISSUE-019: client-side validation against minimum next bid.
  const bidValidation = useMemo(() => {
    const amount = parseFloat(bidAmount);
    if (!bidAmount) return null;
    if (isNaN(amount) || amount <= 0) return "Enter a valid amount";
    if (amount < minimumNextBid)
      return `Minimum bid is ${minimumNextBid.toFixed(7)} XLM${
        currentBidXlm > 0 ? " (current + increment)" : " (reserve price)"
      }`;
    return null;
  }, [bidAmount, minimumNextBid, currentBidXlm]);

  const handleBid = async () => {
    const amount = parseFloat(bidAmount);
    if (isNaN(amount) || bidValidation) return;

    // Issue #524 — fingerprint includes the bid amount, so a genuinely
    // different bid is never deduplicated against a pending one, while a
    // double-click / remount with the exact same amount is.
    const success = await run(
      () => bid(auction.auction_id, amount),
      {
        action: "Bid",
        dedupe: {
          account: publicKey,
          network: config.networkPassphrase,
          contract: config.contractId,
          args: { auctionId: auction.auction_id, amount },
        },
      }
    );
    if (success) {
      setBidSuccess(true);
      setBidAmount("");
      onBidPlaced?.();
    }
  };

  const handleFinalize = async () => {
    const success = await run(
      () => finalize(auction.auction_id),
      {
        action: "Finalize auction",
        dedupe: {
          account: publicKey,
          network: config.networkPassphrase,
          contract: config.contractId,
          args: { auctionId: auction.auction_id },
        },
      }
    );
    if (success) {
      onFinalized?.();
    }
  };

  return (
    <div className="rounded-2xl border border-brand-100 bg-brand-50 p-5 space-y-5">
      {/* Status badge */}
      <div className="flex items-center justify-between">
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_COLOR[auction.status] ?? ""}`}
        >
          {auction.status}
        </span>

        {isActive && !isExpired && (
          <div className="flex items-center gap-1.5 text-sm text-gray-500">
            <Clock size={14} />
            <span className="font-mono text-xs">
              {days > 0 && `${days}d `}
              {String(hours).padStart(2, "0")}:
              {String(minutes).padStart(2, "0")}:
              {String(seconds).padStart(2, "0")}
            </span>
          </div>
        )}

        {isActive && isExpired && (
          <span className="text-xs font-semibold text-red-500">Expired</span>
        )}
      </div>

      {/* Countdown (large display for active auctions) */}
      {isActive && !isExpired && (
        <div className="grid grid-cols-4 gap-2 text-center">
          {[
            { label: "Days", value: days },
            { label: "Hours", value: hours },
            { label: "Mins", value: minutes },
            { label: "Secs", value: seconds },
          ].map(({ label, value }) => (
            <div
              key={label}
              className="rounded-xl bg-white p-2 shadow-sm border border-gray-100"
            >
              <p className="text-2xl font-bold text-gray-900">
                {String(value).padStart(2, "0")}
              </p>
              <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">
                {label}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Current highest bid */}
      <div>
        <div className="flex items-center gap-2 text-brand-600">
          <Trophy size={16} />
          <span className="text-3xl font-bold">
            {currentBidXlm > 0
              ? `${stroopsToXlm(auction.highest_bid)} XLM`
              : "No bids yet"}
          </span>
        </div>
        {auction.highest_bidder && (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-gray-400">
            <User size={12} />
            Highest bidder:{" "}
            <span className="font-mono">
              {truncateAddress(auction.highest_bidder)}
            </span>
          </p>
        )}
      </div>

      {/* Reserve price + minimum next bid (ISSUE-019) */}
      <div className="space-y-1 text-xs text-gray-500">
        <div className="flex items-center justify-between">
          <span>Reserve price:</span>
          <span className="font-semibold text-gray-700">
            {stroopsToXlm(auction.reserve_price)} XLM
          </span>
        </div>
        {isAuctionActive && (
          <div
            data-testid="minimum-next-bid"
            className="flex items-center justify-between text-brand-600"
          >
            <span>Minimum next bid:</span>
            <span className="font-semibold">
              {minimumNextBid.toFixed(7)} XLM
            </span>
          </div>
        )}
      </div>

      {/* Bid success */}
      {bidSuccess && (
        <div role="status" className="flex items-center gap-2 rounded-lg bg-green-100 px-3 py-2 text-sm font-medium text-green-700">
          <CheckCircle size={16} aria-hidden="true" />
          Bid placed successfully!
        </div>
      )}

      {/* Transaction lifecycle state label (signing / confirming / etc.) */}
      {isActive && (
        <div role="status" className="flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-700">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          {txStateLabel(txState.state)}
        </div>
      )}

      {/* Typed error panel — distinguishes wallet rejection from chain failure */}
      {txState.state === "error" && txState.error && (
        <TxErrorPanel
          error={txState.error}
          txHash={txState.txHash}
          onRetry={reset}
          onDismiss={reset}
        />
      )}

      {/* sr-only live region for assistive technologies */}
      {isActive && (
        <div role="status" className="sr-only">
          {txStateLabel(txState.state)}
        </div>
      )}

      {/* Bid input + button */}
      {canBid && (
        <div className="space-y-3">
          <div>
            <label htmlFor="bid-amount-input" className="mb-1 block text-sm font-medium text-gray-700">
              Your Bid (XLM)
            </label>
            <div className="relative">
              <input
                id="bid-amount-input"
                type="number"
                min={minimumNextBid}
                step="0.0000001"
                value={bidAmount}
                onChange={(e) => {
                  setBidAmount(e.target.value);
                  setBidSuccess(false);
                }}
                placeholder={`Min ${minimumNextBid.toFixed(7)} XLM`}
                aria-invalid={!!bidValidation}
                aria-describedby={bidValidation ? bidErrorId : undefined}
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 pr-14 text-sm focus:border-brand-500 focus:outline-none aria-[invalid=true]:border-red-400"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-gray-400">
                XLM
              </span>
            </div>
            {bidValidation && (
              <p id={bidErrorId} role="alert" className="mt-1 flex items-center gap-1 text-xs text-red-500">
                <AlertCircle size={12} aria-hidden="true" />
                {bidValidation}
              </p>
            )}
          </div>

          <GuardButton
            onAction={handleBid}
            disabled={isBidding || !bidAmount || !!bidValidation}
            actionName="To place a bid"
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-500 py-3.5 font-bold text-white shadow-xl shadow-brand-500/20 hover:bg-brand-600 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50"
          >
            {isBidding ? (
              <>
                <Loader2 size={18} className="animate-spin" />
                Placing Bid…
              </>
            ) : (
              <>
                <Gavel size={18} />
                Place Bid
              </>
            )}
          </GuardButton>
        </div>
      )}

      {/* Finalize button */}
      {canFinalize && (
        <GuardButton
          onAction={handleFinalize}
          disabled={isFinalizing}
          actionName="To finalize this auction"
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 py-3.5 font-bold text-white shadow-xl shadow-blue-600/20 hover:bg-blue-700 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50"
        >
          {isFinalizing ? (
            <>
              <Loader2 size={18} className="animate-spin" />
              Finalizing…
            </>
          ) : (
            <>
              <CheckCircle size={18} />
              Finalize Auction
            </>
          )}
        </GuardButton>
      )}

      {/* Transaction hash recovery link — visible once the hash is known */}
      {txState.txHash && (
        <p className="text-xs text-gray-400 text-center">
          Tx:{" "}
          <Link
            href={`/tx/${txState.txHash}`}
            className="font-mono hover:underline text-blue-500"
          >
            {txState.txHash.slice(0, 10)}…
          </Link>
        </p>
      )}

      {/* Own auction message */}
      {isOwn && isAuctionActive && !isExpired && (
        <p className="text-center text-sm text-gray-400">
          This is your auction.
        </p>
      )}

      {/* Finalized info */}
      {auction.status === "Finalized" && auction.highest_bidder && (
        <div className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">
          Won by{" "}
          <span className="font-mono font-semibold">
            {truncateAddress(auction.highest_bidder)}
          </span>{" "}
          for {stroopsToXlm(auction.highest_bid)} XLM
        </div>
      )}

      {auction.status === "Cancelled" && (
        <div className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-500">
          This auction ended with no bids.
        </div>
      )}
    </div>
  );
}
