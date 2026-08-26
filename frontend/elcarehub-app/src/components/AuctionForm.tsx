// ─────────────────────────────────────────────────────────────
// components/AuctionForm.tsx — create-auction form (Issue #527)
//
// Escrows an NFT the connected wallet already owns (collection + token ID —
// mirrors ListingForm.tsx) into a new on-chain auction. Validates duration
// and reserve-price bounds against the live contract configuration before
// ever building a transaction, and surfaces the platform's current
// anti-sniping settings (which are snapshotted into the auction at creation
// time — they are not creator-configurable, see create_auction in
// contracts/soroban-marketplace/src/contract.rs).
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useEffect, useMemo } from "react";
import { useCreateAuction, type CreateAuctionInput } from "@/hooks/useAuctions";
import { useWalletContext } from "@/context/WalletContext";
import { CheckCircle2, Loader2, Plus, Trash2, Info } from "lucide-react";
import { GuardButton } from "./WalletGuard";
import { DEFAULT_TOKEN } from "@/config/tokens";
import { useSupportedTokens } from "@/hooks/useSupportedTokens";
import { getDefaultSupportedToken } from "@/lib/token-support";
import { isValidStellarAddress } from "@/lib/validation";
import {
  getAuctionConfig,
  xlmToStroops,
  stroopsToXlm,
  MIN_AUCTION_DURATION_SECONDS,
  MAX_TOTAL_AUCTION_DURATION_SECONDS,
  type AuctionConfig,
} from "@/lib/contract";

/** Maximum number of royalty recipients (TooManyRecipients contract error). */
const MAX_RECIPIENTS = 4;
const REQUIRED_SPLIT_SUM = 100;
const MIN_DURATION_HOURS = MIN_AUCTION_DURATION_SECONDS / 3600; // 1
const MAX_DURATION_HOURS = MAX_TOTAL_AUCTION_DURATION_SECONDS / 3600; // 720 (30 days)

interface RecipientRow {
  address: string;
  percentage: number;
}

interface FormState {
  collectionAddress: string;
  nftTokenId: number;
  reservePriceXlm: number;
  durationHours: number;
  tokenAddress: string;
  recipients: RecipientRow[];
}

interface FieldErrors {
  collectionAddress?: string;
  nftTokenId?: string;
  reservePriceXlm?: string;
  durationHours?: string;
  tokenAddress?: string;
  recipients?: string;
  recipientRows?: Array<{ address?: string; percentage?: string }>;
}

function validateAuctionForm(
  form: FormState,
  minIncrementStroops: bigint | null
): FieldErrors {
  const errors: FieldErrors = {};

  if (!form.collectionAddress.trim()) {
    errors.collectionAddress = "Collection address is required.";
  } else if (!isValidStellarAddress(form.collectionAddress.trim())) {
    errors.collectionAddress = "Must be a valid Stellar contract address (starts with C).";
  }

  if (!Number.isInteger(form.nftTokenId) || form.nftTokenId < 0) {
    errors.nftTokenId = "Token ID must be a non-negative integer.";
  }

  if (!Number.isFinite(form.reservePriceXlm) || form.reservePriceXlm <= 0) {
    errors.reservePriceXlm = "Reserve price must be greater than 0.";
  } else if (minIncrementStroops !== null) {
    const stroops = xlmToStroops(form.reservePriceXlm);
    if (stroops < minIncrementStroops) {
      errors.reservePriceXlm = `Reserve price must be at least ${stroopsToXlm(
        minIncrementStroops
      )} (the platform's minimum bid increment).`;
    }
  }

  if (!Number.isFinite(form.durationHours) || form.durationHours < MIN_DURATION_HOURS) {
    errors.durationHours = `Duration must be at least ${MIN_DURATION_HOURS} hour${
      MIN_DURATION_HOURS === 1 ? "" : "s"
    }.`;
  } else if (form.durationHours > MAX_DURATION_HOURS) {
    errors.durationHours = `Duration cannot exceed ${MAX_DURATION_HOURS / 24} days.`;
  }

  if (!form.tokenAddress) {
    errors.tokenAddress = "A payment token must be selected.";
  }

  if (form.recipients.length === 0) {
    errors.recipients = "At least one recipient is required.";
  } else if (form.recipients.length > MAX_RECIPIENTS) {
    errors.recipients = `A maximum of ${MAX_RECIPIENTS} recipients is allowed.`;
  } else {
    const rowErrors = form.recipients.map((r) => {
      const rowErr: { address?: string; percentage?: string } = {};
      if (!r.address.trim()) {
        rowErr.address = "Address is required.";
      } else if (!isValidStellarAddress(r.address.trim())) {
        rowErr.address = "Must be a valid Stellar address.";
      }
      if (!Number.isFinite(r.percentage) || r.percentage <= 0) {
        rowErr.percentage = "Must be greater than 0.";
      } else if (r.percentage > REQUIRED_SPLIT_SUM) {
        rowErr.percentage = `Cannot exceed ${REQUIRED_SPLIT_SUM}%.`;
      }
      return rowErr;
    });
    if (rowErrors.some((e) => e.address || e.percentage)) {
      errors.recipientRows = rowErrors;
    }
    const total = form.recipients.reduce((sum, r) => sum + (r.percentage || 0), 0);
    if (Math.round(total) !== REQUIRED_SPLIT_SUM) {
      errors.recipients = `Recipient percentages must sum to exactly ${REQUIRED_SPLIT_SUM}% (currently ${total.toFixed(
        2
      )}%).`;
    }
  }

  return errors;
}

function isFormValid(errors: FieldErrors): boolean {
  const hasTopLevel =
    errors.collectionAddress !== undefined ||
    errors.nftTokenId !== undefined ||
    errors.reservePriceXlm !== undefined ||
    errors.durationHours !== undefined ||
    errors.tokenAddress !== undefined ||
    errors.recipients !== undefined;
  const hasRow =
    errors.recipientRows !== undefined &&
    errors.recipientRows.some((r) => r.address || r.percentage);
  return !hasTopLevel && !hasRow;
}

interface AuctionFormProps {
  onSuccess?: (auctionId: number) => void;
  onCancel?: () => void;
}

export function AuctionForm({ onSuccess, onCancel }: AuctionFormProps) {
  const { publicKey } = useWalletContext();
  const { tokens: availableTokens } = useSupportedTokens();
  const { create, isCreating, progress, error } = useCreateAuction(publicKey);

  const [successId, setSuccessId] = useState<number | null>(null);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [auctionConfig, setAuctionConfig] = useState<AuctionConfig | null>(null);

  const [form, setForm] = useState<FormState>({
    collectionAddress: "",
    nftTokenId: 0,
    reservePriceXlm: 1,
    durationHours: 24,
    tokenAddress: DEFAULT_TOKEN.address,
    recipients: [{ address: publicKey ?? "", percentage: 100 }],
  });

  const hasTokenOptions = availableTokens.length > 0;
  const defaultToken = getDefaultSupportedToken(availableTokens);
  const selectedToken =
    availableTokens.find((t) => t.address === form.tokenAddress) ?? defaultToken;

  useEffect(() => {
    if (availableTokens.length === 0) return;
    if (!availableTokens.some((t) => t.address === form.tokenAddress)) {
      setForm((cur) => ({
        ...cur,
        tokenAddress: getDefaultSupportedToken(availableTokens).address,
      }));
    }
  }, [availableTokens, form.tokenAddress]);

  // Sync connected wallet into recipient[0] once known.
  useEffect(() => {
    if (!publicKey) return;
    setForm((cur) => {
      if (cur.recipients.length !== 1 || cur.recipients[0].address) return cur;
      return { ...cur, recipients: [{ address: publicKey, percentage: 100 }] };
    });
  }, [publicKey]);

  // Fetch live contract bounds (min bid increment, anti-snipe settings) once.
  useEffect(() => {
    let cancelled = false;
    getAuctionConfig()
      .then((cfg) => {
        if (!cancelled) setAuctionConfig(cfg);
      })
      .catch(() => {
        /* Non-fatal — validation falls back to the ">0" check only. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const errors = useMemo(
    () => validateAuctionForm(form, auctionConfig?.minBidIncrementStroops ?? null),
    [form, auctionConfig]
  );
  const formIsValid = useMemo(() => isFormValid(errors), [errors]);

  const updateRecipient = (i: number, patch: Partial<RecipientRow>) => {
    setForm((cur) => {
      const next = [...cur.recipients];
      next[i] = { ...next[i], ...patch };
      return { ...cur, recipients: next };
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitAttempted(true);
    if (!formIsValid) return;

    const input: CreateAuctionInput = {
      collectionAddress: form.collectionAddress.trim(),
      nftTokenId: form.nftTokenId,
      reservePriceXlm: form.reservePriceXlm,
      durationSeconds: Math.round(form.durationHours * 3600),
      recipients: form.recipients.map((r) => ({
        address: r.address.trim(),
        percentage: r.percentage,
      })),
      tokenAddress: form.tokenAddress,
    };

    const id = await create(input);
    if (id !== null) {
      setSuccessId(id);
      onSuccess?.(id);
    }
  };

  if (successId !== null) {
    return (
      <div className="max-w-xl mx-auto flex flex-col items-center gap-6 rounded-3xl border border-green-100 bg-white p-12 text-center shadow-2xl shadow-green-900/5">
        <div className="rounded-full bg-green-50 p-4">
          <CheckCircle2 size={56} className="text-green-500" />
        </div>
        <div className="space-y-2">
          <h3 className="text-3xl font-display font-bold text-gray-900">
            Auction #{successId} Created!
          </h3>
          <p className="text-gray-500 font-inter">
            Your auction is now live on the ELCARE-HUB marketplace.
          </p>
        </div>
        <button
          onClick={onCancel}
          className="w-full rounded-2xl border border-gray-200 bg-white px-6 py-4 text-lg font-semibold text-gray-700 hover:bg-gray-50 transition-all"
        >
          Back to Dashboard
        </button>
      </div>
    );
  }

  const shouldShow = (field: keyof FieldErrors) => submitAttempted && !!errors[field];

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="bg-white rounded-3xl shadow-2xl shadow-brand-900/5 border border-brand-100/50 p-6 md:p-10">
        <header className="mb-10 text-center">
          <h2 className="text-4xl font-display font-bold text-gray-900 mb-2">
            Create Auction
          </h2>
          <p className="text-gray-500 font-inter">
            Escrow an NFT you own and set a reserve price, duration, and payment token.
          </p>
        </header>

        <form onSubmit={handleSubmit} noValidate className="space-y-8">
          <div className="grid gap-6 sm:grid-cols-2">
            {/* Collection address */}
            <div className="space-y-2">
              <label className="block text-sm font-bold text-gray-950 uppercase tracking-wider font-inter">
                Collection Address *
              </label>
              <input
                required
                value={form.collectionAddress}
                onChange={(e) => setForm({ ...form, collectionAddress: e.target.value })}
                aria-invalid={shouldShow("collectionAddress")}
                className={`w-full rounded-2xl border px-5 py-4 text-base font-mono focus:outline-none transition-all shadow-sm ${
                  shouldShow("collectionAddress")
                    ? "border-red-400 bg-red-50/40 focus:border-red-500"
                    : "border-gray-200 bg-gray-50/50 focus:border-brand-500 focus:bg-white"
                }`}
                placeholder="C… collection contract address"
              />
              {shouldShow("collectionAddress") && (
                <p className="text-sm text-red-600" role="alert">{errors.collectionAddress}</p>
              )}
            </div>

            {/* Token ID */}
            <div className="space-y-2">
              <label className="block text-sm font-bold text-gray-950 uppercase tracking-wider font-inter">
                Token ID *
              </label>
              <input
                required
                type="number"
                min={0}
                value={form.nftTokenId}
                onChange={(e) =>
                  setForm({ ...form, nftTokenId: parseInt(e.target.value, 10) || 0 })
                }
                aria-invalid={shouldShow("nftTokenId")}
                className={`w-full rounded-2xl border px-5 py-4 text-base focus:outline-none transition-all shadow-sm font-inter ${
                  shouldShow("nftTokenId")
                    ? "border-red-400 bg-red-50/40 focus:border-red-500"
                    : "border-gray-200 bg-gray-50/50 focus:border-brand-500 focus:bg-white"
                }`}
              />
              {shouldShow("nftTokenId") && (
                <p className="text-sm text-red-600" role="alert">{errors.nftTokenId}</p>
              )}
            </div>

            {/* Reserve price + token selector */}
            <div className="space-y-2">
              <label className="block text-sm font-bold text-gray-950 uppercase tracking-wider font-inter">
                Reserve Price ({selectedToken?.symbol ?? "Token"}) *
              </label>
              <input
                required
                type="number"
                min={0.0000001}
                step="any"
                value={form.reservePriceXlm}
                onChange={(e) =>
                  setForm({ ...form, reservePriceXlm: parseFloat(e.target.value) || 0 })
                }
                aria-invalid={shouldShow("reservePriceXlm")}
                className={`w-full rounded-2xl border px-5 py-4 text-base focus:outline-none transition-all shadow-sm font-inter ${
                  shouldShow("reservePriceXlm")
                    ? "border-red-400 bg-red-50/40 focus:border-red-500"
                    : "border-gray-200 bg-gray-50/50 focus:border-brand-500 focus:bg-white"
                }`}
              />
              {shouldShow("reservePriceXlm") ? (
                <p className="text-sm text-red-600" role="alert">{errors.reservePriceXlm}</p>
              ) : (
                auctionConfig && (
                  <p className="text-xs text-gray-400">
                    Minimum: {stroopsToXlm(auctionConfig.minBidIncrementStroops)}{" "}
                    {selectedToken?.symbol ?? ""}
                  </p>
                )
              )}
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-bold text-gray-950 uppercase tracking-wider font-inter">
                Payment Token *
              </label>
              <select
                required
                id="auction-token-address"
                disabled={!hasTokenOptions}
                value={form.tokenAddress}
                onChange={(e) => setForm({ ...form, tokenAddress: e.target.value })}
                className="w-full appearance-none rounded-2xl border border-gray-200 bg-gray-50/50 px-5 py-4 text-base focus:border-brand-500 focus:bg-white focus:outline-none transition-all shadow-sm font-inter"
              >
                {hasTokenOptions ? (
                  availableTokens.map((token) => (
                    <option key={token.address} value={token.address}>
                      {token.name} ({token.symbol})
                    </option>
                  ))
                ) : (
                  <option value="">No supported tokens available</option>
                )}
              </select>
            </div>

            {/* Duration */}
            <div className="sm:col-span-2 space-y-2">
              <label className="block text-sm font-bold text-gray-950 uppercase tracking-wider font-inter">
                Duration (hours) *
              </label>
              <input
                required
                type="number"
                min={MIN_DURATION_HOURS}
                max={MAX_DURATION_HOURS}
                value={form.durationHours}
                onChange={(e) =>
                  setForm({ ...form, durationHours: parseFloat(e.target.value) || 0 })
                }
                aria-invalid={shouldShow("durationHours")}
                className={`w-full rounded-2xl border px-5 py-4 text-base focus:outline-none transition-all shadow-sm font-inter ${
                  shouldShow("durationHours")
                    ? "border-red-400 bg-red-50/40 focus:border-red-500"
                    : "border-gray-200 bg-gray-50/50 focus:border-brand-500 focus:bg-white"
                }`}
              />
              {shouldShow("durationHours") ? (
                <p className="text-sm text-red-600" role="alert">{errors.durationHours}</p>
              ) : (
                <p className="text-xs text-gray-400">
                  Between {MIN_DURATION_HOURS} hour and {MAX_DURATION_HOURS / 24} days.
                </p>
              )}
            </div>

            {/* Recipients */}
            <div className="sm:col-span-2 space-y-2">
              <label className="block text-sm font-bold text-gray-950 uppercase tracking-wider font-inter">
                Royalty Recipients (must total 100%) *
              </label>
              <div className="space-y-2">
                {form.recipients.map((row, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      value={row.address}
                      onChange={(e) => updateRecipient(i, { address: e.target.value })}
                      placeholder="G… recipient address"
                      className="flex-1 rounded-xl border border-gray-200 bg-gray-50/50 px-4 py-3 font-mono text-xs focus:outline-none focus:border-brand-500 focus:bg-white"
                    />
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={row.percentage}
                      onChange={(e) =>
                        updateRecipient(i, { percentage: parseFloat(e.target.value) || 0 })
                      }
                      className="w-24 rounded-xl border border-gray-200 bg-gray-50/50 px-3 py-3 text-sm focus:outline-none focus:border-brand-500 focus:bg-white"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setForm({
                          ...form,
                          recipients: form.recipients.filter((_, idx) => idx !== i),
                        })
                      }
                      disabled={form.recipients.length <= 1}
                      className="rounded-xl px-2 text-gray-400 hover:text-red-500 disabled:opacity-30"
                      aria-label="Remove recipient"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() =>
                  setForm({
                    ...form,
                    recipients: [...form.recipients, { address: "", percentage: 0 }],
                  })
                }
                disabled={form.recipients.length >= MAX_RECIPIENTS}
                className="flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-700 disabled:opacity-40"
              >
                <Plus size={12} /> Add recipient
              </button>
              {(shouldShow("recipients") || shouldShow("recipientRows")) && (
                <p className="text-sm text-red-600" role="alert">
                  {errors.recipients ?? "Check each recipient row above."}
                </p>
              )}
            </div>
          </div>

          {/* Anti-sniping info — read-only, snapshotted from platform config */}
          {auctionConfig && (
            <div className="flex items-start gap-2 rounded-2xl bg-brand-50/60 px-5 py-4 text-xs text-brand-800">
              <Info size={14} className="mt-0.5 shrink-0" />
              <p>
                Anti-sniping is enabled platform-wide: a bid placed within{" "}
                <strong>{auctionConfig.extensionTrigger}s</strong> of the close extends the
                auction by <strong>{auctionConfig.extensionWindow}s</strong>
                {auctionConfig.maxExtensions > 0
                  ? ` (up to ${auctionConfig.maxExtensions} times)`
                  : " (unlimited times, capped at 30 days total)"}
                . These settings apply automatically and aren&apos;t configurable per auction.
              </p>
            </div>
          )}

          {/* Progress / error */}
          {isCreating && progress && (
            <div className="flex items-center gap-3 rounded-2xl bg-brand-50 px-6 py-4 text-sm font-semibold text-brand-700 animate-pulse">
              <Loader2 size={20} className="animate-spin" />
              {progress}
            </div>
          )}
          {error && (
            <p className="rounded-2xl bg-red-50 px-6 py-4 text-sm font-bold text-red-600 border border-red-100">
              {error}
            </p>
          )}

          {/* Buttons */}
          <div className="flex flex-col sm:flex-row gap-4 pt-4">
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                disabled={isCreating}
                className="flex-1 rounded-2xl border border-gray-200 py-4 text-lg font-semibold text-gray-600 hover:bg-gray-50 transition-all disabled:opacity-50"
              >
                Cancel
              </button>
            )}
            <GuardButton
              type="submit"
              disabled={isCreating || !hasTokenOptions || (submitAttempted && !formIsValid)}
              actionName="to create your auction"
              className="flex-[2] flex items-center justify-center gap-3 rounded-2xl bg-brand-500 py-5 text-xl font-bold text-white shadow-2xl shadow-brand-500/30 hover:bg-brand-600 hover:scale-[1.01] transition-all active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100"
            >
              {isCreating ? (
                <>
                  <Loader2 size={24} className="animate-spin" />
                  {progress || "Processing…"}
                </>
              ) : (
                "Create Auction"
              )}
            </GuardButton>
          </div>
        </form>
      </div>
    </div>
  );
}
