// ─────────────────────────────────────────────────────────────
// components/OfferStatusBadge.tsx — shared offer status pill
//
// Issue #528: the same status → Tailwind class / label logic was
// duplicated across offers/page.tsx, offers/incoming/page.tsx, and
// OfferPanel.tsx. This centralizes it on top of the existing
// OfferUIStatus/deriveOfferUIStatus primitives from lib/contract.ts.
// ─────────────────────────────────────────────────────────────

"use client";

import { clsx } from "clsx";
import { OfferUIStatus } from "@/lib/contract";

/**
 * Tailwind classes for an offer status pill. Matches the classes previously
 * hand-duplicated in offers/page.tsx, offers/incoming/page.tsx, and
 * OfferPanel.tsx exactly — no visual regression.
 */
export function getOfferStatusBadgeClass(uiStatus: OfferUIStatus): string {
  switch (uiStatus) {
    case "Pending":   return "bg-brand-500/10 text-brand-400 border-brand-500/20";
    case "Accepted":  return "bg-mint-500/10 text-mint-400 border-mint-500/20";
    case "Rejected":  return "bg-terracotta-500/10 text-terracotta-400 border-terracotta-500/20";
    case "Withdrawn": return "bg-white/5 text-white/30 border-white/10";
    case "Expired":   return "bg-amber-500/10 text-amber-400 border-amber-500/20";
    case "Stale":     return "bg-yellow-500/10 text-yellow-400 border-yellow-500/20";
    default:          return "bg-white/5 text-white/30 border-white/10";
  }
}

/**
 * Human-readable, terminal-explaining label for a given UI status.
 * Used for screen-reader text / tooltips so a terminal state ("Rejected",
 * "Withdrawn", "Expired") reads as an explanation, not just a word.
 */
export function getOfferStatusExplanation(uiStatus: OfferUIStatus): string {
  switch (uiStatus) {
    case "Pending":   return "Awaiting a response from the listing owner.";
    case "Accepted":  return "Accepted — the listing was sold to this offerer.";
    case "Rejected":  return "Rejected by the listing owner. Escrowed funds were refunded.";
    case "Withdrawn": return "Withdrawn by the offerer, or its escrow was reclaimed after expiry.";
    case "Expired":   return "Expired without a response. The offerer can reclaim the escrowed funds.";
    case "Stale":     return "Showing the last known state — refresh to confirm it is still current.";
    default:          return "";
  }
}

export interface OfferStatusBadgeProps {
  uiStatus: OfferUIStatus;
  /**
   * "lg" matches the offer-card badge used in offers/page.tsx and
   * offers/incoming/page.tsx (px-4 py-1.5, text-[10px], tracking-[0.2em]).
   * "sm" matches the compact badge used for historical offers in
   * OfferPanel.tsx (px-3 py-1, text-[9px], tracking-widest).
   */
  size?: "lg" | "sm";
  /** Optional data-testid passthrough so existing test hooks keep working. */
  "data-testid"?: string;
  className?: string;
}

export function OfferStatusBadge({ uiStatus, size = "lg", className, ...rest }: OfferStatusBadgeProps) {
  return (
    <span
      {...rest}
      title={getOfferStatusExplanation(uiStatus)}
      className={clsx(
        "rounded-full font-bold uppercase border",
        size === "lg"
          ? "px-4 py-1.5 text-[10px] tracking-[0.2em]"
          : "px-3 py-1 text-[9px] tracking-widest",
        getOfferStatusBadgeClass(uiStatus),
        className
      )}
    >
      {uiStatus}
    </span>
  );
}
