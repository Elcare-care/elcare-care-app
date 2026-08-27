// ─────────────────────────────────────────────────────────────
// components/ListingForm.tsx — create and edit listing form
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useCreateListing, useUpdateListing } from "@/hooks/useMarketplace";
import { useWalletContext } from "@/context/WalletContext";
import { Upload, CheckCircle, Loader2, Save, ShieldCheck, ShieldAlert, X } from "lucide-react";
import { GuardButton } from "./WalletGuard";
import { ArtworkMetadata, fetchMetadata } from "@/lib/ipfs";
import { Listing, stroopsToXlm, checkAndApproveMarketplace, isApprovedForAll, getProtocolFee } from "@/lib/contract";
import { getCollectionMetadata } from "@/lib/launchpad";
import { DEFAULT_TOKEN } from "@/config/tokens";
import { useSupportedTokens } from "@/hooks/useSupportedTokens";
import { ensureTokenOption, getDefaultSupportedToken } from "@/lib/token-support";
import posthog from "posthog-js";
import { isValidStellarAddress } from "@/lib/validation";
import { config } from "@/lib/config";
import { useTxLifecycle, txStateLabel } from "@/hooks/useTxLifecycle";
import { TxErrorPanel } from "@/components/TxErrorPanel";
import Link from "next/link";
import { RoyaltySplitEditor, validateRecipients } from "@/components/RoyaltySplitEditor";

export const ART_CATEGORIES = [
  "Painting",
  "Sculpture",
  "Photography",
  "Digital Art",
  "Textile",
  "Jewelry",
  "Other",
];

// ── Contract constraint constants (mirrors soroban-marketplace/src/types.rs) ──
/** Minimum price in XLM (1 stroop = 0.0000001 XLM). */
export const MIN_PRICE_XLM = 0.0000001;
/** Maximum price in XLM (i128 max / 10^7, practical upper-bound). */
export const MAX_PRICE_XLM = 9_223_372_036_854.7758;
/** Maximum number of royalty recipients (TooManyRecipients = 8). */
export const MAX_RECIPIENTS = 4;
/** Royalty percentages across all recipients must sum to exactly 100. */
export const REQUIRED_SPLIT_SUM = 100;

export interface RecipientInput {
  address: string;
  percentage: number;
}

interface FormState {
  metadataCid: string;
  collectionAddress: string;
  nftTokenId: number;
  quantity: number;
  price: number;
  tokenAddress: string;
  recipients: RecipientInput[];
}

interface FieldErrors {
  metadataCid?: string;
  collectionAddress?: string;
  nftTokenId?: string;
  quantity?: string;
  price?: string;
  tokenAddress?: string;
  recipients?: string;
  recipientRows?: Array<{ address?: string; percentage?: string }>;
}

interface ListingFormProps {
  listing?: Listing; // If provided, we are in EDIT mode
  onSuccess?: (listingId: number) => void;
  onCancel?: () => void;
}

// ── Draft persistence (create mode only) ─────────────────────
// Mirrors CollectionForm's localStorage draft pattern so an in-progress
// listing — including its royalty split — survives a page reload before
// the creator has signed anything.

const LISTING_DRAFT_KEY = "elcarehub:listing-draft";

interface ListingDraft {
  metadataCid: string;
  collectionAddress: string;
  nftTokenId: number;
  price: number;
  tokenAddress: string;
  recipients: RecipientInput[];
}

function loadListingDraft(publicKey: string | null): ListingDraft | null {
  if (!publicKey || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(`${LISTING_DRAFT_KEY}:${publicKey}`);
    if (!raw) return null;
    return JSON.parse(raw) as ListingDraft;
  } catch {
    return null;
  }
}

function saveListingDraft(publicKey: string, draft: ListingDraft): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(`${LISTING_DRAFT_KEY}:${publicKey}`, JSON.stringify(draft));
}

function clearListingDraft(publicKey: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(`${LISTING_DRAFT_KEY}:${publicKey}`);
}

// ── Validation ────────────────────────────────────────────────

/**
 * Validates all form fields against the contract constraints.
 * Returns an error map; an empty object means the form is valid.
 */
export function validateListingForm(form: FormState): FieldErrors {
  const errors: FieldErrors = {};

  // Metadata CID — must be a valid IPFS CIDv0 or CIDv1
  const cidError = validateIpfsCid(form.metadataCid);
  if (cidError) {
    errors.metadataCid = cidError;
  }

  // Collection address — must be a non-empty, valid Stellar address
  if (!form.collectionAddress.trim()) {
    errors.collectionAddress = "Collection address is required.";
  } else if (!isValidStellarAddress(form.collectionAddress.trim())) {
    errors.collectionAddress = "Must be a valid Stellar contract address (starts with C).";
  }

  // NFT Token ID — must be a non-negative integer
  if (!Number.isInteger(form.nftTokenId) || form.nftTokenId < 0) {
    errors.nftTokenId = "Token ID must be a non-negative integer.";
  }

  // Price — must be within contract bounds (price > 0, price ≤ MAX)
  if (!Number.isFinite(form.price) || form.price <= 0) {
    errors.price = `Price must be greater than 0.`;
  } else if (form.price < MIN_PRICE_XLM) {
    errors.price = `Price must be at least ${MIN_PRICE_XLM} (1 stroop).`;
  } else if (form.price > MAX_PRICE_XLM) {
    errors.price = `Price exceeds the maximum allowed value.`;
  }

  // Token address — must be selected
  if (!form.tokenAddress) {
    errors.tokenAddress = "A payment token must be selected.";
  }

  // Recipients — must have 1–4 rows, each a valid & non-duplicate address, and
  // sum to exactly 100%. Delegates to the shared RoyaltySplitEditor validator
  // so the split editor's inline errors and the form's submit gate always
  // agree (and both mirror the contract's validate_recipients invariants).
  const recipientsValidation = validateRecipients(form.recipients, MAX_RECIPIENTS);
  if (recipientsValidation.summary) {
    errors.recipients = recipientsValidation.summary;
  }
  const hasRecipientRowErrors = recipientsValidation.rows.some(
    (r) => r.address !== undefined || r.percentage !== undefined
  );
  if (hasRecipientRowErrors) {
    errors.recipientRows = recipientsValidation.rows;
  }

  return errors;
}

export function isFormValid(errors: FieldErrors): boolean {
  const hasTopLevelError =
    errors.metadataCid !== undefined ||
    errors.collectionAddress !== undefined ||
    errors.nftTokenId !== undefined ||
    errors.price !== undefined ||
    errors.tokenAddress !== undefined ||
    errors.recipients !== undefined;

  const hasRowError =
    errors.recipientRows !== undefined &&
    errors.recipientRows.some(
      (r) => r.address !== undefined || r.percentage !== undefined
    );

  return !hasTopLevelError && !hasRowError;
}

export function ListingForm({ listing, onSuccess, onCancel }: ListingFormProps) {
  const isEdit = !!listing;
  const { publicKey } = useWalletContext();
  const { tokens: availableTokens } = useSupportedTokens();

  const { create, isCreating, progress: createProgress, error: createError } =
    useCreateListing(publicKey);
  const { update, isUpdating, progress: updateProgress, error: updateError } =
    useUpdateListing(publicKey);

  // Typed lifecycle — surfaces wallet-rejection vs chain-failure in TxErrorPanel
  // and provides a tx hash recovery link after submission.
  const {
    txState: listingTxState,
    isActive: isListingTxActive,
    run: runListingTx,
    reset: resetListingTx,
  } = useTxLifecycle({
    persistKey: isEdit
      ? `updateListing:${listing?.listing_id}`
      : "createListing",
    action: isEdit ? "Update listing" : "Create listing",
  });

  const [form, setForm] = useState<FormState>({
    metadataCid: "",
    collectionAddress: "",
    nftTokenId: 0,
    price: 10,
    tokenAddress: DEFAULT_TOKEN.address,
    recipients: [{ address: publicKey ?? "", percentage: 100 }],
  });
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [successId, setSuccessId] = useState<number | null>(null);
  const [currentMetadata, setCurrentMetadata] = useState<ArtworkMetadata | null>(null);
  const [isFetchingMetadata, setIsFetchingMetadata] = useState(false);

  // ── Draft persistence (create mode only) ──────────────────────────────
  const [hasDraft, setHasDraft] = useState(false);

  // ── Collection royalty default + protocol fee (Issue #529) ───────────
  // Seeds the split editor with the collection's single-receiver royalty
  // default, and shows the protocol fee as contextual info alongside the
  // recipient split (the protocol fee is deducted separately on-chain and
  // is not part of the 100% recipient split).
  const [collectionDefault, setCollectionDefault] = useState<{ address: string; bps: number } | null>(null);
  const [protocolFeeBps, setProtocolFeeBps] = useState<number | undefined>(undefined);

  // ── Marketplace approval state ────────────────────────────────────────
  // Before listing, the marketplace must have operator approval on the
  // selected collection so it can call transfer_from on behalf of the seller.

  /** `null` = not yet checked, `true` = approved, `false` = not approved */
  const [approvalStatus, setApprovalStatus] = useState<boolean | null>(null);
  const [isCheckingApproval, setIsCheckingApproval] = useState(false);
  const [isApprovingMarketplace, setIsApprovingMarketplace] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const tokenOptions = listing
    ? ensureTokenOption(availableTokens, form.tokenAddress)
    : availableTokens;
  const hasTokenOptions = tokenOptions.length > 0;
  const defaultToken = getDefaultSupportedToken(tokenOptions);
  const selectedToken =
    tokenOptions.find((token) => token.address === form.tokenAddress) || defaultToken;

  const errors = useMemo(() => validateListingForm(form), [form]);
  const formIsValid = useMemo(() => isFormValid(errors), [errors]);

  // Load existing data if in edit mode
  useEffect(() => {
    if (listing) {
      setIsFetchingMetadata(true);
      fetchMetadata(listing.metadata_cid ?? "")
        .then((meta) => {
          setCurrentMetadata(meta);
          const existingRecipients =
            listing.recipients && listing.recipients.length > 0
              ? listing.recipients.map((r) => ({
                  address: r.address,
                  percentage: r.percentage,
                }))
              : [{ address: listing.artist, percentage: 100 }];
          setForm({
            metadataCid: listing.metadata_cid ?? "",
            collectionAddress: listing.collection,
            nftTokenId: Number(listing.token_id),
            price: parseFloat(stroopsToXlm(listing.price)),
            tokenAddress: listing.token,
            recipients: existingRecipients,
          });
        })
        .finally(() => setIsFetchingMetadata(false));
    }
  }, [listing]);

  // Sync default publicKey into recipient[0] on create mode when wallet connects
  useEffect(() => {
    if (!isEdit && publicKey && form.recipients[0]?.address === "") {
      setForm((cur) => ({
        ...cur,
        recipients: [{ address: publicKey, percentage: 100 }, ...cur.recipients.slice(1)],
      }));
    }
  }, [publicKey, isEdit]);

  // Snap to valid token when token list loads (create mode only)
  useEffect(() => {
    if (isEdit || tokenOptions.length === 0) return;
    if (!tokenOptions.some((token) => token.address === form.tokenAddress)) {
      setForm((current) => ({
        ...current,
        tokenAddress: getDefaultSupportedToken(tokenOptions).address,
      }));
    }
  }, [form.tokenAddress, isEdit, tokenOptions]);

  // ── Draft persistence (create mode only) ──────────────────────────────
  // Detect a saved draft once the wallet connects.
  useEffect(() => {
    if (isEdit || !publicKey) return;
    if (loadListingDraft(publicKey)) setHasDraft(true);
  }, [isEdit, publicKey]);

  const restoreDraft = useCallback(() => {
    if (!publicKey) return;
    const draft = loadListingDraft(publicKey);
    if (!draft) return;
    setForm((prev) => ({ ...prev, ...draft }));
    setHasDraft(false);
  }, [publicKey]);

  const discardDraft = useCallback(() => {
    if (!publicKey) return;
    clearListingDraft(publicKey);
    setHasDraft(false);
  }, [publicKey]);

  // Auto-save the draft (including the recipient split) whenever it changes.
  useEffect(() => {
    if (isEdit || !publicKey) return;
    saveListingDraft(publicKey, {
      metadataCid: form.metadataCid,
      collectionAddress: form.collectionAddress,
      nftTokenId: form.nftTokenId,
      price: form.price,
      tokenAddress: form.tokenAddress,
      recipients: form.recipients,
    });
  }, [
    isEdit,
    publicKey,
    form.metadataCid,
    form.collectionAddress,
    form.nftTokenId,
    form.price,
    form.tokenAddress,
    form.recipients,
  ]);

  // ── Collection royalty default (seeds the split editor) ───────────────
  useEffect(() => {
    const addr = form.collectionAddress.trim();
    if (!isValidStellarAddress(addr)) {
      setCollectionDefault(null);
      return;
    }
    let cancelled = false;
    getCollectionMetadata(addr)
      .then((meta) => {
        if (!cancelled && meta.royaltyReceiver) {
          setCollectionDefault({ address: meta.royaltyReceiver, bps: meta.royaltyBps });
        } else if (!cancelled) {
          setCollectionDefault(null);
        }
      })
      .catch(() => {
        if (!cancelled) setCollectionDefault(null);
      });
    return () => {
      cancelled = true;
    };
  }, [form.collectionAddress]);

  // ── Protocol fee (contextual info alongside the split editor) ─────────
  useEffect(() => {
    let cancelled = false;
    getProtocolFee()
      .then((bps) => {
        if (!cancelled) setProtocolFeeBps(bps);
      })
      .catch(() => {
        if (!cancelled) setProtocolFeeBps(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Approval pre-check (create mode only) ────────────────────────────
  // Re-run whenever the collection address or the connected wallet changes.
  useEffect(() => {
    if (isEdit || !publicKey || !isValidStellarAddress(form.collectionAddress.trim())) {
      setApprovalStatus(null);
      return;
    }

    let cancelled = false;
    setIsCheckingApproval(true);
    setApprovalStatus(null);
    setApprovalError(null);

    isApprovedForAll(form.collectionAddress.trim(), publicKey, config.contractId)
      .then((approved) => {
        if (!cancelled) setApprovalStatus(approved);
      })
      .catch(() => {
        if (!cancelled) setApprovalStatus(false);
      })
      .finally(() => {
        if (!cancelled) setIsCheckingApproval(false);
      });

    return () => {
      cancelled = true;
    };
  }, [form.collectionAddress, publicKey, isEdit]);

  // ── Approve marketplace handler ───────────────────────────────────────
  const handleApproveMarketplace = async () => {
    if (!publicKey || !isValidStellarAddress(form.collectionAddress.trim())) return;
    setIsApprovingMarketplace(true);
    setApprovalError(null);
    try {
      await checkAndApproveMarketplace(
        publicKey,
        form.collectionAddress.trim(),
        config.contractId
      );
      setApprovalStatus(true);
      posthog.capture("Marketplace Approved", {
        collection: form.collectionAddress.trim(),
      });
    } catch (err) {
      setApprovalError(
        err instanceof Error ? err.message : "Approval transaction failed."
      );
    } finally {
      setIsApprovingMarketplace(false);
    }
  };

  // ── Field helpers ─────────────────────────────────────────

  function markTouched(field: string) {
    setTouched((prev) => new Set(prev).add(field));
  }

  function shouldShowError(field: string): boolean {
    return submitAttempted || touched.has(field);
  }

  // ── Submit ────────────────────────────────────────────────

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitAttempted(true);

    if (!isFormValid(errors)) return;

    // In create mode the marketplace must have operator approval before we
    // can create a listing (it needs to call transfer_from at escrow time).
    if (!isEdit && approvalStatus === false) return;

    // Reset any previous lifecycle error before starting a new submission.
    resetListingTx();

    if (isEdit && listing && currentMetadata) {
      const success = await runListingTx(
        () =>
          update({
            listingId: listing.listing_id,
            originalTokenAddress: listing.token,
            collectionAddress: form.collectionAddress,
            nftTokenId: form.nftTokenId,
            price: form.price,
            tokenAddress: form.tokenAddress,
            title: currentMetadata.title ?? "",
            description: currentMetadata.description ?? "",
            artistName: currentMetadata.artist ?? "",
            year: currentMetadata.year ?? "",
            category: currentMetadata.category ?? "",
            currentMetadata,
          }),
        { action: "Update listing" }
      );
      if (success) {
        setSuccessId(listing.listing_id);
        onSuccess?.(listing.listing_id);
      }
    } else if (!isEdit) {
      const id = await runListingTx(
        () =>
          create({
            collectionAddress: form.collectionAddress,
            nftTokenId: form.nftTokenId,
            price: form.price,
            tokenAddress: form.tokenAddress,
            recipients: form.recipients,
          }),
        { action: "Create listing" }
      );
      if (id !== null) {
        setSuccessId(id as number);
        posthog.capture("Listing Created", { listing_id: id, price_xlm: form.price });
        // Draft fulfilled — clear it so the next listing starts fresh.
        if (publicKey) clearListingDraft(publicKey);
        onSuccess?.(id as number);
      }
    }
  };

  const isLoading = isCreating || isUpdating || isFetchingMetadata || isListingTxActive;
  /** True when any async operation is in flight (including approval). */
  const isAnyLoading = isLoading || isCheckingApproval || isApprovingMarketplace;
  const progress = isListingTxActive
    ? txStateLabel(listingTxState.state)
    : isEdit
    ? updateProgress
    : createProgress;
  // Show typed error from lifecycle when available, fall back to hook error string
  const hookError = isEdit ? updateError : createError;

  // ── Success screen ────────────────────────────────────────

  if (successId !== null) {
    return (
      <div className="max-w-xl mx-auto flex flex-col items-center gap-6 rounded-3xl border border-green-100 bg-white p-12 text-center shadow-2xl shadow-green-900/5">
        <div className="rounded-full bg-green-50 p-4">
          <CheckCircle size={56} className="text-green-500" />
        </div>
        <div className="space-y-2">
          <h3 className="text-3xl font-display font-bold text-gray-900">
            Listing #{successId} {isEdit ? "Updated" : "Created"}!
          </h3>
          <p className="text-gray-500 font-inter">
            Your artwork is now live and available for purchase on the ELCARE-HUB marketplace.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-4 w-full mt-4">
          {!isEdit && (
            <button
              onClick={() => {
                setSuccessId(null);
                setSubmitAttempted(false);
                setTouched(new Set());
                setForm({
                  metadataCid: "",
                  collectionAddress: "",
                  nftTokenId: 0,
                  price: 10,
                  tokenAddress: defaultToken.address,
                  recipients: [{ address: publicKey ?? "", percentage: 100 }],
                });
              }}
              className="flex-1 rounded-2xl bg-brand-500 px-6 py-4 text-lg font-bold text-white hover:bg-brand-600 shadow-lg shadow-brand-500/20 transition-all hover:scale-[1.02] active:scale-[0.98]"
            >
              List Another
            </button>
          )}
          <button
            onClick={onCancel}
            className="flex-1 rounded-2xl border border-gray-200 bg-white px-6 py-4 text-lg font-semibold text-gray-700 hover:bg-gray-50 transition-all"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  // ── Main render ───────────────────────────────────────────

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      {/* Draft restore banner (create mode only) */}
      {!isEdit && hasDraft && (
        <div
          role="alert"
          data-testid="draft-restore-banner"
          className="mb-6 flex items-start justify-between gap-4 rounded-2xl border border-brand-100 bg-brand-50/60 px-5 py-4"
        >
          <div className="flex items-start gap-3">
            <Save size={18} className="mt-0.5 text-brand-500 shrink-0" />
            <div>
              <p className="text-sm font-bold text-brand-700">Unsaved draft found</p>
              <p className="text-xs text-brand-600 mt-0.5">
                You have a saved listing draft, including your revenue split. Restore it or
                start fresh.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={restoreDraft}
              className="rounded-xl bg-brand-500 px-4 py-2 text-xs font-bold text-white hover:bg-brand-600 transition-colors"
              data-testid="restore-draft-btn"
            >
              Restore
            </button>
            <button
              type="button"
              onClick={discardDraft}
              className="rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold text-gray-600 hover:bg-gray-50 transition-colors"
              data-testid="discard-draft-btn"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-3xl shadow-2xl shadow-brand-900/5 border border-brand-100/50 p-6 md:p-10">
        <header className="mb-10 text-center">
          <h2 className="text-4xl font-display font-bold text-gray-900 mb-2">
            {isEdit ? "Refine Your Masterpiece" : "List Your Artwork"}
          </h2>
          <p className="text-gray-500 font-inter">
            {isEdit
              ? "Update your listing details to attract more buyers."
              : "Share your creative vision with collectors across the globe."}
          </p>
        </header>

        <form onSubmit={handleSubmit} noValidate className="space-y-8">
          <div className="grid gap-6 sm:grid-cols-2">

            {/* Metadata CID */}
            <div className="sm:col-span-2 space-y-2">
              <label className="block text-sm font-bold text-gray-950 uppercase tracking-wider font-inter">
                Artwork Metadata CID *
              </label>
              <input
                value={form.metadataCid}
                onChange={(e) => setForm({ ...form, metadataCid: e.target.value })}
                onBlur={() => markTouched("metadataCid")}
                aria-invalid={shouldShowError("metadataCid") && !!errors.metadataCid}
                aria-describedby={errors.metadataCid ? "err-metadata-cid" : undefined}
                className={`w-full rounded-2xl border px-5 py-4 text-base font-mono focus:outline-none transition-all shadow-sm ${
                  shouldShowError("metadataCid") && errors.metadataCid
                    ? "border-red-400 bg-red-50/40 focus:border-red-500"
                    : "border-gray-200 bg-gray-50/50 focus:border-brand-500 focus:bg-white"
                }`}
                placeholder="bafybeig… or Qm…"
              />
              {shouldShowError("metadataCid") && errors.metadataCid ? (
                <p id="err-metadata-cid" className="text-sm text-red-600 mt-1" role="alert">
                  {errors.metadataCid}
                </p>
              ) : (
                <p className="text-xs text-gray-400 font-inter">
                  CIDv1 starts with <code className="font-mono">b</code> (46–100 chars) or
                  CIDv0 starts with <code className="font-mono">Qm</code> (46 chars).
                </p>
              )}
            </div>

            {/* Collection Address */}
            <div className="sm:col-span-2 space-y-2">
              <label className="block text-sm font-bold text-gray-950 uppercase tracking-wider font-inter">
                Collection Address *
              </label>
              <input
                value={form.collectionAddress}
                onChange={(e) => setForm({ ...form, collectionAddress: e.target.value })}
                onBlur={() => markTouched("collectionAddress")}
                aria-invalid={shouldShowError("collectionAddress") && !!errors.collectionAddress}
                aria-describedby={errors.collectionAddress ? "err-collection" : undefined}
                className={`w-full rounded-2xl border px-5 py-4 text-base focus:outline-none transition-all shadow-sm font-inter ${
                  shouldShowError("collectionAddress") && errors.collectionAddress
                    ? "border-red-400 bg-red-50/40 focus:border-red-500"
                    : "border-gray-200 bg-gray-50/50 focus:border-brand-500 focus:bg-white"
                }`}
                placeholder="e.g. C..."
              />
              {shouldShowError("collectionAddress") && errors.collectionAddress && (
                <p id="err-collection" className="text-sm text-red-600 mt-1" role="alert">
                  {errors.collectionAddress}
                </p>
              )}
            </div>

            {/* ── Marketplace Approval Step (create mode only) ── */}
            {!isEdit && isValidStellarAddress(form.collectionAddress.trim()) && (
              <div className="sm:col-span-2">
                {isCheckingApproval ? (
                  <div className="flex items-center gap-2 rounded-2xl bg-gray-50 border border-gray-200 px-5 py-3 text-sm text-gray-500 font-inter">
                    <Loader2 size={15} className="animate-spin shrink-0" />
                    Checking marketplace approval…
                  </div>
                ) : approvalStatus === true ? (
                  <div
                    role="status"
                    className="flex items-center gap-2 rounded-2xl bg-green-50 border border-green-200 px-5 py-3 text-sm font-semibold text-green-700 font-inter"
                  >
                    <ShieldCheck size={16} className="shrink-0" />
                    Marketplace is approved to transfer tokens from this collection.
                  </div>
                ) : approvalStatus === false ? (
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 space-y-3">
                    <div className="flex items-start gap-2 text-sm text-amber-800 font-inter">
                      <ShieldAlert size={16} className="shrink-0 mt-0.5" />
                      <span>
                        <strong className="font-bold">One-time approval required.</strong>{" "}
                        Before listing, you need to allow the marketplace to transfer NFTs
                        from this collection on your behalf. This is a single wallet
                        transaction — you won&apos;t need to do it again for this collection.
                      </span>
                    </div>
                    {approvalError && (
                      <p className="text-xs text-red-600 font-inter" role="alert">
                        {approvalError}
                      </p>
                    )}
                    <GuardButton
                      type="button"
                      onClick={handleApproveMarketplace}
                      disabled={isApprovingMarketplace}
                      actionName="to approve the marketplace"
                      className="flex items-center gap-2 rounded-xl bg-amber-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-amber-700 disabled:opacity-50 transition-all"
                    >
                      {isApprovingMarketplace ? (
                        <>
                          <Loader2 size={14} className="animate-spin" />
                          Approving…
                        </>
                      ) : (
                        <>
                          <ShieldCheck size={14} />
                          Approve Marketplace
                        </>
                      )}
                    </GuardButton>
                  </div>
                ) : null}
              </div>
            )}

            {/* NFT Token ID */}
            <div className="sm:col-span-2 space-y-2">
              <label className="block text-sm font-bold text-gray-950 uppercase tracking-wider font-inter">
                NFT Token ID *
              </label>
              <input
                type="number"
                min={0}
                step={1}
                value={form.nftTokenId}
                onChange={(e) =>
                  setForm({ ...form, nftTokenId: parseInt(e.target.value, 10) || 0 })
                }
                onBlur={() => markTouched("nftTokenId")}
                aria-invalid={shouldShowError("nftTokenId") && !!errors.nftTokenId}
                aria-describedby={errors.nftTokenId ? "err-tokenid" : undefined}
                className={`w-full rounded-2xl border px-5 py-4 text-base focus:outline-none transition-all shadow-sm font-inter ${
                  shouldShowError("nftTokenId") && errors.nftTokenId
                    ? "border-red-400 bg-red-50/40 focus:border-red-500"
                    : "border-gray-200 bg-gray-50/50 focus:border-brand-500 focus:bg-white"
                }`}
              />
              {shouldShowError("nftTokenId") && errors.nftTokenId && (
                <p id="err-tokenid" className="text-sm text-red-600 mt-1" role="alert">
                  {errors.nftTokenId}
                </p>
              )}
            </div>

            {/* Price */}
            <div className="space-y-2">
              <label className="block text-sm font-bold text-gray-950 uppercase tracking-wider font-inter">
                Price ({selectedToken.symbol}) *
              </label>
              <div className="relative">
                <input
                  type="number"
                  min={MIN_PRICE_XLM}
                  max={MAX_PRICE_XLM}
                  step="any"
                  value={form.price}
                  onChange={(e) =>
                    setForm({ ...form, price: parseFloat(e.target.value) })
                  }
                  onBlur={() => markTouched("price")}
                  aria-invalid={shouldShowError("price") && !!errors.price}
                  aria-describedby={errors.price ? "err-price" : undefined}
                  className={`w-full rounded-2xl border px-5 py-4 pr-16 text-base focus:outline-none transition-all shadow-sm font-inter ${
                    shouldShowError("price") && errors.price
                      ? "border-red-400 bg-red-50/40 focus:border-red-500"
                      : "border-gray-200 bg-gray-50/50 focus:border-brand-500 focus:bg-white"
                  }`}
                />
                <span className="absolute right-5 top-1/2 -translate-y-1/2 text-sm font-bold text-brand-600">
                  {selectedToken.symbol}
                </span>
              </div>
              {shouldShowError("price") && errors.price && (
                <p id="err-price" className="text-sm text-red-600 mt-1" role="alert">
                  {errors.price}
                </p>
              )}
            </div>

            {/* Payment Token */}
            <div className="space-y-2">
              <label className="block text-sm font-bold text-gray-950 uppercase tracking-wider font-inter">
                Payment Token *
              </label>
              <select
                disabled={!hasTokenOptions || isEdit}
                value={form.tokenAddress}
                onChange={(e) => {
                  setForm({ ...form, tokenAddress: e.target.value });
                  markTouched("tokenAddress");
                }}
                onBlur={() => markTouched("tokenAddress")}
                aria-invalid={shouldShowError("tokenAddress") && !!errors.tokenAddress}
                className={`w-full appearance-none rounded-2xl border px-5 py-4 text-base focus:outline-none transition-all shadow-sm font-inter ${
                  shouldShowError("tokenAddress") && errors.tokenAddress
                    ? "border-red-400 bg-red-50/40 focus:border-red-500"
                    : "border-gray-200 bg-gray-50/50 focus:border-brand-500 focus:bg-white"
                }`}
              >
                {hasTokenOptions ? (
                  tokenOptions.map((token) => (
                    <option key={token.address} value={token.address}>
                      {token.name} ({token.symbol})
                    </option>
                  ))
                ) : (
                  <option value="">No supported tokens available</option>
                )}
              </select>
              {shouldShowError("tokenAddress") && errors.tokenAddress && (
                <p className="text-sm text-red-600 mt-1" role="alert">
                  {errors.tokenAddress}
                </p>
              )}
            </div>
          </div>

          {/* ── Royalty Recipients ── */}
          <RoyaltySplitEditor
            recipients={form.recipients}
            onChange={(recipients) => setForm((cur) => ({ ...cur, recipients }))}
            maxRecipients={MAX_RECIPIENTS}
            protocolFeeBps={protocolFeeBps}
            collectionDefault={collectionDefault}
            disabled={isAnyLoading}
            forceShowErrors={submitAttempted}
          />

          {/* Progress / lifecycle state label */}
          {isLoading && progress && (
            <div className="flex items-center gap-3 rounded-2xl bg-brand-50 px-6 py-4 text-sm font-semibold text-brand-700 animate-pulse">
              <Loader2 size={20} className="animate-spin" />
              {progress}
            </div>
          )}

          {/* Typed transaction error — distinguishes wallet rejection, simulation
              failure, and chain failure with per-category recovery instructions */}
          {listingTxState.state === "error" && listingTxState.error && (
            <TxErrorPanel
              error={listingTxState.error}
              txHash={listingTxState.txHash}
              onRetry={resetListingTx}
              onDismiss={resetListingTx}
            />
          )}

          {/* Tx hash recovery link — visible once hash is known */}
          {listingTxState.txHash && listingTxState.state !== "success" && (
            <p className="text-xs text-gray-400 text-center">
              Transaction:{" "}
              <Link
                href={`/tx/${listingTxState.txHash}`}
                className="font-mono text-blue-500 hover:underline"
                target="_blank"
              >
                {listingTxState.txHash.slice(0, 12)}…
              </Link>
            </p>
          )}

          {/* Fallback hook error string (e.g. IPFS upload failures that happen
              before the tx is submitted) */}
          {hookError && listingTxState.state !== "error" && (
            <p className="rounded-2xl bg-red-50 px-6 py-4 text-sm font-bold text-red-600 border border-red-100">
              {hookError}
            </p>
          )}

          {/* Buttons */}
          <div className="flex flex-col sm:flex-row gap-4 pt-4">
            {isEdit && (
              <button
                type="button"
                onClick={onCancel}
                disabled={isAnyLoading}
                className="flex-1 rounded-2xl border border-gray-200 py-4 text-lg font-semibold text-gray-600 hover:bg-gray-50 transition-all disabled:opacity-50"
              >
                Cancel
              </button>
            )}
            <GuardButton
              type="submit"
              disabled={
                isAnyLoading ||
                !hasTokenOptions ||
                (submitAttempted && !formIsValid) ||
                (!isEdit && approvalStatus === false)
              }
              actionName={isEdit ? "to update your listing" : "to list your artwork"}
              className="flex-[2] flex items-center justify-center gap-3 rounded-2xl bg-brand-500 py-5 text-xl font-bold text-white shadow-2xl shadow-brand-500/30 hover:bg-brand-600 hover:scale-[1.01] transition-all active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100"
            >
              {isAnyLoading ? (
                <>
                  <Loader2 size={24} className="animate-spin" />
                  {progress || (isCheckingApproval ? "Checking approval…" : isApprovingMarketplace ? "Approving…" : "Processing…")}
                </>
              ) : (
                <>
                  {isEdit ? <Save size={24} /> : <Upload size={24} />}
                  {isEdit ? "Update Listing" : "Create Listing"}
                </>
              )}
            </GuardButton>
          </div>
        </form>
      </div>
    </div>
  );
}
