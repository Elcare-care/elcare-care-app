// ─────────────────────────────────────────────────────────────
// components/AuctionManagementPanel.tsx — Creator management + refund
// guidance for an auction (Issue #527)
//
// Renders three independent sections, each gated on the contract's actual
// state-transition rules so a control disappears (or explains itself)
// exactly when the on-chain call would be rejected:
//
//   1. Lifecycle status  — indexed status + a locally-tracked "may be stale"
//      hint (Issue #527 acceptance: provisional/stale states must be
//      visually distinct from confirmed indexed state).
//   2. Creator controls  — Cancel (only while Active with zero bids —
//      the contract has no update_auction, so "edit" is cancel+recreate,
//      also gated on zero bids) and an inline edit form.
//   3. Refund guidance   — for any connected wallet that placed a losing
//      bid on a terminal auction.
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  Info,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import { Auction, stroopsToXlm } from "@/lib/contract";
import {
  useCancelAuction,
  useEditAuctionBeforeFirstBid,
  useRefundLosingBid,
  type CreateAuctionInput,
} from "@/hooks/useAuctions";
import { getAuctionBidHistory } from "@/lib/indexer";
import { isValidStellarAddress } from "@/lib/validation";
import { GuardButton } from "@/components/WalletGuard";
import { DEFAULT_TOKEN } from "@/config/tokens";

// ── Lifecycle status ──────────────────────────────────────────

export type AuctionLifecyclePhase =
  | "provisional" // local data is older than the staleness threshold
  | "live_no_bids"
  | "live_with_bids"
  | "ended_awaiting_finalization"
  | "finalized"
  | "cancelled";

export function deriveLifecyclePhase(
  auction: Auction,
  isExpired: boolean,
  isStale: boolean
): AuctionLifecyclePhase {
  if (isStale) return "provisional";
  if (auction.status === "Finalized") return "finalized";
  if (auction.status === "Cancelled") return "cancelled";
  if (isExpired) return "ended_awaiting_finalization";
  return auction.highest_bid > 0n ? "live_with_bids" : "live_no_bids";
}

const PHASE_META: Record<
  AuctionLifecyclePhase,
  { label: string; className: string; description: string }
> = {
  provisional: {
    label: "Refreshing…",
    className: "bg-gray-100 text-gray-500",
    description:
      "This view hasn't refreshed recently — the on-chain state may have changed. Refresh before taking an action.",
  },
  live_no_bids: {
    label: "Live — no bids yet",
    className: "bg-green-50 text-green-700",
    description: "Reserve price, duration, asset, and recipients can still be edited or the auction cancelled.",
  },
  live_with_bids: {
    label: "Live — bidding",
    className: "bg-green-500 text-white",
    description: "A bid is escrowed. Reserve price, duration, asset, and recipients are now locked for this auction.",
  },
  ended_awaiting_finalization: {
    label: "Ended — awaiting finalization",
    className: "bg-amber-100 text-amber-700",
    description: "Time is up. Anyone can call Finalize to settle the sale (or return the NFT if there were no bids).",
  },
  finalized: {
    label: "Finalized",
    className: "bg-blue-500 text-white",
    description: "Settled on-chain. The NFT and funds have moved to their final owners.",
  },
  cancelled: {
    label: "Cancelled",
    className: "bg-gray-400 text-white",
    description: "This auction was cancelled before any bid was placed and the NFT was returned to the creator.",
  },
};

export function AuctionLifecycleBadge({
  phase,
  showDescription = true,
}: {
  phase: AuctionLifecyclePhase;
  showDescription?: boolean;
}) {
  const meta = PHASE_META[phase];
  return (
    <div data-testid="auction-lifecycle-badge" className="space-y-1.5">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${meta.className}`}
      >
        {phase === "provisional" && <RefreshCw size={11} className="animate-spin" />}
        {meta.label}
      </span>
      {showDescription && (
        <p className="text-xs text-gray-400 leading-relaxed">{meta.description}</p>
      )}
    </div>
  );
}

// ── Recipient row editor (compact) ────────────────────────────

interface RecipientRow {
  address: string;
  percentage: number;
}

function RecipientEditor({
  rows,
  onChange,
}: {
  rows: RecipientRow[];
  onChange: (rows: RecipientRow[]) => void;
}) {
  const total = rows.reduce((sum, r) => sum + (r.percentage || 0), 0);

  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div key={i} className="flex gap-2">
          <input
            value={row.address}
            onChange={(e) => {
              const next = [...rows];
              next[i] = { ...next[i], address: e.target.value };
              onChange(next);
            }}
            placeholder="G… recipient address"
            className="flex-1 rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-brand-400"
          />
          <input
            type="number"
            min={0}
            max={100}
            value={row.percentage}
            onChange={(e) => {
              const next = [...rows];
              next[i] = { ...next[i], percentage: parseFloat(e.target.value) || 0 };
              onChange(next);
            }}
            className="w-20 rounded-lg border border-gray-200 px-2 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-brand-400"
          />
          <button
            type="button"
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
            disabled={rows.length <= 1}
            className="rounded-lg px-2 text-gray-400 hover:text-red-500 disabled:opacity-30"
            aria-label="Remove recipient"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => onChange([...rows, { address: "", percentage: 0 }])}
          disabled={rows.length >= 4}
          className="flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-700 disabled:opacity-40"
        >
          <Plus size={12} /> Add recipient
        </button>
        <span className={`text-xs ${Math.round(total) === 100 ? "text-gray-400" : "text-red-500"}`}>
          {total.toFixed(0)}% of 100%
        </span>
      </div>
    </div>
  );
}

// ── Creator controls (cancel + edit-before-first-bid) ─────────

interface CreatorControlsProps {
  auction: Auction;
  publicKey: string;
  onChanged: (newAuctionId?: number) => void;
}

function CreatorControls({ auction, publicKey, onChanged }: CreatorControlsProps) {
  const hasBids = auction.highest_bid > 0n;
  const canModify = auction.status === "Active" && !hasBids;

  const { cancel, isCancelling } = useCancelAuction(publicKey);
  const { save, isSaving, progress: saveProgress, error: saveError } =
    useEditAuctionBeforeFirstBid(publicKey);

  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);

  const [form, setForm] = useState({
    collectionAddress: auction.collection,
    nftTokenId: auction.token_id,
    reservePriceXlm: parseFloat(stroopsToXlm(auction.reserve_price)),
    durationHours: Math.max(1, Math.round((auction.end_time - auction.created_at) / 3600) || 24),
    tokenAddress: auction.token || DEFAULT_TOKEN.address,
  });
  const [recipients, setRecipients] = useState<RecipientRow[]>(
    auction.recipients.length > 0
      ? auction.recipients.map((r) => ({ address: r.address, percentage: r.percentage }))
      : [{ address: auction.creator, percentage: 100 }]
  );

  const handleCancel = async () => {
    setCancelError(null);
    const ok = await cancel(auction.auction_id);
    setConfirmCancel(false);
    if (ok) onChanged();
    else setCancelError("Failed to cancel auction. It may already have a bid — refresh and try again.");
  };

  const handleSaveEdit = async () => {
    const recipientsTotal = recipients.reduce((sum, r) => sum + (r.percentage || 0), 0);
    if (Math.round(recipientsTotal) !== 100) return;
    if (!isValidStellarAddress(form.collectionAddress.trim())) return;

    const input: CreateAuctionInput = {
      collectionAddress: form.collectionAddress.trim(),
      nftTokenId: Number(form.nftTokenId),
      reservePriceXlm: form.reservePriceXlm,
      durationSeconds: Math.round(form.durationHours * 3600),
      recipients: recipients.map((r) => ({ address: r.address.trim(), percentage: r.percentage })),
      tokenAddress: form.tokenAddress,
    };

    const newId = await save(auction, input);
    if (newId !== null) {
      setIsEditing(false);
      onChanged(newId);
    }
  };

  if (auction.status !== "Active") return null;

  return (
    <div className="mt-8 space-y-4" data-testid="auction-creator-controls">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
        Creator Controls
      </h2>

      {!canModify ? (
        <div className="flex items-start gap-2 rounded-2xl border border-gray-100 bg-gray-50 p-4 text-xs text-gray-500">
          <Info size={14} className="mt-0.5 shrink-0" />
          <p>
            A bid has been placed, so reserve price, duration, asset, and recipients are now
            immutable, and this auction can no longer be cancelled — the bidder&apos;s funds are
            escrowed. You can finalize once it ends, or wait for a higher bid.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setIsEditing((v) => !v)}
              className="flex items-center gap-1.5 rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-all"
              data-testid="edit-auction-toggle"
            >
              <Pencil size={13} /> {isEditing ? "Close editor" : "Edit auction"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmCancel(true)}
              className="flex items-center gap-1.5 rounded-xl border border-red-200 px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 transition-all"
              data-testid="cancel-auction-btn"
            >
              <Ban size={13} /> Cancel auction
            </button>
          </div>
          {cancelError && <p className="text-xs text-red-500">{cancelError}</p>}

          {isEditing && (
            <div className="rounded-2xl border border-gray-100 bg-white p-5 space-y-4">
              <p className="text-xs text-gray-500">
                No bids yet, so every field below is still editable. Saving cancels this auction
                and immediately recreates it with your changes — two on-chain transactions,
                confirmed one after another.
              </p>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-gray-400">
                    Collection address
                  </label>
                  <input
                    value={form.collectionAddress}
                    onChange={(e) => setForm({ ...form, collectionAddress: e.target.value })}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-gray-400">
                    Token ID
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={form.nftTokenId}
                    onChange={(e) => setForm({ ...form, nftTokenId: parseInt(e.target.value) || 0 })}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-gray-400">
                    Reserve price (XLM)
                  </label>
                  <input
                    type="number"
                    min={0.0000001}
                    step="any"
                    value={form.reservePriceXlm}
                    onChange={(e) =>
                      setForm({ ...form, reservePriceXlm: parseFloat(e.target.value) || 0 })
                    }
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-gray-400">
                    Duration (hours, min 1)
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={form.durationHours}
                    onChange={(e) =>
                      setForm({ ...form, durationHours: parseFloat(e.target.value) || 1 })
                    }
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-gray-400">
                  Recipients (must total 100%)
                </label>
                <RecipientEditor rows={recipients} onChange={setRecipients} />
              </div>

              {saveError && <p className="text-xs text-red-500">{saveError}</p>}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  disabled={isSaving}
                  className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                >
                  Discard
                </button>
                <GuardButton
                  onClick={handleSaveEdit}
                  disabled={isSaving || form.durationHours < 1 || form.reservePriceXlm <= 0}
                  className="flex-[2] flex items-center justify-center gap-2 rounded-xl bg-brand-500 py-2.5 text-sm font-bold text-white hover:bg-brand-600 disabled:opacity-50"
                >
                  {isSaving ? (
                    <>
                      <RefreshCw size={13} className="animate-spin" /> {saveProgress || "Saving…"}
                    </>
                  ) : (
                    "Save changes"
                  )}
                </GuardButton>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Cancel confirmation */}
      {confirmCancel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between">
              <h3 className="text-base font-bold text-gray-900">Cancel this auction?</h3>
              <button
                onClick={() => setConfirmCancel(false)}
                disabled={isCancelling}
                className="text-gray-400 hover:text-gray-600"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <p className="mt-3 text-sm text-gray-600">
              The escrowed NFT will be returned to your wallet. This cannot be undone — you would
              need to create a new auction to relist it.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirmCancel(false)}
                disabled={isCancelling}
                className="rounded-xl bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-200 disabled:opacity-50"
              >
                Keep auction
              </button>
              <button
                onClick={handleCancel}
                disabled={isCancelling}
                className="rounded-xl bg-red-500 px-4 py-2 text-sm font-bold text-white hover:bg-red-600 disabled:opacity-50"
              >
                {isCancelling ? "Cancelling…" : "Cancel auction"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Refund guidance ────────────────────────────────────────────

function RefundGuidance({
  auction,
  publicKey,
}: {
  auction: Auction;
  publicKey: string;
}) {
  const [participated, setParticipated] = useState<boolean | null>(null);
  const { refund, isRefunding } = useRefundLosingBid(publicKey);
  const [claimed, setClaimed] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Bid history is capped at a single page here — good enough to answer
    // "did this wallet ever bid" for the vast majority of auctions; a wallet
    // that bid beyond the first 100 records will just see the generic
    // guidance text below instead of the shortcut button.
    getAuctionBidHistory(auction.auction_id, 0, 100)
      .then((page) => {
        if (!cancelled) setParticipated(page.bids.some((b) => b.bidder === publicKey));
      })
      .catch(() => {
        if (!cancelled) setParticipated(null);
      });
    return () => {
      cancelled = true;
    };
  }, [auction.auction_id, publicKey]);

  const isWinner = auction.status === "Finalized" && auction.highest_bidder === publicKey;

  if (isWinner) return null;
  if (participated !== true) return null;

  const handleClaim = async () => {
    setClaimError(null);
    const ok = await refund(auction.auction_id);
    if (ok) setClaimed(true);
    else
      setClaimError(
        "No refund is currently available for this account — it may have already been paid out automatically when you were outbid."
      );
  };

  return (
    <div
      className="mt-8 rounded-2xl border border-brand-100 bg-brand-50/40 p-5 space-y-3"
      data-testid="refund-guidance"
    >
      <div className="flex items-center gap-2">
        <Wallet size={15} className="text-brand-600" />
        <h2 className="text-sm font-semibold text-brand-900">Refund guidance</h2>
      </div>
      <p className="text-xs text-brand-700 leading-relaxed">
        You placed a bid on this auction that did not win. Losing bids are refunded automatically
        the moment they are outbid — if that already happened, your funds are back in your
        wallet. If you believe a refund is still outstanding (for example, this auction was
        finalized with no winner), you can claim it below.
      </p>
      {claimed ? (
        <p className="flex items-center gap-1.5 text-xs font-semibold text-green-600">
          <CheckCircle2 size={13} /> Refund claimed.
        </p>
      ) : (
        <GuardButton
          onClick={handleClaim}
          disabled={isRefunding}
          className="rounded-xl bg-brand-500 px-4 py-2 text-xs font-bold text-white hover:bg-brand-600 disabled:opacity-50"
        >
          {isRefunding ? "Checking…" : "Claim refund"}
        </GuardButton>
      )}
      {claimError && (
        <p className="flex items-start gap-1.5 text-xs text-amber-600">
          <AlertCircle size={12} className="mt-0.5 shrink-0" /> {claimError}
        </p>
      )}
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────

export interface AuctionManagementPanelProps {
  auction: Auction;
  publicKey: string | null;
  isExpired: boolean;
  /** True when the auction data was fetched more than the freshness
   *  threshold ago and hasn't been confirmed since. */
  isStale: boolean;
  onChanged: (newAuctionId?: number) => void;
}

export function AuctionManagementPanel({
  auction,
  publicKey,
  isExpired,
  isStale,
  onChanged,
}: AuctionManagementPanelProps) {
  const phase = useMemo(
    () => deriveLifecyclePhase(auction, isExpired, isStale),
    [auction, isExpired, isStale]
  );
  const isCreator = !!publicKey && publicKey === auction.creator;

  return (
    <div data-testid="auction-management-panel">
      <AuctionLifecycleBadge phase={phase} />
      {isCreator && (
        <CreatorControls auction={auction} publicKey={publicKey!} onChanged={onChanged} />
      )}
      {publicKey && !isCreator && (auction.status === "Finalized" || auction.status === "Cancelled") && (
        <RefundGuidance auction={auction} publicKey={publicKey} />
      )}
    </div>
  );
}
