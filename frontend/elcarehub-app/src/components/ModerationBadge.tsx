"use client";

// ─────────────────────────────────────────────────────────────
// components/ModerationBadge.tsx
//
// Issue #308 / #43 — Displays the moderation state of an
// uploaded asset so users can distinguish creator-provided
// content from platform-verified content.
//
// States:
//   PENDING     — grey badge, "Under review"
//   APPROVED    — green badge, "Verified"
//   REPORTED    — amber badge, "Reported"
//   QUARANTINED — red badge, "Under investigation"
//   REJECTED    — red badge, "Blocked"
// ─────────────────────────────────────────────────────────────

import React from "react";
import { ShieldCheck, Clock, AlertTriangle, Ban, Flag } from "lucide-react";
import type { ModerationState } from "@/lib/moderation";

interface ModerationBadgeProps {
  state: ModerationState;
  /** When true, renders a compact icon-only pill */
  compact?: boolean;
  className?: string;
}

const CONFIG: Record<
  ModerationState,
  { label: string; icon: React.ElementType; classes: string; title: string }
> = {
  PENDING: {
    label: "Under review",
    icon: Clock,
    classes: "bg-gray-100 text-gray-600 border-gray-200",
    title: "This content is awaiting platform review before it is fully verified.",
  },
  APPROVED: {
    label: "Verified",
    icon: ShieldCheck,
    classes: "bg-mint-50 text-mint-700 border-mint-200",
    title: "This content has been reviewed and approved by the platform.",
  },
  REPORTED: {
    label: "Reported",
    icon: Flag,
    classes: "bg-amber-50 text-amber-700 border-amber-200",
    title: "This content has been flagged by community members and is under review.",
  },
  QUARANTINED: {
    label: "Under investigation",
    icon: AlertTriangle,
    classes: "bg-red-50 text-red-700 border-red-200",
    title: "This content is under active investigation and has been temporarily hidden.",
  },
  REJECTED: {
    label: "Blocked",
    icon: Ban,
    classes: "bg-red-100 text-red-800 border-red-300",
    title: "This content has been permanently blocked and cannot be minted or promoted.",
  },
};

export function ModerationBadge({ state, compact = false, className = "" }: ModerationBadgeProps) {
  const { label, icon: Icon, classes, title } = CONFIG[state] ?? CONFIG.PENDING;

  if (compact) {
    return (
      <span
        className={`inline-flex items-center justify-center w-6 h-6 rounded-full border ${classes} ${className}`}
        title={title}
        aria-label={label}
      >
        <Icon size={12} aria-hidden="true" />
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-semibold ${classes} ${className}`}
      title={title}
      aria-label={`Moderation state: ${label}`}
    >
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * Full-screen overlay shown when a quarantined or rejected asset is accessed directly.
 * Prevents blocked content from being displayed as artwork.
 */
export function ModerationBlockedOverlay({ state }: { state: ModerationState }) {
  if (state !== "QUARANTINED" && state !== "REJECTED") return null;

  const isRejected = state === "REJECTED";

  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center bg-midnight-950/95 backdrop-blur-sm z-20 rounded-inherit"
      role="alert"
      aria-live="assertive"
    >
      {isRejected ? (
        <Ban size={48} className="text-red-400 mb-3" aria-hidden="true" />
      ) : (
        <AlertTriangle size={48} className="text-amber-400 mb-3" aria-hidden="true" />
      )}
      <p className="text-white font-bold text-lg mb-1">
        {isRejected ? "Content Blocked" : "Content Under Investigation"}
      </p>
      <p className="text-white/60 text-sm text-center max-w-xs px-4">
        {isRejected
          ? "This content has been permanently removed from the platform and cannot be minted or traded."
          : "This content is temporarily hidden while our team reviews a report. If you believe this is an error, please contact support."}
      </p>
    </div>
  );
}
