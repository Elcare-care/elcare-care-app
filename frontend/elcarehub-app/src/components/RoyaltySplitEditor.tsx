// ─────────────────────────────────────────────────────────────
// components/RoyaltySplitEditor.tsx — reusable creator royalty split editor
// (Issue #529)
//
// Extracted from ListingForm.tsx's inline recipient-split UI so the same
// address-validated, duplicate-checked, total-limited split editor can be
// reused anywhere a listing or collection needs to collect a royalty split.
// ─────────────────────────────────────────────────────────────

"use client";

import { useMemo, useState } from "react";
import { Plus, Trash2, Copy } from "lucide-react";
import { isValidStellarAddress } from "@/lib/validation";
import { bpsToPercent, formatBps, percentToBps } from "@/lib/amount";

/** Default maximum recipients per split (mirrors contract's literal cap). */
export const DEFAULT_MAX_RECIPIENTS = 4;
/** Recipient percentages across a split must sum to exactly this value. */
export const REQUIRED_SPLIT_SUM = 100;

export interface RecipientInput {
  address: string;
  percentage: number;
}

export interface RecipientRowError {
  address?: string;
  percentage?: string;
}

export interface RecipientsValidation {
  /** Set when the recipient count or total percentage is invalid. */
  summary?: string;
  /** Per-row errors, aligned by index with the recipients array. */
  rows: RecipientRowError[];
  /** True only when every row and the summary are error-free. */
  valid: boolean;
}

/**
 * Validate a recipient split against the constraints mirrored from the
 * on-chain contract's `validate_recipients` (soroban-marketplace/src/contract.rs):
 *   - non-empty, at most `maxRecipients` rows (TooManyRecipients)
 *   - every address must be a checksum-valid Stellar address
 *   - every percentage must be > 0 (ZeroRecipientBps)
 *   - no duplicate addresses, case-insensitive / trimmed (DuplicateRecipient)
 *   - total must equal exactly 100% (tighter than the contract's <=10000bps
 *     cap — RoyaltyExceedsLimit — but matches product behaviour: a listing's
 *     revenue split must fully allocate the sale proceeds)
 */
export function validateRecipients(
  recipients: RecipientInput[],
  maxRecipients: number = DEFAULT_MAX_RECIPIENTS
): RecipientsValidation {
  const rows: RecipientRowError[] = recipients.map((r) => {
    const rowErr: RecipientRowError = {};
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

  // Duplicate detection — case-insensitive, trimmed (mirrors the contract's
  // DuplicateRecipient=44 invariant).
  const firstSeenAt = new Map<string, number>();
  recipients.forEach((r, i) => {
    const key = r.address.trim().toUpperCase();
    if (!key) return;
    if (firstSeenAt.has(key)) {
      const firstIdx = firstSeenAt.get(key)!;
      rows[i].address = rows[i].address ?? "Duplicate recipient address.";
      rows[firstIdx].address = rows[firstIdx].address ?? "Duplicate recipient address.";
    } else {
      firstSeenAt.set(key, i);
    }
  });

  let summary: string | undefined;
  if (recipients.length === 0) {
    summary = "At least one recipient is required.";
  } else if (recipients.length > maxRecipients) {
    summary = `A maximum of ${maxRecipients} recipients is allowed.`;
  } else {
    const total = recipients.reduce((sum, r) => sum + (r.percentage || 0), 0);
    if (Math.round(total) !== REQUIRED_SPLIT_SUM) {
      summary = `Recipient percentages must sum to exactly ${REQUIRED_SPLIT_SUM}% (currently ${total.toFixed(2)}%).`;
    }
  }

  const hasRowErrors = rows.some((r) => r.address !== undefined || r.percentage !== undefined);
  return { summary, rows, valid: !summary && !hasRowErrors };
}

export interface RoyaltySplitEditorProps {
  recipients: RecipientInput[];
  onChange: (recipients: RecipientInput[]) => void;
  /** Maximum number of recipient rows. Default 4 (contract cap). */
  maxRecipients?: number;
  /** Protocol fee in basis points, shown as contextual info (deducted separately, not part of the 100% split). */
  protocolFeeBps?: number;
  /** Collection-level royalty default, offered as a one-click seed for the split. */
  collectionDefault?: { address: string; bps: number } | null;
  disabled?: boolean;
  /** Force all validation messaging to show, e.g. after the parent form's submit attempt. */
  forceShowErrors?: boolean;
}

export function RoyaltySplitEditor({
  recipients,
  onChange,
  maxRecipients = DEFAULT_MAX_RECIPIENTS,
  protocolFeeBps,
  collectionDefault,
  disabled = false,
  forceShowErrors = false,
}: RoyaltySplitEditorProps) {
  const [touched, setTouched] = useState<Set<string>>(new Set());

  const validation = useMemo(
    () => validateRecipients(recipients, maxRecipients),
    [recipients, maxRecipients]
  );

  const recipientSum = recipients.reduce((s, r) => s + (r.percentage || 0), 0);

  function markTouched(field: string) {
    setTouched((prev) => new Set(prev).add(field));
  }

  function shouldShow(field: string): boolean {
    return forceShowErrors || touched.has(field);
  }

  function addRecipient() {
    if (recipients.length >= maxRecipients) return;
    onChange([...recipients, { address: "", percentage: 0 }]);
  }

  function removeRecipient(index: number) {
    if (recipients.length <= 1) return;
    onChange(recipients.filter((_, i) => i !== index));
  }

  function updateRecipient(index: number, field: "address" | "percentage", value: string | number) {
    onChange(recipients.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
    markTouched(`${field}_${index}`);
  }

  function useCollectionDefault() {
    if (!collectionDefault) return;
    onChange([
      {
        address: collectionDefault.address,
        percentage: bpsToPercent(collectionDefault.bps),
      },
    ]);
    markTouched("summary");
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <label className="block text-sm font-bold text-gray-950 uppercase tracking-wider font-inter">
            Revenue Split *
          </label>
          <p className="text-xs text-gray-500 mt-0.5 font-inter">
            Percentages must sum to exactly 100%. Max {maxRecipients} recipients.
          </p>
        </div>
        {recipients.length < maxRecipients && (
          <button
            type="button"
            onClick={addRecipient}
            disabled={disabled}
            className="flex items-center gap-1.5 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-100 transition-all disabled:opacity-50"
          >
            <Plus size={14} />
            Add Recipient
          </button>
        )}
      </div>

      {collectionDefault && (
        <button
          type="button"
          onClick={useCollectionDefault}
          disabled={disabled}
          className="flex items-center gap-1.5 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-100 transition-all disabled:opacity-50"
        >
          <Copy size={12} />
          Use collection default ({formatBps(collectionDefault.bps)} to {collectionDefault.address.slice(0, 6)}…)
        </button>
      )}

      <div className="space-y-3">
        {recipients.map((recipient, idx) => {
          const rowErrors = validation.rows[idx];
          const addressTouched = shouldShow(`address_${idx}`);
          const pctTouched = shouldShow(`percentage_${idx}`);
          return (
            <div key={idx} className="flex flex-col sm:flex-row gap-3 items-start">
              <div className="w-full sm:flex-1 space-y-1">
                <input
                  value={recipient.address}
                  onChange={(e) => updateRecipient(idx, "address", e.target.value)}
                  onBlur={() => markTouched(`address_${idx}`)}
                  disabled={disabled}
                  placeholder="Stellar address (G...)"
                  aria-label={`Recipient ${idx + 1} address`}
                  aria-invalid={addressTouched && !!rowErrors?.address}
                  className={`w-full rounded-2xl border px-4 py-3 text-sm focus:outline-none transition-all font-inter ${
                    addressTouched && rowErrors?.address
                      ? "border-red-400 bg-red-50/40 focus:border-red-500"
                      : "border-gray-200 bg-gray-50/50 focus:border-brand-500 focus:bg-white"
                  }`}
                />
                {addressTouched && rowErrors?.address && (
                  <p className="text-xs text-red-600" role="alert">
                    {rowErrors.address}
                  </p>
                )}
              </div>
              <div className="w-full sm:w-28 space-y-1">
                <div className="relative">
                  <input
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    value={recipient.percentage}
                    onChange={(e) =>
                      updateRecipient(idx, "percentage", parseFloat(e.target.value) || 0)
                    }
                    onBlur={() => markTouched(`percentage_${idx}`)}
                    disabled={disabled}
                    aria-label={`Recipient ${idx + 1} percentage`}
                    aria-invalid={pctTouched && !!rowErrors?.percentage}
                    className={`w-full rounded-2xl border px-4 py-3 pr-8 text-sm focus:outline-none transition-all font-inter ${
                      pctTouched && rowErrors?.percentage
                        ? "border-red-400 bg-red-50/40 focus:border-red-500"
                        : "border-gray-200 bg-gray-50/50 focus:border-brand-500 focus:bg-white"
                    }`}
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-gray-400">
                    %
                  </span>
                </div>
                <p className="text-[11px] text-gray-400 font-inter tabular-nums">
                  {formatBps(percentToBps(recipient.percentage || 0))}
                </p>
                {pctTouched && rowErrors?.percentage && (
                  <p className="text-xs text-red-600" role="alert">
                    {rowErrors.percentage}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => removeRecipient(idx)}
                disabled={disabled || recipients.length <= 1}
                aria-label={`Remove recipient ${idx + 1}`}
                className="mt-2.5 rounded-xl p-2.5 text-gray-400 hover:bg-red-50 hover:text-red-500 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Trash2 size={16} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Split sum indicator */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-gray-500 font-inter">Total split:</span>
        <span
          className={`font-bold tabular-nums ${
            Math.round(recipientSum) === REQUIRED_SPLIT_SUM ? "text-green-600" : "text-red-600"
          }`}
          aria-label={`Total recipient split: ${recipientSum}%`}
        >
          {recipientSum.toFixed(2)}% ({percentToBps(recipientSum)} bps){" "}
          {Math.round(recipientSum) !== REQUIRED_SPLIT_SUM && (
            <span className="text-xs font-normal text-red-500">(must be 100%)</span>
          )}
        </span>
      </div>

      {protocolFeeBps !== undefined && (
        <p className="text-xs text-gray-400 font-inter">
          Protocol fee: {formatBps(protocolFeeBps)} — deducted separately from the sale
          price, not part of the recipient split above.
        </p>
      )}

      {shouldShow("summary") && validation.summary && (
        <p className="text-sm text-red-600 mt-1" role="alert">
          {validation.summary}
        </p>
      )}
    </div>
  );
}
