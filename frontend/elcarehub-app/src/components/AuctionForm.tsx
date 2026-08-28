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

import { useState, useRef, useEffect } from "react";
import Image from "next/image";
import { useCreateAuction } from "@/hooks/useAuctions";
import { useIpfsUpload } from "@/hooks/useIpfsUpload";
import { useWalletContext } from "@/context/WalletContext";
import { Upload, CheckCircle, Loader2, XCircle, RotateCcw } from "lucide-react";
import { GuardButton } from "./WalletGuard";
import { IpfsMetadataPreview } from "./IpfsMetadataPreview";
import { DEFAULT_TOKEN } from "@/config/tokens";
import { useSupportedTokens } from "@/hooks/useSupportedTokens";
import { getDefaultSupportedToken } from "@/lib/token-support";
import { ART_CATEGORIES } from "./ListingForm";
import { validateImageFile, ImageValidationResult } from "@/lib/ipfs";

interface AuctionFormProps {
  onSuccess?: (auctionId: number) => void;
  onCancel?: () => void;
}

export function AuctionForm({ onSuccess, onCancel }: AuctionFormProps) {
  const { publicKey } = useWalletContext();
  const { tokens: availableTokens } = useSupportedTokens();
  const { create, isCreating, progress: createProgress, error: createError } = useCreateAuction(publicKey);
  const ipfsUpload = useIpfsUpload();

  const [successId, setSuccessId] = useState<number | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: "",
    description: "",
    artistName: "",
    year: new Date().getFullYear().toString(),
    category: ART_CATEGORIES[0],
    reservePriceXlm: 1,
    durationHours: 24,
    tokenAddress: DEFAULT_TOKEN.address,
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

  // Issue #530: run client-side file validation (MIME/size/dimensions) at
  // the moment a file is selected, regardless of whether it came from the
  // file picker or a drag-and-drop — every entry point must be validated.
  const handleFile = async (file: File) => {
    ipfsUpload.reset();
    setFileError(null);
    const validation: ImageValidationResult = await validateImageFile(file);
    if (!validation.valid) {
      setFileError(validation.messages.join(" "));
      setSelectedFile(null);
      setPreview(null);
      return;
    }
    setSelectedFile(file);
    setPreview(URL.createObjectURL(file));
  };

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

  /**
   * Parses the raw reserve-price input using bigint arithmetic (lib/amount.ts)
   * instead of a bare `parseFloat`, rejecting malformed input and excess
   * decimal precision for the selected token up front.
   */
  const handleReservePriceChange = (raw: string, token: TokenConfig) => {
    if (raw.trim() === "") {
      setReservePriceError(null);
      setForm((cur) => ({ ...cur, reservePriceXlm: NaN }));
      return;
    }

    const result = validateAmountInput(raw, token);
    if (result.valid && result.baseUnits !== null) {
      setReservePriceError(null);
      setForm((cur) => ({
        ...cur,
        reservePriceXlm: Number(baseToDisplay(result.baseUnits!, token)),
      }));
    } else {
      setReservePriceError(result.message);
      setForm((cur) => ({ ...cur, reservePriceXlm: NaN }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile || fileError) return;

    // Step 1: validate + upload image and metadata to IPFS, then verify the
    // returned CIDs actually resolve to the submitted content. The on-chain
    // transaction is only ever attempted once this pipeline reaches
    // "success" — a failed or unverified upload never reaches step 2.
    const uploadResult = await ipfsUpload.start({
      imageFile: selectedFile,
      name: form.title,
      buildMetadata: (imageCid) => ({
        title: form.title,
        description: form.description,
        artist: form.artistName,
        image: imageCid ?? "",
        year: form.year,
        category: form.category,
      }),
    });
    if (!uploadResult) return;

    // Step 2: create the on-chain auction using the verified metadata CID.
    const id = await create({
      ...form,
      imageFile: selectedFile,
      verifiedMetadataCid: uploadResult.metadataCid,
    });
    if (id !== null) {
      setSuccessId(id);
      onSuccess?.(id);
    }
  };

  const isUploading = ipfsUpload.isActive;
  const isBusy = isUploading || isCreating;
  const progress = isUploading ? ipfsUpload.progressLabel : createProgress;

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

        <form onSubmit={handleSubmit} className="space-y-8">
          {/* Image upload */}
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileRef.current?.click()}
            className="group relative flex flex-col items-center justify-center rounded-3xl border-2 border-dashed border-brand-200 bg-brand-50/30 p-12 text-center cursor-pointer hover:border-brand-400 hover:bg-brand-50/60 transition-all"
          >
            {preview ? (
              <div className="relative h-64 w-full">
                <Image
                  src={preview}
                  alt="Preview"
                  fill
                  className="object-contain rounded-2xl"
                  unoptimized
                />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center rounded-2xl transition-opacity">
                  <p className="text-white text-base font-bold underline underline-offset-4">
                    Click to change
                  </p>
                </div>
              </div>
            ) : (
              <div className="py-4">
                <div className="mx-auto w-16 h-16 rounded-full bg-brand-100 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                  <Upload size={32} className="text-brand-500" />
                </div>
                <p className="text-lg font-semibold text-brand-950 font-display">
                  Select Artwork
                </p>
                <p className="mt-1 text-sm text-brand-400 font-inter">
                  JPEG, PNG, GIF, WEBP or SVG — max 20 MB
                </p>
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
          </div>
          {fileError && (
            <p className="text-sm text-red-600" role="alert">
              {fileError}
            </p>
          )}

          {/* Fields */}
          <div className="grid gap-6 sm:grid-cols-2">

            {/* Title */}
            <div className="sm:col-span-2 space-y-2">
              <label className="block text-sm font-bold text-gray-950 uppercase tracking-wider font-inter">
                Title *
              </label>
              <input
                required
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="w-full rounded-2xl border border-gray-200 bg-gray-50/50 px-5 py-4 text-base focus:border-brand-500 focus:bg-white focus:outline-none transition-all shadow-sm font-inter"
                placeholder="e.g. Echoes of the Serengeti"
              />
            </div>

            <div className="sm:col-span-2 space-y-2">
              <label className="block text-sm font-bold text-gray-950 uppercase tracking-wider font-inter">
                Description
              </label>
              <textarea
                rows={3}
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                className="w-full rounded-2xl border border-gray-200 bg-gray-50/50 px-5 py-4 text-base focus:border-brand-500 focus:bg-white focus:outline-none transition-all shadow-sm font-inter"
                placeholder="Describe the soul of this artwork…"
              />
            </div>

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

          {/* Upload pipeline progress — validate → upload image → upload
              metadata → verify (Issue #530). Distinct from the on-chain
              transaction progress reported by useCreateAuction. */}
          {isUploading && progress && (
            <div className="flex items-center justify-between gap-3 rounded-2xl bg-brand-50 px-6 py-4 text-sm font-semibold text-brand-700">
              <span className="flex items-center gap-3">
                <Loader2 size={20} className="animate-spin" />
                {progress}
              </span>
              <button
                type="button"
                onClick={ipfsUpload.cancel}
                className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold text-brand-700 hover:bg-brand-100 transition-all"
              >
                <XCircle size={14} />
                Cancel
              </button>
            </div>
          )}
          {isCreating && !isUploading && createProgress && (
            <div className="flex items-center gap-3 rounded-2xl bg-brand-50 px-6 py-4 text-sm font-semibold text-brand-700 animate-pulse">
              <Loader2 size={20} className="animate-spin" />
              {createProgress}
            </div>
          )}

          {/* Upload errors — distinguishes validation, upload, verification
              and cancellation failures, and offers a resumable retry. */}
          {ipfsUpload.state === "error" && ipfsUpload.error && (
            <div className="flex items-start justify-between gap-3 rounded-2xl bg-red-50 px-6 py-4 text-sm border border-red-100">
              <div>
                <p className="font-bold text-red-700">
                  {ipfsUpload.error.kind === "verification"
                    ? "Verification failed"
                    : ipfsUpload.error.kind === "cancelled"
                    ? "Upload cancelled"
                    : ipfsUpload.error.kind === "validation"
                    ? "Invalid metadata"
                    : "Upload failed"}
                </p>
                <p className="text-red-600 mt-0.5">{ipfsUpload.error.message}</p>
              </div>
              {ipfsUpload.error.kind !== "cancelled" && (
                <button
                  type="button"
                  onClick={() => ipfsUpload.retry()}
                  className="flex shrink-0 items-center gap-1.5 rounded-xl bg-red-100 px-3 py-2 text-xs font-bold text-red-700 hover:bg-red-200 transition-all"
                >
                  <RotateCcw size={14} />
                  Retry
                </button>
              )}
            </div>
          )}
          {createError && (
            <p className="rounded-2xl bg-red-50 px-6 py-4 text-sm font-bold text-red-600 border border-red-100">
              {createError}
            </p>
          )}

          {/* Verified upload preview — confirms the fields the indexer will
              actually store (title/description/artist) before the on-chain
              transaction is submitted. */}
          {ipfsUpload.state === "success" && ipfsUpload.metadataResult && (
            <IpfsMetadataPreview
              cid={ipfsUpload.metadataResult.cid}
              metadata={ipfsUpload.metadata}
            />
          )}

          {/* Buttons */}
          <div className="flex flex-col sm:flex-row gap-4 pt-4">
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                disabled={isBusy}
                className="flex-1 rounded-2xl border border-gray-200 py-4 text-lg font-semibold text-gray-600 hover:bg-gray-50 transition-all disabled:opacity-50"
              >
                Cancel
              </button>
            )}
            <GuardButton
              type="submit"
              disabled={isBusy || !hasTokenOptions || !selectedFile || !!fileError}
              actionName="to create your auction"
              className="flex-[2] flex items-center justify-center gap-3 rounded-2xl bg-brand-500 py-5 text-xl font-bold text-white shadow-2xl shadow-brand-500/30 hover:bg-brand-600 hover:scale-[1.01] transition-all active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100"
            >
              {isBusy ? (
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
