"use client";

// ─────────────────────────────────────────────────────────────
// components/a11y/StatusAnnouncer.tsx
//
// Visually-hidden live region for transaction/wallet dialogs.
// Mount one per dialog and pass the current human-readable status
// (e.g. "Awaiting signature…", "Purchase complete") so screen-reader
// users hear state changes that sighted users see as spinners,
// checkmarks, or color changes.
// ─────────────────────────────────────────────────────────────

interface StatusAnnouncerProps {
  message: string | null | undefined;
  /** "assertive" interrupts current speech — reserve for failures. */
  politeness?: "polite" | "assertive";
}

export function StatusAnnouncer({ message, politeness = "polite" }: StatusAnnouncerProps) {
  return (
    <div role="status" aria-live={politeness} aria-atomic="true" className="sr-only">
      {message ?? ""}
    </div>
  );
}
