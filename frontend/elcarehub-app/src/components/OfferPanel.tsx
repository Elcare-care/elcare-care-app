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
  Timer,
  ExternalLink,
  Clock,
  Ban,
} from "lucide-react";
import { clsx } from "clsx";
import { Offer, stroopsToXlm, deriveOfferUIStatus, OfferUIStatus } from "@/lib/contract";
import { SUPPORTED_TOKENS, TokenConfig, getTokenConfigByAddress, getNativeTokenConfig } from "@/config/tokens";
import { validateAmountInput, baseToDisplay } from "@/lib/amount";
import { GuardButton } from "@/components/WalletGuard";
import { useAcceptOffer, useRejectOffer } from "@/hooks/useOffers";
import { useModalA11y } from "@/hooks/useModalA11y";
import { StatusAnnouncer } from "@/components/a11y/StatusAnnouncer";
import { TxErrorPanel } from "@/components/TxErrorPanel";
import { useTxLifecycle, txStateLabel } from "@/hooks/useTxLifecycle";
import Link from "next/link";

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortAddr(addr: string): string {
  if (!addr || addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function getTokenSymbol(address: string): string {
  return SUPPORTED_TOKENS.find((t) => t.address === address)?.symbol ?? "Tokens";
}

/** Format seconds remaining until expiry. Returns null when expired. */
function formatCountdown(expiresAtSec: number, nowMs: number): string | null {
  const remainingMs = expiresAtSec * 1000 - nowMs;
  if (remainingMs <= 0) return null;
  const totalSec = Math.floor(remainingMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

/** Returns Tailwind classes + label for an offer UI status badge. */
function getOfferStatusBadgeClass(uiStatus: OfferUIStatus): string {
  switch (uiStatus) {
    case "Pending": return "bg-brand-500/10 text-brand-400 border-brand-500/20";
    case "Accepted": return "bg-mint-500/10 text-mint-400 border-mint-500/20";
    case "Rejected": return "bg-terracotta-500/10 text-terracotta-400 border-terracotta-500/20";
    case "Withdrawn": return "bg-white/5 text-white/30 border-white/10";
    case "Expired": return "bg-amber-500/10 text-amber-400 border-amber-500/20";
    case "Stale": return "bg-yellow-500/10 text-yellow-400 border-yellow-500/20";
    default: return "bg-white/5 text-white/30 border-white/10";
  }
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
  const { dialogRef, titleId, descriptionId } = useModalA11y(isOpen, onClose);
  const [amount, setAmount] = useState("");
  const [tokenAddress, setTokenAddress] = useState(defaultToken);
  const [expiryDate, setExpiryDate] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const amountErrorId = `${titleId}-amount-error`;

  const statusMessage = isSubmitting
    ? "Placing your offer. Please check your wallet for a signature request."
    : success
    ? "Offer placed successfully."
    : localError || error
    ? `Error: ${localError || error}`
    : "";
  const statusPoliteness = !isSubmitting && (localError || error) ? "assertive" : "polite";

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

    // Bigint-safe parse/validate (Issue #521) — rejects malformed input,
    // negative amounts, and excess decimal precision for the selected
    // token instead of a bare `Number(amount)` check (which also silently
    // accepted exponent notation like "1e5").
    const token = getTokenConfigByAddress(tokenAddress) ?? getNativeTokenConfig();
    const result = validateAmountInput(amount, token);
    if (!result.valid || result.baseUnits === null) {
      setLocalError(result.message ?? "Please enter a valid offer amount.");
      return;
    }
    // Re-express as a JS number only at the boundary of the existing
    // numeric `onSubmit` API — the parse/validate step above never
    // touches floating-point arithmetic.
    const amountNum = Number(baseToDisplay(result.baseUnits, token));

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
        aria-describedby={descriptionId}
        data-testid="make-offer-modal"
        tabIndex={-1}
        className="relative w-full max-w-md overflow-hidden rounded-3xl bg-midnight-900 border border-white/10 shadow-2xl outline-none animate-scale-in"
      >
        <StatusAnnouncer message={statusMessage} politeness={statusPoliteness} />

        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/5 p-6">
          <div>
            <h2 id={titleId} className="text-lg font-bold text-white font-display">
              Make an Offer
            </h2>
            <p id={descriptionId} className="text-[11px] text-white/30 mt-0.5">
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
              aria-invalid={!!(localError || error)}
              aria-describedby={localError || error ? amountErrorId : undefined}
              className="w-full rounded-2xl bg-white/5 border border-white/10 px-5 py-4 text-white text-lg font-bold placeholder-white/20 focus:outline-none focus:border-brand-500 transition aria-[invalid=true]:border-terracotta-500"
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
              id={amountErrorId}
              role="alert"
              className="flex items-center gap-2 rounded-xl border border-terracotta-500/20 bg-terracotta-500/10 px-4 py-3 text-xs text-terracotta-400"
              data-testid="offer-modal-error"
            >
              <AlertCircle size={14} aria-hidden="true" />
              {localError || error}
            </div>
          )}

          {/* Success */}
          {success && (
            <div
              role="status"
              className="flex items-center gap-2 rounded-xl border border-mint-500/20 bg-mint-500/10 px-4 py-3 text-xs text-mint-400"
              data-testid="offer-modal-success"
            >
              <CheckCircle size={14} aria-hidden="true" />
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

  // Typed lifecycle for accept/reject actions — gives TxErrorPanel and a
  // tx hash recovery link. Shared across the list so only one action runs
  // at a time (duplicate-submission guard).
  const {
    txState: offerTxState,
    isActive: isOfferTxActive,
    run: runOfferTx,
    reset: resetOfferTx,
  } = useTxLifecycle({ persistKey: `ownerOffers:${ownerPublicKey}` });

  // Tick every second for live expiry countdowns
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const pendingOffers = offers.filter((o) => {
    const uiStatus = deriveOfferUIStatus(o, now);
    return uiStatus === "Pending" || uiStatus === "Stale";
  });
  const otherOffers = offers.filter((o) => {
    const uiStatus = deriveOfferUIStatus(o, now);
    return uiStatus !== "Pending" && uiStatus !== "Stale";
  });

  return (
    <div className="space-y-3" data-testid="owner-offer-list">
      {/* Typed transaction error panel */}
      {offerTxState.state === "error" && offerTxState.error && (
        <TxErrorPanel
          error={offerTxState.error}
          txHash={offerTxState.txHash}
          onRetry={resetOfferTx}
          onDismiss={resetOfferTx}
        />
      )}

      {/* Lifecycle state label while a tx is in-flight */}
      {isOfferTxActive && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-xl border border-brand-500/20 bg-brand-500/10 px-4 py-3 text-xs text-brand-400"
        >
          <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          {txStateLabel(offerTxState.state)}
        </div>
      )}

      {/* Tx hash recovery link */}
      {offerTxState.txHash && !isOfferTxActive && offerTxState.state !== "success" && (
        <p className="text-[10px] text-white/30 text-center">
          Tx:{" "}
          <Link
            href={`/tx/${offerTxState.txHash}`}
            className="font-mono text-brand-400 hover:underline"
            target="_blank"
          >
            {offerTxState.txHash.slice(0, 10)}…
          </Link>
        </p>
      )}

      {/* Legacy string errors from the underlying hooks (connection issues etc.) */}
      {(acceptError || rejectError) && offerTxState.state !== "error" && (
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
              {pendingOffers.map((offer) => {
                const uiStatus = deriveOfferUIStatus(offer, now);
                const isActionable = uiStatus === "Pending" || uiStatus === "Stale";
                return (
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

                    {/* Expiry countdown */}
                    {offer.expires_at != null && (
                      <div
                        className="flex items-center gap-1.5 shrink-0"
                        data-testid={`offer-countdown-${offer.offer_id}`}
                      >
                        <Timer size={12} className="text-white/30" />
                        <span className="text-[10px] font-mono text-white/40">
                          {formatCountdown(offer.expires_at, now) ?? "Expired"}
                        </span>
                      </div>
                    )}

                    {/* Stale warning */}
                    {uiStatus === "Stale" && (
                      <div
                        className="flex items-center gap-1.5 text-yellow-400 text-[10px] shrink-0"
                        data-testid={`offer-stale-${offer.offer_id}`}
                      >
                        <Clock size={12} />
                        <span>Data may be stale</span>
                      </div>
                    )}

                    {/* Accept / Reject — disabled for non-actionable states or while a tx is active */}
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        data-testid={`accept-offer-btn-${offer.offer_id}`}
                        onClick={async () => {
                          const ok = await runOfferTx(
                            () => accept(offer.offer_id),
                            { action: "Accept offer" }
                          );
                          if (ok) onRefresh();
                        }}
                        disabled={!isActionable || isOfferTxActive || isAccepting || isRejecting}
                        aria-disabled={!isActionable}
                        className="flex items-center gap-1.5 rounded-xl bg-mint-500/20 hover:bg-mint-500/30 px-4 py-2.5 text-xs font-bold text-mint-400 border border-mint-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        aria-label={`Accept offer ${offer.offer_id}`}
                      >
                        {isOfferTxActive && isAccepting ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <CheckCircle size={13} />
                        )}
                        Accept
                      </button>
                      <button
                        data-testid={`reject-offer-btn-${offer.offer_id}`}
                        onClick={async () => {
                          const ok = await runOfferTx(
                            () => reject(offer.offer_id),
                            { action: "Reject offer" }
                          );
                          if (ok) onRefresh();
                        }}
                        disabled={!isActionable || isOfferTxActive || isAccepting || isRejecting}
                        aria-disabled={!isActionable}
                        className="flex items-center gap-1.5 rounded-xl bg-white/5 hover:bg-terracotta-500/20 px-4 py-2.5 text-xs font-bold text-white/50 hover:text-terracotta-400 border border-white/10 hover:border-terracotta-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        aria-label={`Reject offer ${offer.offer_id}`}
                      >
                        {isOfferTxActive && isRejecting ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <XCircle size={13} />
                        )}
                        Reject
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Historical offers (accepted / rejected / expired / withdrawn) */}
          {otherOffers.length > 0 && (
            <div className="space-y-2 mt-4">
              <p className="text-[10px] uppercase tracking-[0.25em] font-bold text-white/20">
                Past Offers
              </p>
              {otherOffers.map((offer) => {
                const uiStatus = deriveOfferUIStatus(offer, now);
                return (
                  <div
                    key={offer.offer_id}
                    data-testid={`owner-offer-card-${offer.offer_id}`}
                    className="flex flex-col gap-2 rounded-2xl bg-white/[0.03] border border-white/5 px-4 py-3"
                  >
                    <div className="flex items-center justify-between">
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
                          getOfferStatusBadgeClass(uiStatus)
                        )}
                        data-testid={`offer-status-badge-${offer.offer_id}`}
                      >
                        {uiStatus}
                      </span>
                    </div>
                    {/* Escrow / refund tx hash */}
                    {(offer.escrow_tx_hash || offer.refund_tx_hash) && (
                      <div className="flex flex-col gap-1 mt-1 pl-1">
                        {offer.escrow_tx_hash && (
                          <div
                            className="flex items-center gap-1.5 text-[10px] text-white/30"
                            data-testid={`escrow-tx-${offer.offer_id}`}
                          >
                            <span className="uppercase font-bold tracking-widest">Escrow:</span>
                            <span className="font-mono truncate max-w-[120px]">{offer.escrow_tx_hash.slice(0, 10)}…</span>
                            <a
                              href={`https://stellar.expert/explorer/testnet/tx/${offer.escrow_tx_hash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label="View escrow transaction"
                              className="text-white/20 hover:text-brand-400 transition-colors"
                            >
                              <ExternalLink size={10} />
                            </a>
                          </div>
                        )}
                        {offer.refund_tx_hash && (
                          <div
                            className="flex items-center gap-1.5 text-[10px] text-white/30"
                            data-testid={`refund-tx-${offer.offer_id}`}
                          >
                            <span className="uppercase font-bold tracking-widest">
                              {offer.status === "Accepted" ? "Payment:" : "Refund:"}
                            </span>
                            <span className="font-mono truncate max-w-[120px]">{offer.refund_tx_hash.slice(0, 10)}…</span>
                            <a
                              href={`https://stellar.expert/explorer/testnet/tx/${offer.refund_tx_hash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label="View refund transaction"
                              className="text-white/20 hover:text-mint-400 transition-colors"
                            >
                              <ExternalLink size={10} />
                            </a>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
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
  const [now, setNow] = useState(() => Date.now());

  // Tick for live countdown in buyer view
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

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

  // Active = Pending and not expired
  const activePendingOffers = offers.filter((o) => {
    const uiStatus = deriveOfferUIStatus(o, now);
    return uiStatus === "Pending" || uiStatus === "Stale";
  });

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
        {!isOwner && activePendingOffers.length > 0 && (
          <span className="text-[9px] font-bold bg-brand-500/20 text-brand-400 border border-brand-500/30 px-2.5 py-1 rounded-full uppercase tracking-widest">
            {activePendingOffers.length} active
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
          {activePendingOffers.length > 0 && (
            <div
              className="space-y-2 mb-2 max-h-48 overflow-y-auto custom-scrollbar"
              data-testid="buyer-offers-list"
            >
              {activePendingOffers.map((offer) => (
                <div
                  key={offer.offer_id}
                  className="flex items-center justify-between rounded-2xl bg-white/[0.03] border border-white/5 px-4 py-3"
                  data-testid={`buyer-offer-row-${offer.offer_id}`}
                >
                  <span className="font-mono text-xs text-white/40">
                    {shortAddr(offer.offerer)}
                  </span>
                  <div className="flex items-center gap-2">
                    {offer.expires_at != null && (
                      <span className="text-[10px] font-mono text-white/30">
                        {formatCountdown(offer.expires_at, now) ?? "Expiring"}
                      </span>
                    )}
                    <span className="font-bold text-sm text-brand-400">
                      {stroopsToXlm(offer.amount)}{" "}
                      <span className="text-[10px] text-brand-300/60">
                        {getTokenSymbol(offer.token)}
                      </span>
                    </span>
                  </div>
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
