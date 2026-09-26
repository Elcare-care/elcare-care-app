/**
 * Accessibility test fixtures — WCAG 2.2 Level AA conformance
 * Reference: docs/accessibility/ACCESSIBILITY.md
 */

export const a11yFixtures = {
  /**
   * Keyboard navigation test cases
   */
  keyboard: {
    walletConnect: {
      steps: [
        "Tab to Connect Wallet button",
        "Press Enter to open modal",
        "Tab through wallet options",
        "Press Escape to close modal",
        "Focus returns to button",
      ],
      expectedBehavior: "All steps completable without mouse",
    },
    marketplaceFilters: {
      steps: [
        "Tab to filter section",
        "Arrow keys navigate filter chips",
        "Space/Enter toggles filter",
        "Tab to next filter group",
      ],
      expectedBehavior: "All filters operable via keyboard",
    },
    checkoutFlow: {
      steps: [
        "Tab through form fields",
        "Tab to Confirm button",
        "Enter submits form",
        "Tab to next step or close",
      ],
      expectedBehavior: "Checkout completable without mouse",
    },
  },

  /**
   * Focus management test cases
   */
  focus: {
    modalTrap: {
      description: "Focus trapped in modal until dismissed",
      implementation: "useModalA11y hook",
      verification: "Tab cycles within modal only",
    },
    focusReturn: {
      description: "Focus returns to trigger after modal close",
      implementation: "Modal stores and restores activeElement",
      verification: "Escape key returns focus to button",
    },
    skipLinks: {
      description: "Skip to main content link visible on focus",
      implementation: "Navbar skip link",
      verification: "Tab once shows skip link; Enter jumps to main",
    },
  },

  /**
   * Color contrast test cases (WCAG AA: 4.5:1 normal, 3:1 large)
   */
  contrast: {
    buttonLabels: {
      minRatio: 4.5,
      examples: [
        { text: "Connect Wallet", bg: "#1a1a1a", fg: "#ffffff" },
        { text: "Buy Now", bg: "#0066cc", fg: "#ffffff" },
        { text: "Cancel", bg: "#f5f5f5", fg: "#333333" },
      ],
    },
    errorMessages: {
      minRatio: 4.5,
      examples: [
        { text: "Price too low", bg: "#fff", fg: "#d32f2f" },
        { text: "Insufficient balance", bg: "#fff", fg: "#c62828" },
      ],
    },
    staleBanner: {
      minRatio: 4.5,
      description: "Stale data warning must be readable",
      implementation: "StaleBanner component",
    },
  },

  /**
   * Motion & animation test cases
   */
  motion: {
    reducedMotionCSS: {
      rule: "@media (prefers-reduced-motion: reduce)",
      disabledAnimations: [
        "transition: all 0.3s ease",
        "animation: pulse 2s infinite",
        "transform: translateX(100%)",
      ],
      preservedFeedback: [
        "Focus ring (always visible)",
        "Error state color change",
        "Loading spinner (static or minimal)",
      ],
    },
    auctionCountdown: {
      description: "Countdown readable without animation",
      implementation: "useReducedMotion hook",
      verification: "Static text visible; animation optional",
    },
  },

  /**
   * Screen reader test cases
   */
  screenReader: {
    walletConnect: {
      ariaLabels: [
        "aria-modal=true on modal",
        "aria-label on wallet buttons",
        "aria-describedby for instructions",
      ],
      expectedAnnouncement: "Connect Wallet dialog, wallet options listed",
    },
    listingDetail: {
      ariaLabels: [
        "aria-label on price (includes currency)",
        "aria-live=polite on status updates",
        "aria-label on action buttons",
      ],
      expectedAnnouncement: "Listing title, price in XLM, artist name, status",
    },
    checkoutFlow: {
      ariaLabels: [
        "aria-label on form steps",
        "aria-current=step on active step",
        "aria-live=assertive on errors",
      ],
      expectedAnnouncement: "Step 1 of 3, confirm purchase, error message",
    },
    adminTable: {
      ariaLabels: [
        "role=table on table",
        "role=columnheader on headers",
        "aria-sort on sortable columns",
      ],
      expectedAnnouncement: "Table with N rows, sortable columns",
    },
    sseUpdates: {
      ariaLabels: [
        "aria-live=polite on activity feed",
        "aria-live=assertive on critical reorg",
      ],
      expectedAnnouncement: "New listing created, reorg detected",
    },
  },

  /**
   * Component-level a11y requirements
   */
  components: {
    StatusAnnouncer: {
      purpose: "Announce dynamic updates to screen readers",
      usage: "useStatusAnnouncer hook",
      examples: [
        "Transaction submitted",
        "Reorg detected",
        "Listing created",
      ],
    },
    ConnectWalletModal: {
      requirements: [
        "aria-modal=true",
        "aria-labelledby points to title",
        "Focus trap (useModalA11y)",
        "Escape closes",
      ],
    },
    CheckoutModal: {
      requirements: [
        "Form steps labeled",
        "Error messages in aria-live region",
        "Confirm button accessible",
        "Reduced motion respected",
      ],
    },
    FilterSidebar: {
      requirements: [
        "Filter groups labeled",
        "Keyboard navigation (arrow keys)",
        "Filter state announced",
        "Clear filters button accessible",
      ],
    },
    AdminTable: {
      requirements: [
        "Table headers associated",
        "Row actions keyboard accessible",
        "Sort/filter announced",
        "Pagination controls labeled",
      ],
    },
  },

  /**
   * E2E test scenarios
   */
  e2eScenarios: {
    keyboardOnlyCheckout: {
      description: "Complete purchase using keyboard only",
      steps: [
        "Tab to Connect Wallet",
        "Enter to open modal",
        "Tab to wallet option",
        "Enter to connect",
        "Tab to listing",
        "Enter to view detail",
        "Tab to Buy button",
        "Enter to checkout",
        "Tab through form",
        "Enter to confirm",
      ],
      expectedResult: "Transaction submitted without mouse",
    },
    screenReaderBrowse: {
      description: "Browse marketplace with screen reader",
      steps: [
        "Announce page title",
        "List filter options",
        "Announce each listing (title, price, artist)",
        "Announce action buttons",
      ],
      expectedResult: "All content accessible via screen reader",
    },
    reducedMotionCheckout: {
      description: "Checkout with reduced motion enabled",
      steps: [
        "Enable prefers-reduced-motion in browser",
        "Complete checkout flow",
        "Verify countdown readable",
        "Verify no flashing/animation",
      ],
      expectedResult: "Checkout completable; no motion-dependent info",
    },
  },

  /**
   * Audit checklist
   */
  auditChecklist: {
    automated: [
      "jest-axe on all components",
      "Axe DevTools on critical pages",
      "Color contrast checker",
    ],
    manual: [
      "Keyboard navigation (Tab, Arrow, Escape, Enter)",
      "Screen reader (NVDA + Firefox, VoiceOver + Safari)",
      "Focus indicators visible",
      "Reduced motion respected",
      "Error messages clear",
    ],
    quarterly: [
      "Full WCAG 2.2 AA audit",
      "Wallet extension integration",
      "Mobile/touch accessibility",
    ],
  },
};

/**
 * Helper: Generate contrast ratio test data
 */
export function generateContrastTests(
  colors: Array<{ bg: string; fg: string; label: string }>
) {
  return colors.map((c) => ({
    ...c,
    minRatio: 4.5,
    testCommand: `npx wcag-contrast "${c.bg}" "${c.fg}"`,
  }));
}

/**
 * Helper: Verify reduced motion CSS rule exists
 */
export function verifyReducedMotionRule(css: string): boolean {
  return /prefers-reduced-motion:\s*reduce/.test(css);
}

/**
 * Helper: Check aria-live region for announcements
 */
export function verifyAriaLive(element: HTMLElement): {
  hasLive: boolean;
  level: "polite" | "assertive" | null;
} {
  const live = element.getAttribute("aria-live");
  return {
    hasLive: !!live,
    level: (live as "polite" | "assertive") || null,
  };
}
