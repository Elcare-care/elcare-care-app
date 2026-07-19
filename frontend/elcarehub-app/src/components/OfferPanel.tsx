/**
 * OfferPanel — unified offer UI for the listing detail page.
 *
 * Behaviour:
 *  - Viewer is the listing OWNER  → shows a list of active offers with
 *    Accept / Reject buttons for each.
 *  - Viewer is NOT the owner       → shows a "Make Offer" button that opens
 *    a modal with amount input, token selector, and optional expiry date.
 *  - Viewer is not connected        → prompts wallet connection via GuardButton.
 *
 * All contract calls are delegated to the hooks from useOffers.ts /
 * contract.ts so this component stays purely presentational.
 */

"use client";

import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  HandCoins,
  CheckCircle,
  XCircle,
  Loader2,
  CalendarClock,
  ChevronDown,
  AlertCircle,
  TrendingUp,
  User,
  X,
} from "lucide-react";
import { clsx } from "clsx";
import { Offer, stroopsToXlm } from "@/lib/contract";
import { SUPPORTED_TOKENS, TokenConfig } from "@/config/tokens";
import { GuardButton } from "@/components/WalletGuard";
import { useAcceptOffer, useRejectOffer } from "@/hooks/useOffers";
import { useModalA11y } from "@/hooks/useModalA11y";

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortAddr(addr: string): string {
  if (!addr || addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function getTokenSymbol(address: string): string {
  return SUPPORTED_TOKENS.find((t) => t.address === address)?.symbol ?? "Tokens";
}

// ── Make-Offer Modal ──────────────────────────────────────────────────────────

interface MakeOfferModalProps {
  isOpen: boolean;
  onClose: () => void;
  listingId: number;
  defaultToken: string;
  onSubmit: (amount: number, tokenAddress: string, expiryTs?: number) => Promise<boolean>;
  isSubmitting: boolean;
  error: string | null;
}

function MakeOfferModal({
  isOpen,
  onClose,
  listingId,
  defaultToken,
  onSubmit,
  isSubmitting,
  error,
}: MakeOfferModalProps) {
  const { dialogRef, titleId } = useModalA11y(isOpen, onClose);
  const [amount, setAmount] = useState("");
  const [tokenAddress, setTokenAddress] = useState(defaultToken);
  const [expiryDate, setExpiryDate] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setAmount("");
      setTokenAddress(defaultToken);
      setExpiryDate("");
      setLocalError(null);
      setSuccess(false);
    }
  }, [isOpen, defaultToken]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    const amountNum = Number(amount);
    if (!amount || !Number.isFinite(amountNum) || amountNum <= 0) {
      setLocalError("Please enter a valid offer amount.");
      return;
    }

    let expiryTs: number | undefined;
    if (expiryDate) {
      const ts = Math.floor(new Date(expiryDate).getTime() / 1000);
      if (!Number.isFinite(ts) || ts <= Math.floor(Date.now() / 1000)) {
        setLocalError("Expiry date must be in the future.");
        return;
      }
      expiryTs = ts;
    }

    const ok = await onSubmit(amountNum, tokenAddress, expiryTs);
    if (ok) {
      setSuccess(true);
      setTimeout(() => {
        onClose();
        setSuccess(false);
      }, 1200);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-midnight-950/80 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="make-offer-modal"
        tabIndex={-1}
        className="relative w-full max-w-md overflow-hidden rounded-3xl bg-midnight-900 border border-white/10 shadow-2xl outline-none animate-scale-in"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/5 p-6">
          <div>
            <h2 id={titleId} className="text-lg font-bold text-white font-display">
              Make an Offer
            </h2>
            <p className="text-[11px] text-white/30 mt-0.5">
              Listing #{listingId}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close offer modal"
            className="rounded-full p-2 text-white/40 hover:text-white hover:bg-white/10 transition"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {/* Amount input */}
          <div className="space-y-2">
            <label
              htmlFor="offer-amount"
              className="block text-[10px] uppercase tracking-[0.25em] font-bold text-white/40"
            >
              Offer Amount
            </label>
            <input
              id="offer-amount"
              data-testid="offer-amount-input"
              type="number"
              min="0"
              step="any"
              placeholder="e.g. 50"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
              className="w-full rounded-2xl bg-white/5 border border-white/10 px-5 py-4 text-white text-lg font-bold placeholder-white/20 focus:outline-none focus:border-brand-500 transition"
            />
          </div>

          {/* Token selector */}
          <div className="space-y-2">
            <label
              htmlFor="offer-token"
              className="block text-[10px] uppercase tracking-[0.25em] font-bold text-white/40"
            >
              Payment Token
            </label>
            <div className="relative">
              <select
                id="offer-token"
                data-testid="offer-token-select"
                value={tokenAddress}
                onChange={(e) => setTokenAddress(e.target.value)}
                className="w-full appearance-none rounded-2xl bg-white/5 border border-white/10 px-5 py-4 text-white font-bold focus:outline-none focus:border-brand-500 transition pr-10"
              >
                {SUPPORTED_TOKENS.map((token: TokenConfig) => (
                  <option
                    key={token.address}
                    value={token.address}
                    className="bg-midnight-900 text-white"
                  >
                    {token.symbol} — {token.name}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={16}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none"
              />
            </div>
          </div>

          {/* Optional expiry date */}
          <div className="space-y-2">
            <label
              htmlFor="offer-expiry"
              className="block text-[10px] uppercase tracking-[0.25em] font-bold text-white/40"
            >
              Offer Expiry <span className="normal-case text-white/20">(optional)</span>
            </label>
            <div className="relative">
              <input
                id="offer-expiry"
                data-testid="offer-expiry-input"
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                min={new Date(Date.now() + 86400_000).toISOString().split("T")[0]}
                className="w-full rounded-2xl bg-white/5 border border-white/10 px-5 py-4 text-white font-bold focus:outline-none focus:border-brand-500 transition [color-scheme:dark]"
              />
              <CalendarClock
                size={16}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-white/30 pointer-events-none"
              />
            </div>
          </div>

          {/* Error */}
          {(localError || error) && (
            <div
              className="flex items-center gap-2 rounded-xl border border-terracotta-500/20 bg-terracotta-500/10 px-4 py-3 text-xs text-terracotta-400"
              data-testid="offer-modal-error"
            >
              <AlertCircle size={14} />
              {localError || error}
            </div>
          )}

          {/* Success */}
          {success && (
            <div
              className="flex items-center gap-2 rounded-xl border border-mint-500/20 bg-mint-500/10 px-4 py-3 text-xs text-mint-400"
              data-testid="offer-modal-success"
            >
              <CheckCircle size={14} />
              Offer placed successfully!
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            data-testid="offer-submit-btn"
            disabled={isSubmitting || success}
            className="w-full flex items-center justify-center gap-2 rounded-2xl bg-brand-500 hover:bg-brand-600 py-5 text-sm font-bold text-white shadow-xl shadow-brand-500/20 transition-all disabled:opacity-50"
          >
            {isSubmitting ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Placing offer…
              </>
            ) : success ? (
              <>
                <CheckCircle size={16} />
                Offer placed!
              </>
            ) : (
              <>
                <HandCoins size={16} />
                Place Offer
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Owner Offer List ──────────────────────────────────────────────────────────

interface OwnerOfferListProps {
  offers: Offer[];
  isLoading: boolean;
  ownerPublicKey: string;
  onRefresh: () => void;
}

function OwnerOfferList({
  offers,
  isLoading,
  ownerPublicKey,
  onRefresh,
}: OwnerOfferListProps) {
  const { accept, isAccepting, error: acceptError } = useAcceptOffer(ownerPublicKey);
  const { reject, isRejecting, error: rejectError } = useRejectOffer(ownerPublicKey);

  const pendingOffers = offers.filter((o) => o.status === "Pending");
  const otherOffers = offers.filter((o) => o.status !== "Pending");

  return (
    <div className="space-y-3" data-testid="owner-offer-list">
      {/* Error banners */}
      {(acceptError || rejectError) && (
        <div className="flex items-center gap-2 rounded-xl border border-terracotta-500/20 bg-terracotta-500/10 px-4 py-3 text-xs text-terracotta-400">
          <AlertCircle size={14} />
          {acceptError || rejectError}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-20 rounded-2xl bg-white/5 animate-pulse border border-white/5"
            />
          ))}
        </div>
      ) : pendingOffers.length === 0 && otherOffers.length === 0 ? (
        <div
          className="py-10 text-center text-white/30"
          data-testid="no-offers-owner"
        >
          <TrendingUp size={36} className="mx-auto mb-3 opacity-20" />
          <p className="text-sm italic">No offers received yet</p>
        </div>
      ) : (
        <>
          {pendingOffers.length > 0 && (
            <div className="space-y-3">
              <p className="text-[10px] uppercase tracking-[0.25em] font-bold text-white/30">
                Pending ({pendingOffers.length})
              </p>
              {pendingOffers.map((offer) => (
                <div
                  key={offer.offer_id}
                  data-testid={`owner-offer-card-${offer.offer_id}`}
                  className="flex flex-col sm:flex-row sm:items-center gap-4 rounded-2xl bg-white/5 border border-white/10 p-4 hover:bg-white/[0.07] transition-all"
                >
                  {/* Offerer info */}
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center">
                      <User size={15} className="text-brand-400" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[10px] uppercase font-bold text-white/30 mb-0.5">
                        Offerer
                      </p>
                      <p className="text-xs font-mono text-white/70 truncate">
                        {shortAddr(offer.offerer)}
                      </p>
                    </div>
                  </div>

                  {/* Amount */}
                  <div className="flex flex-col shrink-0">
                    <p className="text-[10px] uppercase font-bold text-white/30 mb-0.5">
                      Amount
                    </p>
                    <span className="font-display font-bold text-white">
                      {stroopsToXlm(offer.amount)}{" "}
                      <span className="text-brand-400 text-xs">
                        {getTokenSymbol(offer.token)}
                      </span>
                    </span>
                  </div>

                  {/* Accept / Reject */}
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      data-testid={`accept-offer-btn-${offer.offer_id}`}
                      onClick={async () => {
                        const ok = await accept(offer.offer_id);
                        if (ok) onRefresh();
                      }}
                      disabled={isAccepting || isRejecting}
                      className="flex items-center gap-1.5 rounded-xl bg-mint-500/20 hover:bg-mint-500/30 px-4 py-2.5 text-xs font-bold text-mint-400 border border-mint-500/30 transition-all disabled:opacity-50"
                      aria-label={`Accept offer ${offer.offer_id}`}
                    >
                      {isAccepting ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <CheckCircle size={13} />
                      )}
                      Accept
                    </button>
                    <button
                      data-testid={`reject-offer-btn-${offer.offer_id}`}
                      onClick={async () => {
                        const ok = await reject(offer.offer_id);
                        if (ok) onRefresh();
                      }}
                      disabled={isAccepting || isRejecting}
                      className="flex items-center gap-1.5 rounded-xl bg-white/5 hover:bg-terracotta-500/20 px-4 py-2.5 text-xs font-bold text-white/50 hover:text-terracotta-400 border border-white/10 hover:border-terracotta-500/30 transition-all disabled:opacity-50"
                      aria-label={`Reject offer ${offer.offer_id}`}
                    >
                      {isRejecting ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <XCircle size={13} />
                      )}
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Historical offers (accepted / rejected) */}
          {otherOffers.length > 0 && (
            <div className="space-y-2 mt-4">
              <p className="text-[10px] uppercase tracking-[0.25em] font-bold text-white/20">
                Past Offers
              </p>
              {otherOffers.map((offer) => (
                <div
                  key={offer.offer_id}
                  data-testid={`owner-offer-card-${offer.offer_id}`}
                  className="flex items-center justify-between rounded-2xl bg-white/[0.03] border border-white/5 px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <p className="text-xs font-mono text-white/40">
                      {shortAddr(offer.offerer)}
                    </p>
                    <span className="font-bold text-sm text-white/50">
                      {stroopsToXlm(offer.amount)}{" "}
                      <span className="text-[10px] text-white/30">
                        {getTokenSymbol(offer.token)}
                      </span>
                    </span>
                  </div>
                  <span
                    className={clsx(
                      "text-[9px] font-bold uppercase tracking-widest px-3 py-1 rounded-full border",
                      offer.status === "Accepted"
                        ? "bg-mint-500/10 text-mint-400 border-mint-500/20"
                        : offer.status === "Rejected"
                        ? "bg-terracotta-500/10 text-terracotta-400 border-terracotta-500/20"
                        : "bg-white/5 text-white/30 border-white/10"
                    )}
                  >
                    {offer.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── OfferPanel — main export ─────────────────────────────────────────────────

export interface OfferPanelProps {
  listingId: number;
  listingToken: string;
  isOwner: boolean;
  /** All offers for this listing */
  offers: Offer[];
  isLoadingOffers: boolean;
  onRefreshOffers: () => void;
  /** For the buyer flow */
  onMakeOffer: (
    amount: number,
    tokenAddress: string,
    expiryTs?: number
  ) => Promise<boolean>;
  isMakingOffer: boolean;
  makeOfferError: string | null;
  /** Whether the listing is still purchasable */
  isActive: boolean;
  ownerPublicKey: string | null;
}

export function OfferPanel({
  listingId,
  listingToken,
  isOwner,
  offers,
  isLoadingOffers,
  onRefreshOffers,
  onMakeOffer,
  isMakingOffer,
  makeOfferError,
  isActive,
  ownerPublicKey,
}: OfferPanelProps) {
  const [modalOpen, setModalOpen] = useState(false);

  const handleMakeOffer = useCallback(
    async (amount: number, tokenAddress: string, expiryTs?: number) => {
      const ok = await onMakeOffer(amount, tokenAddress, expiryTs);
      if (ok) {
        onRefreshOffers();
      }
      return ok;
    },
    [onMakeOffer, onRefreshOffers]
  );

  return (
    <div
      className="rounded-3xl bg-white/5 border border-white/5 p-5 space-y-4"
      data-testid="offer-panel"
    >
      {/* Section heading */}
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-[0.25em] text-white/40 flex items-center gap-2">
          <HandCoins size={14} className="text-brand-400" />
          Offers
        </h3>
        {!isOwner && offers.filter((o) => o.status === "Pending").length > 0 && (
          <span className="text-[9px] font-bold bg-brand-500/20 text-brand-400 border border-brand-500/30 px-2.5 py-1 rounded-full uppercase tracking-widest">
            {offers.filter((o) => o.status === "Pending").length} active
          </span>
        )}
      </div>

      {/* Owner view: manage incoming offers */}
      {isOwner && ownerPublicKey ? (
        <OwnerOfferList
          offers={offers}
          isLoading={isLoadingOffers}
          ownerPublicKey={ownerPublicKey}
          onRefresh={onRefreshOffers}
        />
      ) : (
        <>
          {/* Buyer view: compact offers summary + Make Offer button */}
          {offers.filter((o) => o.status === "Pending").length > 0 && (
            <div
              className="space-y-2 mb-2 max-h-48 overflow-y-auto custom-scrollbar"
              data-testid="buyer-offers-list"
            >
              {offers
                .filter((o) => o.status === "Pending")
                .map((offer) => (
                  <div
                    key={offer.offer_id}
                    className="flex items-center justify-between rounded-2xl bg-white/[0.03] border border-white/5 px-4 py-3"
                    data-testid={`buyer-offer-row-${offer.offer_id}`}
                  >
                    <span className="font-mono text-xs text-white/40">
                      {shortAddr(offer.offerer)}
                    </span>
                    <span className="font-bold text-sm text-brand-400">
                      {stroopsToXlm(offer.amount)}{" "}
                      <span className="text-[10px] text-brand-300/60">
                        {getTokenSymbol(offer.token)}
                      </span>
                    </span>
                  </div>
                ))}
            </div>
          )}

          {/* Make Offer button (only when listing is active) */}
          {isActive && (
            <GuardButton
              onAction={() => setModalOpen(true)}
              actionName="To make an offer"
              data-testid="make-offer-trigger"
              className="w-full flex items-center justify-center gap-2 rounded-2xl bg-white/5 hover:bg-brand-500/20 border border-white/10 hover:border-brand-500/30 py-4 text-sm font-bold text-white/60 hover:text-brand-400 transition-all"
            >
              <HandCoins size={16} />
              Make Offer
            </GuardButton>
          )}
        </>
      )}

      {/* Make Offer Modal */}
      <MakeOfferModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        listingId={listingId}
        defaultToken={listingToken}
        onSubmit={handleMakeOffer}
        isSubmitting={isMakingOffer}
        error={makeOfferError}
      />
    </div>
  );
}
