"use client";

// ─────────────────────────────────────────────────────────────
// components/CheckoutModal.tsx
//
// Issue #310 / #45 — Exact settlement preview in checkout
//
// Changes:
//   • Displays exact base-unit breakdown (item price, protocol
//     fee %, royalty recipients, buyer total)
//   • Fetches fresh listing state before confirming purchase
//   • Invalidates confirmation when price/token/status changed
//   • Errors prevent signing and explain why
//   • Mobile-friendly: all financial info visible without scroll
//   • Stale listing triggers re-confirmation requirement
// ─────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from "react";
import {
  X,
  CreditCard,
  Wallet,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Users,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Listing, getProtocolFee } from "@/lib/contract";
import { useSupportedTokens } from "@/hooks/useSupportedTokens";
import { TokenConfig, getTokenConfigByAddress, baseUnitsToDisplay } from "@/config/tokens";
import { resolveSupportedTokens, getDefaultSupportedToken } from "@/lib/token-support";
import { calculateSettlementPreview, isPreviewStillValid, SettlementPreview } from "@/lib/settlement";
import { useFreshListing, preflightConflictMessage } from "@/hooks/useFreshListing";
import posthog from "posthog-js";
import { useModalA11y } from "@/hooks/useModalA11y";
import { StatusAnnouncer } from "@/components/a11y/StatusAnnouncer";

interface CheckoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  listing: Listing;
  onCryptoPurchase: () => Promise<boolean>;
  onPurchased?: () => void;
  isBuyingCrypto: boolean;
}

type CheckoutStep = "preview" | "confirm" | "processing";

export function CheckoutModal({
  isOpen,
  onClose,
  listing,
  onCryptoPurchase,
  onPurchased,
  isBuyingCrypto,
}: CheckoutModalProps) {
  const { dialogRef, titleId } = useModalA11y(isOpen, onClose);

  // Payment token
  const { tokens: allTokens, isLoading: loadingTokens, error: tokensError } = useSupportedTokens();
  const [selectedToken, setSelectedToken] = useState<TokenConfig | null>(null);
  const [supportedTokens, setSupportedTokens] = useState<TokenConfig[]>([]);

  // Settlement preview
  const [preview, setPreview] = useState<SettlementPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [showRecipients, setShowRecipients] = useState(false);

  // Checkout flow state
  const [step, setStep] = useState<CheckoutStep>("preview");
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);

  // Preflight hook
  const { preflight, isChecking: isPreflighting, conflict, freshListing, reset: resetPreflight } = useFreshListing();

  // ── Reset on open/close ────────────────────────────────────
  useEffect(() => {
    if (!isOpen) {
      setStep("preview");
      setConflictMessage(null);
      setPreviewError(null);
      setPurchaseError(null);
      resetPreflight();
    }
  }, [isOpen, resetPreflight]);

  // ── Initialise tokens + preview ───────────────────────────
  useEffect(() => {
    const init = async () => {
      if (allTokens.length === 0 || !isOpen) return;
      try {
        const tokens = resolveSupportedTokens([]);
        setSupportedTokens(tokens);

        const listingToken = getTokenConfigByAddress(listing.token);
        const defaultToken = listingToken || getDefaultSupportedToken(tokens);
        setSelectedToken(defaultToken);

        const feeBps = await getProtocolFee();
        const p = calculateSettlementPreview(listing, feeBps, defaultToken?.symbol ?? "XLM");
        setPreview(p);
        setPreviewError(null);
      } catch (err) {
        setPreviewError("Unable to compute settlement preview. Please try again.");
      }
    };
    init();
  }, [isOpen, allTokens, listing]);

  // ── Update preview when token changes ─────────────────────
  const handleTokenChange = useCallback(
    async (token: TokenConfig) => {
      setSelectedToken(token);
      if (!preview) return;
      try {
        const feeBps = await getProtocolFee();
        const p = calculateSettlementPreview(listing, feeBps, token.symbol);
        setPreview(p);
      } catch {
        // non-fatal — keep old preview
      }
    },
    [listing, preview]
  );

  // ── Handle "Pay" click ─────────────────────────────────────
  const handlePay = useCallback(async () => {
    if (!preview || !selectedToken) return;

    if (step === "preview") {
      // Step 1: Fetch fresh listing and validate preview
      setStep("confirm");
      setConflictMessage(null);

      const ok = await preflight(listing);
      if (!ok) {
        const msg = conflict ? preflightConflictMessage(conflict) : "Listing state has changed.";
        setConflictMessage(msg);

        // Recalculate with fresh data if we got it
        if (freshListing) {
          try {
            const feeBps = await getProtocolFee();
            const updated = calculateSettlementPreview(freshListing, feeBps, selectedToken.symbol);
            setPreview(updated);
          } catch {
            // keep old preview visible alongside the conflict message
          }
        }
        return;
      }

      // Preview is still valid — show confirmation
      return;
    }

    if (step === "confirm") {
      // Step 2: Final double-check and sign
      if (!preview.listingActive) {
        setConflictMessage("This listing is no longer active.");
        setStep("preview");
        return;
      }

      // Validate the preview is still coherent with current listing
      const stillValid = isPreviewStillValid(preview, listing);
      if (!stillValid) {
        setConflictMessage("The listing details changed while you were reviewing. Please confirm the updated amounts.");
        setStep("preview");
        return;
      }

      setStep("processing");
      setPurchaseError(null);
      const success = await onCryptoPurchase();
      if (success) {
        posthog.capture("Purchase Successful", {
          listing_id: listing.listing_id,
          buyer_total_xlm: preview.buyerTotalDisplay,
          protocol_fee_bps: preview.protocolFeeBps,
          method: "crypto",
        });
        onPurchased?.();
        onClose();
        setStep("preview");
      } else {
        setPurchaseError("Purchase could not be completed. Check your wallet for a rejected or failed signature, then try again.");
        setStep("confirm");
      }
    }
  }, [preview, selectedToken, step, listing, preflight, conflict, freshListing, onCryptoPurchase, onPurchased, onClose]);

  if (!isOpen || !selectedToken) return null;

  const statusMessage = conflictMessage
    ? `Conflict: ${conflictMessage}`
    : purchaseError
    ? `Error: ${purchaseError}`
    : previewError
    ? `Error: ${previewError}`
    : isPreflighting
    ? "Verifying listing is still available…"
    : step === "processing" || isBuyingCrypto
    ? "Processing your purchase. Please check your wallet for a signature request."
    : "";
  const statusPoliteness =
    (conflictMessage || purchaseError || previewError) && !isPreflighting ? "assertive" : "polite";

  const buttonLabel = () => {
    if (step === "processing" || isBuyingCrypto) return "Processing…";
    if (step === "confirm") return `Confirm & Pay ${preview?.buyerTotalDisplay ?? ""} ${selectedToken.symbol}`;
    return `Review & Pay ${preview?.itemPriceDisplay ?? ""} ${selectedToken.symbol}`;
  };

  const isButtonDisabled = step === "processing" || isBuyingCrypto || isPreflighting || !!previewError;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
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
        data-testid="checkout-modal"
        tabIndex={-1}
        className="relative w-full max-w-md overflow-hidden rounded-3xl bg-white shadow-2xl animate-scale-in outline-none"
      >
        <StatusAnnouncer message={statusMessage} politeness={statusPoliteness} />

        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 p-6">
          <h2 id={titleId} className="font-display text-xl font-bold text-gray-900">
            {step === "confirm" ? "Confirm Purchase" : "Checkout"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close checkout"
            className="rounded-full p-2 text-gray-700 hover:bg-gray-100 hover:text-gray-900 transition"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5 max-h-[80vh] overflow-y-auto">

          {/* Conflict / error banner */}
          {conflictMessage && (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4"
            >
              <AlertTriangle size={18} className="text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-amber-800">{conflictMessage}</p>
                <p className="text-xs text-amber-700 mt-1">
                  Review the updated details below before confirming.
                </p>
              </div>
              <button
                type="button"
                onClick={() => { setConflictMessage(null); setStep("preview"); resetPreflight(); }}
                className="rounded-full p-1 hover:bg-amber-100 transition"
                aria-label="Dismiss"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          )}

          {/* Preview error */}
          {previewError && (
            <div role="alert" className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
              <AlertTriangle size={18} className="text-red-600 shrink-0" aria-hidden="true" />
              <p className="text-sm text-red-800">{previewError}</p>
            </div>
          )}

          {/* Purchase failure */}
          {purchaseError && (
            <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
              <AlertTriangle size={18} className="text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-sm text-red-800">{purchaseError}</p>
            </div>
          )}

          {/* Token selection */}
          <div className="space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">Payment Token</h3>
            {loadingTokens ? (
              <div className="flex items-center gap-2 text-gray-400 text-sm">
                <Loader2 className="animate-spin" size={16} aria-hidden="true" />
                Loading tokens…
              </div>
            ) : tokensError ? (
              <p className="text-red-500 text-sm">{tokensError}</p>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {supportedTokens.map((token) => (
                  <button
                    key={token.address}
                    type="button"
                    onClick={() => handleTokenChange(token)}
                    className={`flex items-center justify-between p-3 rounded-2xl border-2 transition-all ${
                      selectedToken.address === token.address
                        ? "border-brand-500 bg-brand-50 text-brand-600"
                        : "border-gray-100 hover:border-gray-200 text-gray-600"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center font-bold text-gray-700 text-sm">
                        {token.symbol.charAt(0)}
                      </div>
                      <div className="text-left">
                        <p className="font-semibold text-sm">{token.symbol}</p>
                        <p className="text-xs text-gray-400">{token.name}</p>
                      </div>
                    </div>
                    {selectedToken.address === token.address && (
                      <CheckCircle2 size={18} aria-hidden="true" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Settlement preview */}
          {preview && !previewError && (
            <div className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">Settlement Breakdown</h3>
              <div className="rounded-2xl bg-gray-50 p-4 space-y-2.5 text-sm">

                {/* Item price */}
                <div className="flex justify-between items-center">
                  <span className="text-gray-600">Item Price</span>
                  <span className="font-semibold text-gray-900">
                    {preview.itemPriceDisplay} <span className="text-gray-400">{selectedToken.symbol}</span>
                  </span>
                </div>

                {/* Protocol fee */}
                <div className="flex justify-between items-center">
                  <span className="text-gray-600">
                    Protocol Fee ({preview.protocolFeePercent}%)
                  </span>
                  <span className="font-semibold text-gray-900">
                    {preview.protocolFeeDisplay} <span className="text-gray-400">{selectedToken.symbol}</span>
                  </span>
                </div>

                {/* Royalties — collapsible when recipients present */}
                {preview.recipients.length > 0 ? (
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowRecipients((v) => !v)}
                      className="flex w-full justify-between items-center text-gray-600 hover:text-gray-800 transition"
                    >
                      <span className="flex items-center gap-1.5">
                        <Users size={13} aria-hidden="true" />
                        Royalties ({preview.recipients.length} recipient{preview.recipients.length !== 1 ? "s" : ""})
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="font-semibold text-gray-900">
                          {preview.royaltyTotalDisplay} <span className="text-gray-400">{selectedToken.symbol}</span>
                        </span>
                        {showRecipients ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
                      </span>
                    </button>
                    {showRecipients && (
                      <ul className="mt-2 space-y-1.5 pl-5 border-l border-gray-200">
                        {preview.recipients.map((r) => (
                          <li key={r.address} className="flex justify-between text-xs text-gray-500">
                            <span
                              className="truncate max-w-[160px] font-mono"
                              title={r.address}
                            >
                              {r.address.slice(0, 8)}…{r.address.slice(-6)} ({r.percentage}%)
                            </span>
                            <span className="shrink-0 ml-2">
                              {r.amountDisplay} {selectedToken.symbol}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : (
                  <div className="flex justify-between items-center">
                    <span className="text-gray-600">Royalties</span>
                    <span className="text-gray-400 text-xs">None</span>
                  </div>
                )}

                {/* Divider */}
                <div className="border-t border-gray-200" />

                {/* Buyer total */}
                <div className="flex justify-between items-center">
                  <span className="font-bold text-gray-900">You Pay</span>
                  <span className="font-display text-xl font-bold text-brand-600">
                    {preview.buyerTotalDisplay} <span className="text-lg">{selectedToken.symbol}</span>
                  </span>
                </div>

                {/* Seller proceeds (informational) */}
                <div className="flex justify-between items-center text-xs text-gray-400 border-t border-gray-100 pt-2">
                  <span>Seller receives</span>
                  <span>{preview.sellerProceedsDisplay} {selectedToken.symbol}</span>
                </div>
              </div>
            </div>
          )}

          {/* Payment method */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">Payment Method</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-brand-500 bg-brand-50 p-4 text-brand-600">
                <Wallet size={22} aria-hidden="true" />
                <span className="text-sm font-semibold">Crypto</span>
              </div>
              <div className="relative flex flex-col items-center gap-2 rounded-2xl border-2 border-gray-100 p-4 text-gray-400 cursor-not-allowed opacity-60 select-none">
                <CreditCard size={22} aria-hidden="true" />
                <span className="text-sm font-semibold">Credit Card</span>
                <span className="absolute -top-2 right-2 rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-orange-600">
                  Soon
                </span>
              </div>
            </div>

            {/* Preflight spinner */}
            {isPreflighting && (
              <div className="flex items-center justify-center gap-2 text-sm text-gray-500 py-2">
                <RefreshCw size={14} className="animate-spin" aria-hidden="true" />
                Verifying listing is still available…
              </div>
            )}

            {/* Main CTA */}
            <button
              type="button"
              data-testid="checkout-pay-button"
              onClick={handlePay}
              disabled={isButtonDisabled}
              className="mt-1 flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-500 py-5 font-bold text-white shadow-lg shadow-brand-500/20 hover:bg-brand-600 transition-all disabled:opacity-50"
            >
              {step === "processing" || isBuyingCrypto ? (
                <>
                  <Loader2 className="animate-spin" size={18} aria-hidden="true" />
                  Processing…
                </>
              ) : (
                buttonLabel()
              )}
            </button>

            {/* Confirmation hint */}
            {step === "confirm" && !conflictMessage && (
              <p className="text-center text-xs text-gray-500">
                The listing has been verified. Click above to finalise and sign.
              </p>
            )}

            {/* Preview stale note */}
            {preview && (
              <p className="text-center text-[11px] text-gray-400">
                Preview computed at {new Date(preview.computedAt).toLocaleTimeString()}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
