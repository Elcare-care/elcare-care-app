"use client";

/**
 * components/SupportForm.tsx
 *
 * Work item B — Context-aware support report form.
 *
 * Accepts optional pre-filled context (listingId, auctionId, txHash, ipfsCid)
 * so the form can be opened directly from any listing, auction, collection, or
 * transaction page.
 *
 * Accessibility:
 *  • aria-required, aria-invalid, aria-describedby on all inputs
 *  • Role="alert" on the secret-rejection banner
 *  • Focus moves to the confirmation message on successful submission
 */

import { useState, useRef, useCallback, useId } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ShieldOff,
  ExternalLink,
} from "lucide-react";
import {
  SUPPORT_CATEGORIES,
  SupportCategory,
  SupportFormInput,
  SupportFormErrors,
  validateSupportForm,
} from "@/lib/support";

export interface SupportFormContext {
  listingId?: string | number;
  auctionId?: string | number;
  txHash?: string;
  ipfsCid?: string;
  collectionAddress?: string;
}

interface SupportFormProps {
  context?: SupportFormContext;
  /** Called after successful submission */
  onSubmitted?: (reportId: string) => void;
  className?: string;
}

const EMPTY_FORM: SupportFormInput = {
  category: '',
  resourceId: '',
  transactionHash: '',
  ipfsCid: '',
  screenshotUrl: '',
  description: '',
  reporterAddress: '',
};

function deriveResourceId(ctx?: SupportFormContext): string {
  if (!ctx) return '';
  if (ctx.listingId != null) return String(ctx.listingId);
  if (ctx.auctionId != null) return String(ctx.auctionId);
  if (ctx.collectionAddress) return ctx.collectionAddress;
  return '';
}

export function SupportForm({ context, onSubmitted, className = '' }: SupportFormProps) {
  const formId = useId();
  const confirmRef = useRef<HTMLDivElement>(null);

  const [form, setForm] = useState<SupportFormInput>({
    ...EMPTY_FORM,
    resourceId:      deriveResourceId(context),
    transactionHash: context?.txHash ?? '',
    ipfsCid:         context?.ipfsCid ?? '',
  });
  const [errors, setErrors]         = useState<SupportFormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [reportId, setReportId]     = useState<string | null>(null);
  const [slaHours, setSlaHours]     = useState<number | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const set = useCallback((field: keyof SupportFormInput, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined, _secret: undefined }));
    setServerError(null);
  }, []);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validateSupportForm(form);
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setSubmitting(true);
    setServerError(null);
    try {
      const res = await fetch('/api/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setServerError(data.error ?? 'Submission failed. Please try again.');
        if (data.fields) setErrors(data.fields);
      } else {
        setReportId(data.id);
        setSlaHours(data.responseSlaHours ?? null);
        onSubmitted?.(data.id);
        setTimeout(() => confirmRef.current?.focus(), 50);
      }
    } catch {
      setServerError('Network error. Please check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }, [form, onSubmitted]);

  const selectedMeta = form.category ? SUPPORT_CATEGORIES[form.category as SupportCategory] : null;

  // ── Confirmation screen ──────────────────────────────────────────────────
  if (reportId) {
    return (
      <div
        ref={confirmRef}
        tabIndex={-1}
        className={`rounded-2xl bg-green-50 border border-green-200 p-6 space-y-3 outline-none ${className}`}
        role="status"
        aria-live="polite"
        data-testid="support-confirmation"
      >
        <div className="flex items-center gap-3">
          <CheckCircle2 className="text-green-600 shrink-0" size={24} aria-hidden="true" />
          <h2 className="text-lg font-bold text-green-900">Report submitted</h2>
        </div>
        <p className="text-sm text-green-800">
          Your report ID is <strong className="font-mono">{reportId}</strong>. Keep this for follow-up.
        </p>
        {slaHours != null && (
          <p className="text-sm text-green-700">
            We aim to respond within <strong>{slaHours} business hours</strong>.
          </p>
        )}
        <p className="text-xs text-green-600">
          Status updates will reflect on this page. Platform-remediable issues
          (display bugs, UI delisting) can typically be resolved quickly.
          On-chain transactions are immutable and cannot be reversed.{' '}
          <a href="/help" className="underline hover:text-green-800 inline-flex items-center gap-1">
            Learn more <ExternalLink size={11} aria-hidden="true" />
          </a>
        </p>
      </div>
    );
  }

  return (
    <form
      id={`${formId}-form`}
      onSubmit={handleSubmit}
      noValidate
      className={`space-y-5 ${className}`}
      data-testid="support-form"
      aria-label="Submit a support report"
    >

      {/* Secret-rejection banner */}
      {errors._secret && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-red-300 bg-red-50 p-4"
          data-testid="support-secret-error"
        >
          <ShieldOff size={18} className="text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
          <p className="text-sm text-red-800">{errors._secret}</p>
        </div>
      )}

      {/* Server error */}
      {serverError && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
          <AlertTriangle size={18} className="text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
          <p className="text-sm text-red-800">{serverError}</p>
        </div>
      )}

      {/* Category */}
      <div className="space-y-1">
        <label htmlFor={`${formId}-category`} className="block text-sm font-medium text-gray-700">
          Report category <span aria-hidden="true">*</span>
        </label>
        <select
          id={`${formId}-category`}
          value={form.category}
          onChange={(e) => set('category', e.target.value)}
          required
          aria-required="true"
          aria-invalid={!!errors.category}
          aria-describedby={errors.category ? `${formId}-category-err` : undefined}
          className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 aria-[invalid=true]:border-red-400 bg-white"
          data-testid="support-category-select"
        >
          <option value="">— Select a category —</option>
          {(Object.keys(SUPPORT_CATEGORIES) as SupportCategory[]).map((key) => (
            <option key={key} value={key}>{SUPPORT_CATEGORIES[key].label}</option>
          ))}
        </select>
        {errors.category && (
          <p id={`${formId}-category-err`} role="alert" className="text-xs text-red-600">{errors.category}</p>
        )}
      </div>

      {/* Platform limits notice */}
      {selectedMeta && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 space-y-1">
          <p className="font-semibold">What we can and cannot do</p>
          <p>{selectedMeta.platformLimits}</p>
          <p className="text-xs text-amber-600">
            Estimated first response: {selectedMeta.responseSlaHours} business hours
          </p>
        </div>
      )}

      {/* Resource ID */}
      <div className="space-y-1">
        <label htmlFor={`${formId}-resource`} className="block text-sm font-medium text-gray-700">
          Listing / Auction / Collection ID
          {selectedMeta?.requiredEvidence.includes('resource_id') && (
            <span aria-hidden="true"> *</span>
          )}
        </label>
        <input
          id={`${formId}-resource`}
          type="text"
          value={form.resourceId}
          onChange={(e) => set('resourceId', e.target.value)}
          placeholder="e.g. 1234 or GABCDEF…"
          aria-required={selectedMeta?.requiredEvidence.includes('resource_id') ?? false}
          aria-invalid={!!errors.resourceId}
          aria-describedby={errors.resourceId ? `${formId}-resource-err` : undefined}
          className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 aria-[invalid=true]:border-red-400"
          data-testid="support-resource-id"
        />
        {errors.resourceId && (
          <p id={`${formId}-resource-err`} role="alert" className="text-xs text-red-600">{errors.resourceId}</p>
        )}
      </div>

      {/* Transaction hash */}
      <div className="space-y-1">
        <label htmlFor={`${formId}-txhash`} className="block text-sm font-medium text-gray-700">
          Transaction hash
          {selectedMeta?.requiredEvidence.includes('transaction_hash') && (
            <span aria-hidden="true"> *</span>
          )}
        </label>
        <input
          id={`${formId}-txhash`}
          type="text"
          value={form.transactionHash}
          onChange={(e) => set('transactionHash', e.target.value)}
          placeholder="64-character hex — from your wallet or Stellar Explorer"
          maxLength={64}
          aria-required={selectedMeta?.requiredEvidence.includes('transaction_hash') ?? false}
          aria-invalid={!!errors.transactionHash}
          aria-describedby={errors.transactionHash ? `${formId}-txhash-err` : `${formId}-txhash-hint`}
          className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm font-mono focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 aria-[invalid=true]:border-red-400"
          data-testid="support-tx-hash"
        />
        <p id={`${formId}-txhash-hint`} className="text-xs text-gray-400">
          Do not enter private keys. A transaction hash looks like: a1b2c3…
        </p>
        {errors.transactionHash && (
          <p id={`${formId}-txhash-err`} role="alert" className="text-xs text-red-600">{errors.transactionHash}</p>
        )}
      </div>

      {/* IPFS CID */}
      <div className="space-y-1">
        <label htmlFor={`${formId}-cid`} className="block text-sm font-medium text-gray-700">
          IPFS CID
          {selectedMeta?.requiredEvidence.includes('ipfs_cid') && (
            <span aria-hidden="true"> *</span>
          )}
        </label>
        <input
          id={`${formId}-cid`}
          type="text"
          value={form.ipfsCid}
          onChange={(e) => set('ipfsCid', e.target.value)}
          placeholder="e.g. QmXoypiz… or bafybei…"
          aria-required={selectedMeta?.requiredEvidence.includes('ipfs_cid') ?? false}
          aria-invalid={!!errors.ipfsCid}
          aria-describedby={errors.ipfsCid ? `${formId}-cid-err` : undefined}
          className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm font-mono focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 aria-[invalid=true]:border-red-400"
          data-testid="support-ipfs-cid"
        />
        {errors.ipfsCid && (
          <p id={`${formId}-cid-err`} role="alert" className="text-xs text-red-600">{errors.ipfsCid}</p>
        )}
      </div>

      {/* Screenshot URL */}
      <div className="space-y-1">
        <label htmlFor={`${formId}-screenshot`} className="block text-sm font-medium text-gray-700">
          Screenshot URL (optional)
        </label>
        <input
          id={`${formId}-screenshot`}
          type="url"
          value={form.screenshotUrl}
          onChange={(e) => set('screenshotUrl', e.target.value)}
          placeholder="https://…"
          aria-invalid={!!errors.screenshotUrl}
          aria-describedby={errors.screenshotUrl ? `${formId}-screenshot-err` : `${formId}-screenshot-hint`}
          className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 aria-[invalid=true]:border-red-400"
          data-testid="support-screenshot-url"
        />
        <p id={`${formId}-screenshot-hint`} className="text-xs text-gray-400">
          Upload to Imgur or similar and paste the public URL. Do not include secret credentials.
        </p>
        {errors.screenshotUrl && (
          <p id={`${formId}-screenshot-err`} role="alert" className="text-xs text-red-600">{errors.screenshotUrl}</p>
        )}
      </div>

      {/* Description */}
      <div className="space-y-1">
        <label htmlFor={`${formId}-desc`} className="block text-sm font-medium text-gray-700">
          Description <span aria-hidden="true">*</span>
        </label>
        <textarea
          id={`${formId}-desc`}
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          rows={5}
          maxLength={2000}
          required
          aria-required="true"
          aria-invalid={!!errors.description}
          aria-describedby={`${formId}-desc-hint${errors.description ? ` ${formId}-desc-err` : ''}`}
          placeholder="Describe the issue clearly. Do NOT include private keys, seed phrases, or passwords."
          className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 aria-[invalid=true]:border-red-400 resize-y"
          data-testid="support-description"
        />
        <p id={`${formId}-desc-hint`} className="text-xs text-gray-400">
          {form.description.length}/2000 characters.
        </p>
        {errors.description && (
          <p id={`${formId}-desc-err`} role="alert" className="text-xs text-red-600">{errors.description}</p>
        )}
      </div>

      {/* Reporter address (optional) */}
      <div className="space-y-1">
        <label htmlFor={`${formId}-addr`} className="block text-sm font-medium text-gray-700">
          Your Stellar address (optional, for follow-up)
        </label>
        <input
          id={`${formId}-addr`}
          type="text"
          value={form.reporterAddress}
          onChange={(e) => set('reporterAddress', e.target.value)}
          placeholder="GABC… (public address only)"
          maxLength={56}
          aria-invalid={!!errors.reporterAddress}
          aria-describedby={`${formId}-addr-hint${errors.reporterAddress ? ` ${formId}-addr-err` : ''}`}
          className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm font-mono focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 aria-[invalid=true]:border-red-400"
          data-testid="support-reporter-address"
        />
        <p id={`${formId}-addr-hint`} className="text-xs text-gray-400">
          Public address only — never your secret key or seed phrase.
        </p>
        {errors.reporterAddress && (
          <p id={`${formId}-addr-err`} role="alert" className="text-xs text-red-600">{errors.reporterAddress}</p>
        )}
      </div>

      {/* Submit */}
      <button
        type="submit"
        disabled={submitting}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-500 py-4 font-bold text-white shadow-lg shadow-brand-500/20 hover:bg-brand-600 transition-all disabled:opacity-50"
        data-testid="support-submit-button"
      >
        {submitting ? (
          <><Loader2 size={18} className="animate-spin" aria-hidden="true" />Submitting…</>
        ) : (
          'Submit Report'
        )}
      </button>

      <p className="text-xs text-center text-gray-400">
        By submitting you agree to our{' '}
        <a href="/privacy" className="underline hover:text-gray-600">Privacy Policy</a>.
        We store report metadata but never your private keys or seed phrases.
      </p>
    </form>
  );
}
