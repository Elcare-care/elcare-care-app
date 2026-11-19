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
import { t } from "@/lib/i18n";

interface ProvisionalBadgeProps {
  recordState: RecordState;
  className?: string;
}

const CONFIG: Record<
  Exclude<RecordState, "confirmed">,
  { labelKey: Parameters<typeof t>[0]; icon: React.ElementType; classes: string; spin: boolean; titleKey: Parameters<typeof t>[0] }
> = {
  pending: {
    labelKey: "provisional_pending_label",
    icon: Loader2,
    classes: "bg-brand-500/20 text-brand-300 border-brand-500/30",
    spin: true,
    titleKey: "provisional_pending_title",
  },
  stale: {
    labelKey: "provisional_stale_label",
    icon: AlertTriangle,
    classes: "bg-amber-500/20 text-amber-300 border-amber-500/30",
    spin: false,
    titleKey: "provisional_stale_title",
  },
  rejected: {
    labelKey: "provisional_rejected_label",
    icon: RotateCcw,
    classes: "bg-terracotta-500/20 text-terracotta-300 border-terracotta-500/30",
    spin: false,
    titleKey: "provisional_rejected_title",
  },
};

/**
 * Renders nothing for "confirmed" state — the badge only ever calls out
 * non-final, provisional, or rolled-back state so it stays out of the way
 * once a value is settled.
 */
export function ProvisionalBadge({ recordState, className = "" }: ProvisionalBadgeProps) {
  if (recordState === "confirmed") return null;

  const { labelKey, icon: Icon, classes, spin, titleKey } = CONFIG[recordState];
  const label = t(labelKey);
  const title = t(titleKey);

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
