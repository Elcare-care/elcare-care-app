// ─────────────────────────────────────────────────────────────────────────────
// components/ListingWizard.tsx — step-based listing creation wizard (Issue #526)
//
// Collection → Ownership & Quantity → Pricing & Asset → Royalty Split →
// Expiry → Review & Sign → Confirmation.
//
// Single-edition (ERC-721 / LazyMint721) and multi-edition (ERC-1155 /
// LazyMint1155) listings share every step of this wizard — the two paths
// only diverge in:
//   - which on-chain ownership check runs (`owner_of` vs `balance_of`)
//   - whether a quantity input is shown at all (multi-edition only)
//   - the `quantity` contract argument sent at submit time
// Everything else (pricing, royalty split, expiry, review, submission,
// draft persistence) is exactly the same code path for both.
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import posthog from "posthog-js";
import {
  Loader2,
  CheckCircle,
  ArrowRight,
  ArrowLeft,
  Check,
  AlertTriangle,
  ShieldCheck,
  ShieldAlert,
  Plus,
  Trash2,
  Search,
  Layers,
  Package,
  Info,
  Clock,
  Save,
  X,
} from "lucide-react";
import Link from "next/link";
import { useWalletContext } from "@/context/WalletContext";
import { GuardButton } from "@/components/WalletGuard";
import { TxErrorPanel } from "@/components/TxErrorPanel";
import { useCreateListing } from "@/hooks/useMarketplace";
import { useTxLifecycle, txStateLabel } from "@/hooks/useTxLifecycle";
import { useSupportedTokens } from "@/hooks/useSupportedTokens";
import { getDefaultSupportedToken } from "@/lib/token-support";
import { DEFAULT_TOKEN, TokenConfig } from "@/config/tokens";
import { isValidStellarAddress } from "@/lib/validation";
import { getCollections, IndexerCollectionRow } from "@/lib/indexer";
import {
  getNftOwner,
  getNftBalance,
  isApprovedForAll,
  checkAndApproveMarketplace,
  getProtocolFee,
} from "@/lib/contract";
import { config } from "@/lib/config";
import { validateAmountInput, buildFeePreview } from "@/lib/amount";
import { formatDate } from "@/lib/format";
import {
  ExpiryOption,
  ListingWizardDraft,
  loadListingWizardDraft,
  saveListingWizardDraft,
  clearListingWizardDraft,
} from "@/lib/listingWizardDraft";
import { MAX_RECIPIENTS } from "@/components/ListingForm";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WizardRecipient {
  address: string;
  /** Display percentage (0–100). Converted to basis points at submit time. */
  percentage: number;
}

type EditionMode = "single" | "multi";
type OwnershipStatus = "idle" | "checking" | "owned" | "not-owned" | "error";

interface WizardForm {
  collectionAddress: string;
  editionMode: EditionMode;
  nftTokenId: string;
  quantity: string;
  price: string;
  tokenAddress: string;
  recipients: WizardRecipient[];
  expiryOption: ExpiryOption;
  customExpiry: string;
}

const STEPS = ["Collection", "Ownership", "Pricing", "Royalties", "Expiry", "Review"] as const;

const EXPIRY_PRESETS: Array<{ id: ExpiryOption; label: string; seconds: number | null }> = [
  { id: "none", label: "No expiry", seconds: null },
  { id: "1d", label: "24 hours", seconds: 24 * 60 * 60 },
  { id: "7d", label: "7 days", seconds: 7 * 24 * 60 * 60 },
  { id: "30d", label: "30 days", seconds: 30 * 24 * 60 * 60 },
  { id: "custom", label: "Custom date", seconds: null },
];

function initialForm(publicKey: string | null): WizardForm {
  return {
    collectionAddress: "",
    editionMode: "single",
    nftTokenId: "",
    quantity: "1",
    price: "",
    tokenAddress: DEFAULT_TOKEN.address,
    recipients: [{ address: publicKey ?? "", percentage: 100 }],
    expiryOption: "none",
    customExpiry: "",
  };
}

function draftFromForm(step: number, form: WizardForm): ListingWizardDraft {
  return {
    step,
    collectionAddress: form.collectionAddress,
    editionMode: form.editionMode,
    nftTokenId: form.nftTokenId,
    quantity: form.quantity,
    price: form.price,
    tokenAddress: form.tokenAddress,
    recipients: form.recipients,
    expiryOption: form.expiryOption,
    customExpiry: form.customExpiry,
  };
}

function formFromDraft(draft: ListingWizardDraft, publicKey: string | null): WizardForm {
  return {
    collectionAddress: draft.collectionAddress ?? "",
    editionMode: draft.editionMode === "multi" ? "multi" : "single",
    nftTokenId: draft.nftTokenId ?? "",
    quantity: draft.quantity ?? "1",
    price: draft.price ?? "",
    tokenAddress: draft.tokenAddress || DEFAULT_TOKEN.address,
    recipients:
      draft.recipients && draft.recipients.length > 0
        ? draft.recipients
        : [{ address: publicKey ?? "", percentage: 100 }],
    expiryOption: draft.expiryOption ?? "none",
    customExpiry: draft.customExpiry ?? "",
  };
}

/** Resolve a preset/custom expiry selection to a unix-seconds timestamp, or null for "no expiry". */
function resolveExpiryUnix(option: ExpiryOption, customExpiry: string): number | null {
  if (option === "none") return null;
  if (option === "custom") {
    const ms = Date.parse(customExpiry);
    if (Number.isNaN(ms)) return null;
    return Math.floor(ms / 1000);
  }
  const preset = EXPIRY_PRESETS.find((p) => p.id === option);
  if (!preset || preset.seconds == null) return null;
  return Math.floor(Date.now() / 1000) + preset.seconds;
}

function editionLabel(kind: string): EditionMode {
  return kind.toLowerCase().includes("1155") ? "multi" : "single";
}

function truncateAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

// ── Recipients validation ────────────────────────────────────────────────────

interface RecipientRowError {
  address?: string;
  percentage?: string;
}

function validateRecipients(recipients: WizardRecipient[]): {
  summaryError: string | null;
  rowErrors: RecipientRowError[];
} {
  const rowErrors: RecipientRowError[] = recipients.map((r) => {
    const err: RecipientRowError = {};
    if (!r.address.trim()) {
      err.address = "Address is required.";
    } else if (!isValidStellarAddress(r.address.trim())) {
      err.address = "Must be a valid Stellar address.";
    }
    if (!Number.isFinite(r.percentage) || r.percentage <= 0) {
      err.percentage = "Must be greater than 0.";
    } else if (r.percentage > 100) {
      err.percentage = "Cannot exceed 100%.";
    }
    return err;
  });

  const addresses = recipients.map((r) => r.address.trim()).filter(Boolean);
  const hasDuplicates = new Set(addresses).size !== addresses.length;

  let summaryError: string | null = null;
  if (recipients.length === 0) {
    summaryError = "At least one recipient is required.";
  } else if (recipients.length > MAX_RECIPIENTS) {
    summaryError = `A maximum of ${MAX_RECIPIENTS} recipients is allowed.`;
  } else if (hasDuplicates) {
    summaryError = "Each recipient address must be unique.";
  } else {
    const total = recipients.reduce((sum, r) => sum + (r.percentage || 0), 0);
    if (Math.round(total * 100) !== 10_000) {
      summaryError = `Recipient percentages must sum to exactly 100% (currently ${total.toFixed(2)}%).`;
    }
  }

  return { summaryError, rowErrors };
}

// ── Component ─────────────────────────────────────────────────────────────────

interface ListingWizardProps {
  onSuccess?: (listingId: number) => void;
  onCancel?: () => void;
}

export function ListingWizard({ onSuccess, onCancel }: ListingWizardProps) {
  const { publicKey } = useWalletContext();
  const { tokens: availableTokens } = useSupportedTokens();
  const { create, isCreating, error: createError } = useCreateListing(publicKey);

  const {
    txState: listingTxState,
    isActive: isListingTxActive,
    run: runListingTx,
    reset: resetListingTx,
  } = useTxLifecycle({ persistKey: "createListingWizard", action: "Create listing" });

  const [step, setStep] = useState(0);
  const [nextAttempted, setNextAttempted] = useState(false);
  const [form, setForm] = useState<WizardForm>(() => initialForm(publicKey));
  const [successId, setSuccessId] = useState<number | null>(null);

  // ── Draft restore banner ──────────────────────────────────────────────────
  const [hasDraft, setHasDraft] = useState(false);
  const draftCheckedRef = useRef(false);

  useEffect(() => {
    if (!publicKey || draftCheckedRef.current) return;
    draftCheckedRef.current = true;
    const draft = loadListingWizardDraft(publicKey);
    if (draft) setHasDraft(true);
  }, [publicKey]);

  const restoreDraft = useCallback(() => {
    if (!publicKey) return;
    const draft = loadListingWizardDraft(publicKey);
    if (!draft) return;
    setForm(formFromDraft(draft, publicKey));
    setStep(Math.min(Math.max(draft.step ?? 0, 0), STEPS.length - 1));
    setHasDraft(false);
  }, [publicKey]);

  const discardDraft = useCallback(() => {
    if (!publicKey) return;
    clearListingWizardDraft(publicKey);
    setHasDraft(false);
  }, [publicKey]);

  // Auto-save the draft on every change (skip while the restore banner is
  // still showing, so we don't clobber the saved draft before the user
  // chooses to restore or discard it).
  useEffect(() => {
    if (!publicKey || hasDraft) return;
    saveListingWizardDraft(publicKey, draftFromForm(step, form));
  }, [publicKey, hasDraft, step, form]);

  // Default the first recipient to the connected wallet once it's known.
  useEffect(() => {
    if (publicKey && form.recipients[0]?.address === "") {
      setForm((cur) => ({
        ...cur,
        recipients: [{ address: publicKey, percentage: 100 }, ...cur.recipients.slice(1)],
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey]);

  // Snap to a valid token once the whitelist loads.
  useEffect(() => {
    if (availableTokens.length === 0) return;
    if (!availableTokens.some((t) => t.address === form.tokenAddress)) {
      setForm((cur) => ({ ...cur, tokenAddress: getDefaultSupportedToken(availableTokens).address }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableTokens]);

  const selectedToken: TokenConfig =
    availableTokens.find((t) => t.address === form.tokenAddress) ?? getDefaultSupportedToken(availableTokens);
  const isMultiEdition = form.editionMode === "multi";

  // ── Step 0: collection discovery ──────────────────────────────────────────

  const [myCollections, setMyCollections] = useState<IndexerCollectionRow[]>([]);
  const [isLoadingCollections, setIsLoadingCollections] = useState(false);
  const [manualEntry, setManualEntry] = useState(false);
  const [collectionKindKnown, setCollectionKindKnown] = useState(false);

  useEffect(() => {
    if (!publicKey) return;
    let cancelled = false;
    setIsLoadingCollections(true);
    getCollections({ creator: publicKey, limit: 50 })
      .then((res) => {
        if (!cancelled) setMyCollections(res.collections);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingCollections(false);
      });
    return () => {
      cancelled = true;
    };
  }, [publicKey]);

  const selectCollection = useCallback((row: IndexerCollectionRow) => {
    setCollectionKindKnown(true);
    setManualEntry(false);
    setForm((cur) => ({
      ...cur,
      collectionAddress: row.contractAddress,
      editionMode: editionLabel(row.kind),
      // Reset downstream fields that are collection-specific.
      nftTokenId: "",
      quantity: "1",
    }));
  }, []);

  const handleManualAddress = useCallback((value: string) => {
    setCollectionKindKnown(false);
    setForm((cur) => ({ ...cur, collectionAddress: value, nftTokenId: "", quantity: "1" }));
  }, []);

  // Best-effort edition-kind detection for manually-entered collections: try
  // the single-edition `owner_of` read first; if it resolves to an address
  // we suggest "single", otherwise we suggest "multi". The radio stays
  // editable either way — this is a convenience default, not a hard gate
  // (the real gate is the ownership check below, which uses whichever mode
  // is actually selected).
  useEffect(() => {
    if (!manualEntry || collectionKindKnown) return;
    if (!isValidStellarAddress(form.collectionAddress.trim())) return;
    const tokenIdNum = parseInt(form.nftTokenId, 10);
    if (!Number.isInteger(tokenIdNum) || tokenIdNum < 0) return;
    let cancelled = false;
    getNftOwner(form.collectionAddress.trim(), tokenIdNum).then((owner) => {
      if (cancelled) return;
      setForm((cur) => ({ ...cur, editionMode: owner ? "single" : cur.editionMode }));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualEntry, collectionKindKnown, form.collectionAddress, form.nftTokenId]);

  const collectionValid = isValidStellarAddress(form.collectionAddress.trim());

  // ── Step 1: ownership + approval ──────────────────────────────────────────

  const [ownershipStatus, setOwnershipStatus] = useState<OwnershipStatus>("idle");
  const [ownerBalance, setOwnerBalance] = useState<bigint | null>(null);
  const [approvalStatus, setApprovalStatus] = useState<boolean | null>(null);
  const [isCheckingApproval, setIsCheckingApproval] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const tokenIdNum = parseInt(form.nftTokenId, 10);
  const tokenIdValid = Number.isInteger(tokenIdNum) && tokenIdNum >= 0 && form.nftTokenId.trim() !== "";

  useEffect(() => {
    if (!publicKey || !collectionValid || !tokenIdValid) {
      setOwnershipStatus("idle");
      setOwnerBalance(null);
      return;
    }
    let cancelled = false;
    setOwnershipStatus("checking");
    (async () => {
      try {
        if (isMultiEdition) {
          const bal = await getNftBalance(form.collectionAddress.trim(), publicKey, tokenIdNum);
          if (cancelled) return;
          setOwnerBalance(bal);
          setOwnershipStatus(bal > 0n ? "owned" : "not-owned");
        } else {
          const owner = await getNftOwner(form.collectionAddress.trim(), tokenIdNum);
          if (cancelled) return;
          setOwnerBalance(null);
          setOwnershipStatus(owner && owner === publicKey ? "owned" : "not-owned");
        }
      } catch {
        if (!cancelled) setOwnershipStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicKey, collectionValid, tokenIdValid, tokenIdNum, isMultiEdition, form.collectionAddress]);

  useEffect(() => {
    if (!publicKey || !collectionValid) {
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
  }, [publicKey, collectionValid, form.collectionAddress]);

  const handleApprove = async () => {
    if (!publicKey || !collectionValid) return;
    setIsApproving(true);
    setApprovalError(null);
    try {
      await checkAndApproveMarketplace(publicKey, form.collectionAddress.trim(), config.contractId);
      setApprovalStatus(true);
      posthog.capture("Marketplace Approved", { collection: form.collectionAddress.trim() });
    } catch (err) {
      setApprovalError(err instanceof Error ? err.message : "Approval transaction failed.");
    } finally {
      setIsApproving(false);
    }
  };

  const quantityNum = parseInt(form.quantity, 10);
  const quantityValid = isMultiEdition
    ? Number.isInteger(quantityNum) &&
      quantityNum >= 1 &&
      (ownerBalance === null || BigInt(quantityNum) <= ownerBalance)
    : true;

  const ownershipStepValid =
    collectionValid &&
    tokenIdValid &&
    ownershipStatus === "owned" &&
    approvalStatus === true &&
    quantityValid;

  // ── Step 2: pricing + asset ────────────────────────────────────────────────

  const hasTokenOptions = availableTokens.length > 0;
  const priceValidation = useMemo(
    () => validateAmountInput(form.price || "", selectedToken),
    [form.price, selectedToken]
  );
  const pricingStepValid = hasTokenOptions && priceValidation.valid;

  // ── Step 3: royalty split ──────────────────────────────────────────────────

  const { summaryError: recipientsError, rowErrors: recipientRowErrors } = useMemo(
    () => validateRecipients(form.recipients),
    [form.recipients]
  );
  const royaltiesStepValid = recipientsError === null;

  function addRecipient() {
    if (form.recipients.length >= MAX_RECIPIENTS) return;
    setForm((cur) => ({ ...cur, recipients: [...cur.recipients, { address: "", percentage: 0 }] }));
  }
  function removeRecipient(index: number) {
    if (form.recipients.length <= 1) return;
    setForm((cur) => ({ ...cur, recipients: cur.recipients.filter((_, i) => i !== index) }));
  }
  function updateRecipient(index: number, field: "address" | "percentage", value: string | number) {
    setForm((cur) => ({
      ...cur,
      recipients: cur.recipients.map((r, i) => (i === index ? { ...r, [field]: value } : r)),
    }));
  }

  // ── Step 4: expiry ──────────────────────────────────────────────────────────

  const expiryUnix = resolveExpiryUnix(form.expiryOption, form.customExpiry);
  const expiryStepValid =
    form.expiryOption !== "custom" || (form.customExpiry !== "" && expiryUnix !== null && expiryUnix > Date.now() / 1000);

  // ── Aggregate validity ───────────────────────────────────────────────────────

  const stepValidity = [collectionValid, ownershipStepValid, pricingStepValid, royaltiesStepValid, expiryStepValid, true];
  const allStepsValid = stepValidity.slice(0, 5).every(Boolean);

  // ── Review step: protocol fee + exact submission summary ────────────────────

  const [protocolFeeBps, setProtocolFeeBps] = useState<number>(0);
  useEffect(() => {
    if (step !== 5) return;
    let cancelled = false;
    getProtocolFee().then((bps) => {
      if (!cancelled) setProtocolFeeBps(bps);
    });
    return () => {
      cancelled = true;
    };
  }, [step]);

  const priceBaseUnits = priceValidation.baseUnits;
  const feePreview = priceBaseUnits != null ? buildFeePreview(priceBaseUnits, protocolFeeBps, selectedToken) : null;

  // The exact payload that will be sent to `create()` — computed once so the
  // Review step's displayed summary can never drift from what actually gets
  // signed.
  const submissionPayload = useMemo(() => {
    if (!allStepsValid || priceBaseUnits == null) return null;
    return {
      collectionAddress: form.collectionAddress.trim(),
      nftTokenId: tokenIdNum,
      price: parseFloat(form.price.trim()),
      tokenAddress: selectedToken.address,
      recipients: form.recipients.map((r) => ({
        address: r.address.trim(),
        percentage: Math.round(r.percentage * 100), // display % → basis points
      })),
      quantity: isMultiEdition ? quantityNum : 1,
      expiresAt: expiryUnix,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allStepsValid, form, tokenIdNum, priceBaseUnits, selectedToken, isMultiEdition, quantityNum, expiryUnix]);

  // ── Submission ────────────────────────────────────────────────────────────

  const handleSign = async () => {
    if (!publicKey || !submissionPayload) return;
    resetListingTx();
    const id = await runListingTx(() => create(submissionPayload), { action: "Create listing" });
    if (id !== null) {
      setSuccessId(id as number);
      clearListingWizardDraft(publicKey);
      posthog.capture("Listing Created", {
        listing_id: id,
        price_xlm: submissionPayload.price,
        quantity: submissionPayload.quantity,
        edition_mode: form.editionMode,
      });
      onSuccess?.(id as number);
    }
    // On failure, `listingTxState` carries the typed error and every form
    // field is untouched — the draft in sessionStorage is also untouched
    // (only cleared on success), so the creator can go Back and retry.
  };

  const isBusy = isCreating || isListingTxActive;

  // ── Navigation ────────────────────────────────────────────────────────────

  function goNext() {
    if (!stepValidity[step]) {
      setNextAttempted(true);
      return;
    }
    setNextAttempted(false);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }
  function goBack() {
    setNextAttempted(false);
    resetListingTx();
    setStep((s) => Math.max(s - 1, 0));
  }

  // ── Success screen ────────────────────────────────────────────────────────

  if (successId !== null) {
    return (
      <div className="max-w-xl mx-auto flex flex-col items-center gap-6 rounded-3xl border border-green-100 bg-white p-12 text-center shadow-2xl shadow-green-900/5">
        <div className="rounded-full bg-green-50 p-4">
          <CheckCircle size={56} className="text-green-500" />
        </div>
        <div className="space-y-2">
          <h3 className="text-3xl font-display font-bold text-gray-900">Listing #{successId} Created!</h3>
          <p className="text-gray-500 font-inter">
            Your {isMultiEdition ? `${submissionPayload?.quantity ?? 1} editions` : "artwork"} — collection{" "}
            <span className="font-mono">{truncateAddress(form.collectionAddress)}</span>, token #{form.nftTokenId} —
            {" "}is now live on the ELCARE-HUB marketplace.
          </p>
        </div>
        <div className="w-full rounded-2xl border border-gray-100 bg-gray-50/50 p-5 text-left text-sm space-y-2">
          <div className="flex justify-between"><span className="text-gray-500">Price</span><span className="font-bold">{form.price} {selectedToken.symbol}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Edition type</span><span className="font-bold">{isMultiEdition ? "Multi-edition" : "Single-edition"}</span></div>
          {isMultiEdition && (
            <div className="flex justify-between"><span className="text-gray-500">Quantity</span><span className="font-bold">{form.quantity}</span></div>
          )}
          <div className="flex justify-between"><span className="text-gray-500">Expiry</span><span className="font-bold">{expiryUnix ? formatDate(expiryUnix * 1000, { showTime: true }) : "No expiry"}</span></div>
        </div>
        <div className="flex flex-col sm:flex-row gap-4 w-full mt-2">
          <button
            onClick={() => {
              setSuccessId(null);
              setStep(0);
              setNextAttempted(false);
              setForm(initialForm(publicKey));
            }}
            className="flex-1 rounded-2xl bg-brand-500 px-6 py-4 text-lg font-bold text-white hover:bg-brand-600 shadow-lg shadow-brand-500/20 transition-all hover:scale-[1.02] active:scale-[0.98]"
          >
            List Another
          </button>
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

  // ── Main render ───────────────────────────────────────────────────────────

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      {hasDraft && (
        <div
          role="alert"
          data-testid="draft-restore-banner"
          className="mb-6 flex items-start justify-between gap-4 rounded-2xl border border-brand-100 bg-brand-50/60 px-5 py-4"
        >
          <div className="flex items-start gap-3">
            <Save size={18} className="mt-0.5 text-brand-500 shrink-0" />
            <div>
              <p className="text-sm font-bold text-brand-700">Unsaved listing draft found</p>
              <p className="text-xs text-brand-600 mt-0.5">Resume where you left off, or start fresh.</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={restoreDraft}
              data-testid="restore-draft-btn"
              className="rounded-xl bg-brand-500 px-4 py-2 text-xs font-bold text-white hover:bg-brand-600 transition-colors"
            >
              Restore
            </button>
            <button
              type="button"
              onClick={discardDraft}
              data-testid="discard-draft-btn"
              className="rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold text-gray-600 hover:bg-gray-50 transition-colors"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      <div className="mb-4 text-xs text-gray-400 font-inter">
        Draft auto-saved to this browser tab. No wallet secrets are ever stored.
      </div>

      {/* Step indicator */}
      <div className="flex items-center justify-between mb-10">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center flex-1">
            <div className="flex flex-col items-center">
              <div
                className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm border-2 transition-all ${
                  i < step
                    ? "bg-brand-500 border-brand-500 text-white"
                    : i === step
                    ? "border-brand-500 text-brand-600 bg-brand-50"
                    : "border-gray-200 text-gray-400 bg-white"
                }`}
              >
                {i < step ? <Check size={16} /> : i + 1}
              </div>
              <span className={`mt-1.5 text-xs font-bold hidden sm:block ${i <= step ? "text-brand-600" : "text-gray-400"}`}>
                {label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={`flex-1 h-0.5 mx-2 transition-all ${i < step ? "bg-brand-500" : "bg-gray-200"}`} />
            )}
          </div>
        ))}
      </div>

      <div className="bg-white rounded-3xl shadow-2xl shadow-brand-900/5 border border-brand-100/50 p-6 md:p-10">
        {/* ── Step 0: Collection ── */}
        {step === 0 && (
          <div>
            <h2 className="text-2xl font-display font-bold text-gray-900 mb-2">Choose a Collection</h2>
            <p className="text-gray-500 font-inter mb-6">
              Pick a collection you created, or enter any collection address manually.
            </p>

            {!manualEntry ? (
              <>
                {isLoadingCollections ? (
                  <div className="flex items-center gap-2 text-sm text-gray-500 font-inter py-6">
                    <Loader2 size={16} className="animate-spin" /> Loading your collections…
                  </div>
                ) : myCollections.length === 0 ? (
                  <div className="rounded-2xl border border-gray-100 bg-gray-50/50 p-6 text-sm text-gray-500 font-inter text-center">
                    No collections found for this wallet yet.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {myCollections.map((c) => {
                      const mode = editionLabel(c.kind);
                      const selected = form.collectionAddress === c.contractAddress;
                      return (
                        <button
                          type="button"
                          key={c.contractAddress}
                          onClick={() => selectCollection(c)}
                          className={`flex flex-col items-start gap-1 p-4 rounded-2xl border-2 text-left transition-all ${
                            selected ? "border-brand-500 bg-brand-50/50" : "border-gray-100 bg-gray-50/30 hover:border-brand-200"
                          }`}
                        >
                          <div className="flex items-center gap-2 font-bold text-gray-900">
                            {mode === "multi" ? <Layers size={14} /> : <Package size={14} />}
                            {c.name || "Unnamed Collection"}
                          </div>
                          <span className="text-xs font-mono text-gray-500">{truncateAddress(c.contractAddress)}</span>
                          <span className="text-xs font-semibold text-brand-600">
                            {mode === "multi" ? "Multi-edition (1155)" : "Single-edition (721)"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setManualEntry(true)}
                  className="mt-4 flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:text-brand-700"
                >
                  <Search size={14} /> Enter a collection address manually
                </button>
              </>
            ) : (
              <div className="space-y-2">
                <label className="block text-sm font-bold text-gray-950 uppercase tracking-wider font-inter">
                  Collection Address *
                </label>
                <input
                  value={form.collectionAddress}
                  onChange={(e) => handleManualAddress(e.target.value)}
                  placeholder="C..."
                  className={`w-full rounded-2xl border px-5 py-4 text-base font-inter focus:outline-none transition-all shadow-sm ${
                    nextAttempted && !collectionValid ? "border-red-400 bg-red-50/40" : "border-gray-200 bg-gray-50/50 focus:border-brand-500 focus:bg-white"
                  }`}
                />
                {nextAttempted && !collectionValid && (
                  <p className="text-sm text-red-600" role="alert">Must be a valid Stellar contract address (starts with C).</p>
                )}
                <div className="pt-2 space-y-2">
                  <span className="block text-xs font-bold text-gray-500 uppercase tracking-wider">Edition type</span>
                  <div className="flex gap-3">
                    {(["single", "multi"] as EditionMode[]).map((mode) => (
                      <label key={mode} className={`flex-1 flex items-center gap-2 rounded-xl border-2 px-4 py-3 cursor-pointer transition-all ${form.editionMode === mode ? "border-brand-500 bg-brand-50/50" : "border-gray-100"}`}>
                        <input
                          type="radio"
                          name="editionMode"
                          checked={form.editionMode === mode}
                          onChange={() => setForm((cur) => ({ ...cur, editionMode: mode }))}
                          className="sr-only"
                        />
                        {mode === "multi" ? <Layers size={14} /> : <Package size={14} />}
                        <span className="text-sm font-semibold">{mode === "multi" ? "Multi-edition (1155)" : "Single-edition (721)"}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setManualEntry(false)}
                  className="text-sm font-semibold text-brand-600 hover:text-brand-700"
                >
                  ← Back to my collections
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Step 1: Ownership & Quantity ── */}
        {step === 1 && (
          <div>
            <h2 className="text-2xl font-display font-bold text-gray-900 mb-2">Verify Ownership</h2>
            <p className="text-gray-500 font-inter mb-6">
              Enter the token ID and we&apos;ll verify you hold it before you can list it.
            </p>

            <div className="space-y-6">
              <div className="space-y-2">
                <label className="block text-sm font-bold text-gray-950 uppercase tracking-wider font-inter">
                  NFT Token ID *
                </label>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={form.nftTokenId}
                  onChange={(e) => setForm((cur) => ({ ...cur, nftTokenId: e.target.value }))}
                  className={`w-full rounded-2xl border px-5 py-4 text-base font-inter focus:outline-none transition-all shadow-sm ${
                    nextAttempted && !tokenIdValid ? "border-red-400 bg-red-50/40" : "border-gray-200 bg-gray-50/50 focus:border-brand-500 focus:bg-white"
                  }`}
                />
                {nextAttempted && !tokenIdValid && (
                  <p className="text-sm text-red-600" role="alert">Token ID must be a non-negative integer.</p>
                )}
              </div>

              {tokenIdValid && (
                <div>
                  {ownershipStatus === "checking" && (
                    <div className="flex items-center gap-2 rounded-2xl bg-gray-50 border border-gray-200 px-5 py-3 text-sm text-gray-500 font-inter">
                      <Loader2 size={15} className="animate-spin shrink-0" /> Verifying ownership…
                    </div>
                  )}
                  {ownershipStatus === "owned" && (
                    <div role="status" className="flex items-center gap-2 rounded-2xl bg-green-50 border border-green-200 px-5 py-3 text-sm font-semibold text-green-700 font-inter">
                      <ShieldCheck size={16} className="shrink-0" />
                      {isMultiEdition
                        ? `You hold ${ownerBalance ?? 0} of this token.`
                        : "You own this token."}
                    </div>
                  )}
                  {ownershipStatus === "not-owned" && (
                    <div role="alert" className="flex items-center gap-2 rounded-2xl bg-red-50 border border-red-200 px-5 py-3 text-sm font-semibold text-red-700 font-inter">
                      <ShieldAlert size={16} className="shrink-0" />
                      {isMultiEdition
                        ? "You don't hold any balance of this token in this collection."
                        : "This wallet does not own this token."}
                    </div>
                  )}
                  {ownershipStatus === "error" && (
                    <div role="alert" className="flex items-center gap-2 rounded-2xl bg-amber-50 border border-amber-200 px-5 py-3 text-sm font-semibold text-amber-700 font-inter">
                      <AlertTriangle size={16} className="shrink-0" /> Could not verify ownership. Check the collection address.
                    </div>
                  )}
                </div>
              )}

              {isMultiEdition && ownershipStatus === "owned" && (
                <div className="space-y-2">
                  <label className="block text-sm font-bold text-gray-950 uppercase tracking-wider font-inter">
                    Quantity to List *
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={ownerBalance ? Number(ownerBalance) : undefined}
                    step={1}
                    value={form.quantity}
                    onChange={(e) => setForm((cur) => ({ ...cur, quantity: e.target.value }))}
                    className={`w-full rounded-2xl border px-5 py-4 text-base font-inter focus:outline-none transition-all shadow-sm ${
                      nextAttempted && !quantityValid ? "border-red-400 bg-red-50/40" : "border-gray-200 bg-gray-50/50 focus:border-brand-500 focus:bg-white"
                    }`}
                  />
                  <p className="text-xs text-gray-400 font-inter">
                    Up to {ownerBalance?.toString() ?? "0"} available. Single-edition listings always list quantity 1.
                  </p>
                  {nextAttempted && !quantityValid && (
                    <p className="text-sm text-red-600" role="alert">Enter a quantity between 1 and your available balance.</p>
                  )}
                </div>
              )}

              {ownershipStatus === "owned" && collectionValid && (
                <div>
                  {isCheckingApproval ? (
                    <div className="flex items-center gap-2 rounded-2xl bg-gray-50 border border-gray-200 px-5 py-3 text-sm text-gray-500 font-inter">
                      <Loader2 size={15} className="animate-spin shrink-0" /> Checking marketplace approval…
                    </div>
                  ) : approvalStatus === true ? (
                    <div role="status" className="flex items-center gap-2 rounded-2xl bg-green-50 border border-green-200 px-5 py-3 text-sm font-semibold text-green-700 font-inter">
                      <ShieldCheck size={16} className="shrink-0" /> Marketplace is approved to transfer tokens from this collection.
                    </div>
                  ) : approvalStatus === false ? (
                    <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 space-y-3">
                      <div className="flex items-start gap-2 text-sm text-amber-800 font-inter">
                        <ShieldAlert size={16} className="shrink-0 mt-0.5" />
                        <span>
                          <strong className="font-bold">One-time approval required.</strong> The marketplace needs
                          operator approval on this collection before it can escrow your NFT.
                        </span>
                      </div>
                      {approvalError && <p className="text-xs text-red-600 font-inter" role="alert">{approvalError}</p>}
                      <GuardButton
                        type="button"
                        onAction={handleApprove}
                        disabled={isApproving}
                        actionName="to approve the marketplace"
                        className="flex items-center gap-2 rounded-xl bg-amber-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-amber-700 disabled:opacity-50 transition-all"
                      >
                        {isApproving ? (
                          <>
                            <Loader2 size={14} className="animate-spin" /> Approving…
                          </>
                        ) : (
                          <>
                            <ShieldCheck size={14} /> Approve Marketplace
                          </>
                        )}
                      </GuardButton>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Step 2: Pricing & Asset ── */}
        {step === 2 && (
          <div>
            <h2 className="text-2xl font-display font-bold text-gray-900 mb-2">Set Your Price</h2>
            <p className="text-gray-500 font-inter mb-6">Choose the payment asset and the listing price.</p>
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="block text-sm font-bold text-gray-950 uppercase tracking-wider font-inter">
                  Payment Token *
                </label>
                <select
                  disabled={!hasTokenOptions}
                  value={form.tokenAddress}
                  onChange={(e) => setForm((cur) => ({ ...cur, tokenAddress: e.target.value }))}
                  className="w-full appearance-none rounded-2xl border border-gray-200 bg-gray-50/50 px-5 py-4 text-base focus:outline-none focus:border-brand-500 focus:bg-white transition-all shadow-sm font-inter"
                >
                  {hasTokenOptions ? (
                    availableTokens.map((t) => (
                      <option key={t.address} value={t.address}>{t.name} ({t.symbol})</option>
                    ))
                  ) : (
                    <option value="">No supported tokens available</option>
                  )}
                </select>
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-bold text-gray-950 uppercase tracking-wider font-inter">
                  Price ({selectedToken.symbol}) *
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={form.price}
                  onChange={(e) => setForm((cur) => ({ ...cur, price: e.target.value }))}
                  placeholder="0.00"
                  className={`w-full rounded-2xl border px-5 py-4 text-base font-inter focus:outline-none transition-all shadow-sm ${
                    nextAttempted && !priceValidation.valid ? "border-red-400 bg-red-50/40" : "border-gray-200 bg-gray-50/50 focus:border-brand-500 focus:bg-white"
                  }`}
                />
                {nextAttempted && !priceValidation.valid && priceValidation.message && (
                  <p className="text-sm text-red-600" role="alert">{priceValidation.message}</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Step 3: Royalty Split ── */}
        {step === 3 && (
          <div>
            <h2 className="text-2xl font-display font-bold text-gray-900 mb-2">Revenue Split</h2>
            <p className="text-gray-500 font-inter mb-6">
              Percentages must sum to exactly 100%. Max {MAX_RECIPIENTS} recipients.
            </p>
            <div className="space-y-3">
              {form.recipients.map((recipient, idx) => {
                const rowErr = recipientRowErrors[idx];
                return (
                  <div key={idx} className="flex flex-col sm:flex-row gap-3 items-start">
                    <div className="w-full sm:flex-1 space-y-1">
                      <input
                        value={recipient.address}
                        onChange={(e) => updateRecipient(idx, "address", e.target.value)}
                        placeholder="Stellar address (G...)"
                        aria-label={`Recipient ${idx + 1} address`}
                        className={`w-full rounded-2xl border px-4 py-3 text-sm font-inter focus:outline-none transition-all ${
                          nextAttempted && rowErr?.address ? "border-red-400 bg-red-50/40" : "border-gray-200 bg-gray-50/50 focus:border-brand-500 focus:bg-white"
                        }`}
                      />
                      {nextAttempted && rowErr?.address && <p className="text-xs text-red-600" role="alert">{rowErr.address}</p>}
                    </div>
                    <div className="w-full sm:w-28 space-y-1">
                      <div className="relative">
                        <input
                          type="number"
                          min={1}
                          max={100}
                          step={1}
                          value={recipient.percentage}
                          onChange={(e) => updateRecipient(idx, "percentage", parseFloat(e.target.value) || 0)}
                          aria-label={`Recipient ${idx + 1} percentage`}
                          className={`w-full rounded-2xl border px-4 py-3 pr-8 text-sm font-inter focus:outline-none transition-all ${
                            nextAttempted && rowErr?.percentage ? "border-red-400 bg-red-50/40" : "border-gray-200 bg-gray-50/50 focus:border-brand-500 focus:bg-white"
                          }`}
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-gray-400">%</span>
                      </div>
                      {nextAttempted && rowErr?.percentage && <p className="text-xs text-red-600" role="alert">{rowErr.percentage}</p>}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeRecipient(idx)}
                      disabled={form.recipients.length <= 1}
                      aria-label={`Remove recipient ${idx + 1}`}
                      className="mt-2.5 rounded-xl p-2.5 text-gray-400 hover:bg-red-50 hover:text-red-500 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                );
              })}
            </div>
            {form.recipients.length < MAX_RECIPIENTS && (
              <button
                type="button"
                onClick={addRecipient}
                className="mt-3 flex items-center gap-1.5 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-100 transition-all"
              >
                <Plus size={14} /> Add Recipient
              </button>
            )}
            <div className="flex items-center justify-between text-sm mt-4">
              <span className="text-gray-500 font-inter">Total split:</span>
              <span className={`font-bold tabular-nums ${royaltiesStepValid ? "text-green-600" : "text-red-600"}`}>
                {form.recipients.reduce((s, r) => s + (r.percentage || 0), 0).toFixed(2)}%
              </span>
            </div>
            {nextAttempted && recipientsError && (
              <p className="text-sm text-red-600 mt-1" role="alert">{recipientsError}</p>
            )}
          </div>
        )}

        {/* ── Step 4: Expiry ── */}
        {step === 4 && (
          <div>
            <h2 className="text-2xl font-display font-bold text-gray-900 mb-2">Listing Expiry</h2>
            <p className="text-gray-500 font-inter mb-6">Optionally set when this listing should automatically expire.</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
              {EXPIRY_PRESETS.map((preset) => (
                <label
                  key={preset.id}
                  className={`flex items-center gap-2 rounded-xl border-2 px-4 py-3 cursor-pointer transition-all ${
                    form.expiryOption === preset.id ? "border-brand-500 bg-brand-50/50" : "border-gray-100"
                  }`}
                >
                  <input
                    type="radio"
                    name="expiryOption"
                    checked={form.expiryOption === preset.id}
                    onChange={() => setForm((cur) => ({ ...cur, expiryOption: preset.id }))}
                    className="sr-only"
                  />
                  <Clock size={14} />
                  <span className="text-sm font-semibold">{preset.label}</span>
                </label>
              ))}
            </div>
            {form.expiryOption === "custom" && (
              <div className="space-y-2">
                <label className="block text-sm font-bold text-gray-950 uppercase tracking-wider font-inter">
                  Expiry Date &amp; Time *
                </label>
                <input
                  type="datetime-local"
                  value={form.customExpiry}
                  onChange={(e) => setForm((cur) => ({ ...cur, customExpiry: e.target.value }))}
                  className={`w-full rounded-2xl border px-5 py-4 text-base font-inter focus:outline-none transition-all shadow-sm ${
                    nextAttempted && !expiryStepValid ? "border-red-400 bg-red-50/40" : "border-gray-200 bg-gray-50/50 focus:border-brand-500 focus:bg-white"
                  }`}
                />
                {nextAttempted && !expiryStepValid && (
                  <p className="text-sm text-red-600" role="alert">Choose a future date and time.</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Step 5: Review & Sign ── */}
        {step === 5 && (
          <div>
            <h2 className="text-2xl font-display font-bold text-gray-900 mb-2">Review &amp; Sign</h2>
            <p className="text-gray-500 font-inter mb-6">
              This is the exact transaction that will be sent to your wallet for signing.
            </p>

            <div className="space-y-3 mb-6 rounded-2xl border border-gray-100 bg-gray-50/50 p-6">
              {[
                { label: "Collection", value: form.collectionAddress, mono: true },
                { label: "Token ID", value: form.nftTokenId },
                { label: "Edition Type", value: isMultiEdition ? "Multi-edition (1155)" : "Single-edition (721)" },
                ...(isMultiEdition ? [{ label: "Quantity", value: form.quantity }] : []),
                { label: "Price", value: `${form.price} ${selectedToken.symbol}` },
                { label: "Payment Token", value: `${selectedToken.name} (${selectedToken.symbol})`, mono: true },
                {
                  label: "Recipients",
                  value: form.recipients.map((r) => `${truncateAddress(r.address)} — ${r.percentage}%`).join(", "),
                },
                { label: "Expiry", value: expiryUnix ? formatDate(expiryUnix * 1000, { showTime: true }) : "No expiry" },
              ].map(({ label, value, mono }) => (
                <div key={label} className="flex flex-wrap items-start justify-between gap-2 py-3 border-b border-gray-100 last:border-0">
                  <span className="text-sm font-bold text-gray-500 uppercase tracking-wider font-inter">{label}</span>
                  <span className={`text-sm font-medium text-gray-900 text-right break-all ${mono ? "font-mono" : ""}`}>{value}</span>
                </div>
              ))}
            </div>

            {feePreview && (
              <div className="mb-6 rounded-2xl border border-brand-100 bg-brand-50/40 p-6 space-y-2">
                <h3 className="text-sm font-bold text-brand-700 uppercase tracking-wider font-inter mb-2">Fee Preview</h3>
                <div className="flex justify-between text-sm"><span className="text-gray-600">{feePreview.price.label}</span><span className="font-semibold">{feePreview.price.display}</span></div>
                <div className="flex justify-between text-sm"><span className="text-gray-600">{feePreview.protocolFee.label}</span><span className="font-semibold">{feePreview.protocolFee.display}</span></div>
                <div className="flex justify-between text-sm border-t border-brand-100 pt-2"><span className="font-bold text-gray-700">{feePreview.total.label}</span><span className="font-bold">{feePreview.total.display}</span></div>
                <p className="text-xs text-gray-500 font-inter pt-1">{feePreview.roundingNote}</p>
              </div>
            )}

            {!allStepsValid && (
              <div className="mb-6 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800 font-inter">
                <Info size={16} className="shrink-0 mt-0.5" />
                Some earlier steps still need attention before you can sign. Use Back to fix them.
              </div>
            )}

            {isBusy && (
              <div className="mb-4 flex items-center gap-3 rounded-2xl bg-brand-50 px-6 py-4 text-sm font-semibold text-brand-700 animate-pulse">
                <Loader2 size={20} className="animate-spin" /> {txStateLabel(listingTxState.state)}
              </div>
            )}

            {listingTxState.state === "error" && listingTxState.error && (
              <TxErrorPanel
                error={listingTxState.error}
                txHash={listingTxState.txHash}
                onRetry={resetListingTx}
                onDismiss={resetListingTx}
              />
            )}

            {listingTxState.txHash && listingTxState.state !== "success" && (
              <p className="text-xs text-gray-400 text-center mt-3">
                Transaction:{" "}
                <Link href={`/tx/${listingTxState.txHash}`} className="font-mono text-blue-500 hover:underline" target="_blank">
                  {listingTxState.txHash.slice(0, 12)}…
                </Link>
              </p>
            )}

            {createError && listingTxState.state !== "error" && (
              <p className="rounded-2xl bg-red-50 px-6 py-4 text-sm font-bold text-red-600 border border-red-100 mt-4">{createError}</p>
            )}

            <GuardButton
              type="button"
              disabled={isBusy || !allStepsValid}
              actionName="to sign and create your listing"
              onAction={handleSign}
              className="w-full mt-6 flex items-center justify-center gap-3 rounded-2xl bg-brand-500 py-5 text-xl font-bold text-white shadow-2xl shadow-brand-500/30 hover:bg-brand-600 hover:scale-[1.01] transition-all active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100"
            >
              {isBusy ? (
                <>
                  <Loader2 size={24} className="animate-spin" /> {txStateLabel(listingTxState.state)}
                </>
              ) : (
                <>
                  <ShieldCheck size={24} /> Sign &amp; Create Listing
                </>
              )}
            </GuardButton>
          </div>
        )}

        {/* Step navigation */}
        <div className="flex justify-between mt-10 pt-6 border-t border-gray-100">
          {step > 0 ? (
            <button
              type="button"
              onClick={goBack}
              disabled={isBusy}
              className="flex items-center gap-2 px-6 py-3 rounded-xl border border-gray-200 bg-white text-gray-700 font-bold hover:bg-gray-50 transition-all disabled:opacity-50"
            >
              <ArrowLeft size={18} /> Back
            </button>
          ) : onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="flex items-center gap-2 px-6 py-3 rounded-xl border border-gray-200 bg-white text-gray-700 font-bold hover:bg-gray-50 transition-all"
            >
              Cancel
            </button>
          ) : (
            <div />
          )}

          {step < STEPS.length - 1 && (
            <button
              type="button"
              aria-disabled={!stepValidity[step]}
              onClick={goNext}
              className={`flex items-center gap-2 px-8 py-3 rounded-xl bg-brand-500 text-white font-bold hover:bg-brand-600 transition-all ${
                !stepValidity[step] ? "opacity-50" : ""
              }`}
            >
              Next <ArrowRight size={18} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
