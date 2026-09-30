"use client";

// ─────────────────────────────────────────────────────────────
// components/ReportContentButton.tsx
//
// Issue #542 — Formal content-moderation report entry point.
//
// Opens a small modal that lets any visitor (wallet optional) file a
// moderation report against an asset's image or metadata CID. Submits to
// POST /api/moderation/report (which proxies to the indexer — see
// lib/moderation.ts and indexer/src/api/moderation-routes.ts).
//
// Privacy: the reporter's wallet address, if provided, is sent to the
// indexer for dedupe/audit purposes only — it is never displayed publicly
// and is never echoed back in this component's own response handling.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import { Flag, X, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import type { ModerationAssetKind, ReportCategory } from "@/lib/moderation";
import { MODERATION_POLICY_URL } from "@/lib/moderation";

const CATEGORY_OPTIONS: { value: ReportCategory; label: string }[] = [
  { value: "PROHIBITED_CONTENT", label: "Prohibited content (hateful, violent, CSAM, etc.)" },
  { value: "INTELLECTUAL_PROPERTY", label: "Stolen artwork / IP infringement" },
  { value: "MISLEADING_METADATA", label: "Misleading or false metadata" },
  { value: "SPAM", label: "Spam" },
  { value: "MALWARE_SUSPECTED", label: "Malware suspected" },
  { value: "OTHER", label: "Other" },
];

interface ReportContentButtonProps {
  cid: string;
  kind?: ModerationAssetKind;
  reporterAddress?: string;
  className?: string;
}

export function ReportContentButton({
  cid,
  kind = "METADATA",
  reporterAddress,
  className = "",
}: ReportContentButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [category, setCategory] = useState<ReportCategory>("PROHIBITED_CONTENT");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<"idle" | "success" | "error">("idle");

  const handleSubmit = async () => {
    if (!cid) return;
    setIsSubmitting(true);
    setResult("idle");
    try {
      const res = await fetch("/api/moderation/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cid,
          kind,
          category,
          description: description.trim() || undefined,
          // Optional — never rendered publicly; used server-side for
          // dedupe and operator-only audit trails.
          reporterAddress,
        }),
      });
      if (!res.ok) throw new Error("Report submission failed");
      setResult("success");
      setDescription("");
    } catch {
      setResult("error");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        title="Report this content to moderators"
        data-testid="report-content-btn"
        className={`h-11 px-4 rounded-xl bg-white/5 hover:bg-red-500/10 hover:text-red-400 transition-all border border-white/10 flex items-center gap-2 text-xs font-bold text-white/60 ${className}`}
      >
        <Flag size={14} />
        <span className="hidden sm:inline">Report Content</span>
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-midnight-950/70 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Report content"
        >
          <div className="w-full max-w-md rounded-3xl bg-midnight-900 border border-white/10 p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2 text-white">
                <Flag size={18} className="text-red-400" />
                <h3 className="font-display text-lg font-bold">Report Content</h3>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setIsOpen(false)}
                className="rounded-lg p-1.5 text-white/40 hover:bg-white/10 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            {result === "success" ? (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <CheckCircle2 size={40} className="text-mint-400" />
                <p className="text-sm text-white/70">
                  Thank you — your report has been submitted for review. We never publish reporter
                  identities.
                </p>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="mt-2 rounded-full bg-white/10 px-5 py-2 text-sm font-bold text-white hover:bg-white/20"
                >
                  Close
                </button>
              </div>
            ) : (
              <>
                <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-white/40">
                  Reason
                </label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as ReportCategory)}
                  className="mb-4 w-full rounded-xl border border-white/10 bg-midnight-950 px-3 py-2.5 text-sm text-white focus:border-red-400 focus:outline-none"
                >
                  {CATEGORY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>

                <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-white/40">
                  Additional context (optional)
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value.slice(0, 1000))}
                  rows={4}
                  maxLength={1000}
                  placeholder="Describe the issue — this is only visible to moderators, never published."
                  className="mb-1 w-full resize-none rounded-xl border border-white/10 bg-midnight-950 px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:border-red-400 focus:outline-none"
                />
                <p className="mb-4 text-right text-[10px] text-white/30">{description.length}/1000</p>

                {result === "error" && (
                  <div className="mb-4 flex items-center gap-2 rounded-xl bg-red-500/10 border border-red-500/20 p-3 text-xs text-red-400">
                    <AlertCircle size={14} />
                    Something went wrong submitting your report. Please try again.
                  </div>
                )}

                <p className="mb-4 text-[11px] text-white/30 leading-relaxed">
                  Your wallet address (if connected) is used only to prevent duplicate reports and
                  is never shown publicly. Read our{" "}
                  <a
                    href={MODERATION_POLICY_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="underline text-white/50 hover:text-white"
                  >
                    moderation policy
                  </a>
                  .
                </p>

                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={handleSubmit}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-red-500 py-3 text-sm font-bold text-white transition-all hover:bg-red-600 disabled:opacity-50"
                >
                  {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : <Flag size={16} />}
                  Submit Report
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
