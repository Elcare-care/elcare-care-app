"use client";

// ─────────────────────────────────────────────────────────────
// components/ProvisionalBadge.tsx
//
// Issue #520 — Optimistic listing/auction/offer updates with reorg
// rollback.
//
// A small, explicit marker that distinguishes a record's provisional
// (locally-submitted, not yet indexer-confirmed) state from its
// confirmed state. It intentionally never claims finality — the
// pending variant reads "Pending confirmation", not "Done"/"Success" —
// so a viewer can never mistake an optimistic value for a settled one.
//
// Backed by the RecordState produced by useReconciliation's
// getResourceState(): "confirmed" | "pending" | "rejected" | "stale".
// ─────────────────────────────────────────────────────────────

import { Loader2, RotateCcw, AlertTriangle } from "lucide-react";
import type { RecordState } from "@/hooks/useReconciliation";

interface ProvisionalBadgeProps {
  recordState: RecordState;
  className?: string;
}

const CONFIG: Record<
  Exclude<RecordState, "confirmed">,
  { label: string; icon: React.ElementType; classes: string; spin: boolean; title: string }
> = {
  pending: {
    label: "Pending confirmation",
    icon: Loader2,
    classes: "bg-brand-500/20 text-brand-300 border-brand-500/30",
    spin: true,
    title:
      "This transaction was just submitted and is shown optimistically. It has not yet been confirmed by the indexer.",
  },
  stale: {
    label: "Confirmation delayed",
    icon: AlertTriangle,
    classes: "bg-amber-500/20 text-amber-300 border-amber-500/30",
    spin: false,
    title:
      "This transaction is taking longer than expected to confirm. The value shown may not reflect the latest on-chain state.",
  },
  rejected: {
    label: "Update reverted",
    icon: RotateCcw,
    classes: "bg-terracotta-500/20 text-terracotta-300 border-terracotta-500/30",
    spin: false,
    title: "This transaction failed or was rolled back — showing the last confirmed value.",
  },
};

/**
 * Renders nothing for "confirmed" state — the badge only ever calls out
 * non-final, provisional, or rolled-back state so it stays out of the way
 * once a value is settled.
 */
export function ProvisionalBadge({ recordState, className = "" }: ProvisionalBadgeProps) {
  if (recordState === "confirmed") return null;

  const { label, icon: Icon, classes, spin, title } = CONFIG[recordState];

  return (
    <span
      role="status"
      data-testid="provisional-badge"
      data-record-state={recordState}
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-widest backdrop-blur-md ${classes} ${className}`}
    >
      <Icon size={11} className={spin ? "animate-spin" : undefined} aria-hidden="true" />
      {label}
    </span>
  );
}
