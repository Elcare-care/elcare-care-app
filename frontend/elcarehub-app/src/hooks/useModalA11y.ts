"use client";

import { useEffect, useRef, useId } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Focusable elements that are actually reachable — excludes disabled and hidden/off-screen ones. */
function getFocusable(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) =>
      el.offsetParent !== null &&
      el.getAttribute("aria-hidden") !== "true" &&
      !el.closest('[aria-hidden="true"]') &&
      !el.closest("[hidden]")
  );
}

export function useModalA11y(isOpen: boolean, onClose: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!isOpen) return;

    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    // Focus the dialog surface itself (not an arbitrary first field, which can
    // be surprising or trigger a mobile keyboard) so assistive tech announces
    // the dialog's label immediately on open.
    dialog?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab" || !dialog) return;

      const focusable = getFocusable(dialog);

      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement;

      // If focus somehow landed outside the trap (or on a control that just
      // became disabled/hidden), pull it back in rather than letting Tab
      // escape the dialog.
      if (!dialog.contains(active) || !focusable.includes(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus?.();
    };
  }, [isOpen, onClose]);

  return { dialogRef, titleId, descriptionId };
}
