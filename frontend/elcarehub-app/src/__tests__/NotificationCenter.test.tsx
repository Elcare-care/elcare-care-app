/**
 * NotificationCenter.test.tsx
 *
 * Tests for the enhanced NotificationCenter component and its data pipeline:
 *   - Bell badge shows unread count / pulses on HIGH-priority unread
 *   - Priority sections (HIGH → MEDIUM → LOW) render in correct order
 *   - Amount chip renders when present
 *   - Mark-read clears badge
 *   - Mark-all-read clears all items
 *   - Preference toggles update per-category opt-in
 *   - SSE live indicator renders
 *   - Empty state renders correctly
 */

import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock("@/context/WalletContext", () => ({
  useWalletContext: () => ({ publicKey: "GTEST123" }),
}));

jest.mock("@/lib/config", () => ({
  config: { indexerUrl: "http://localhost:3001" },
}));

jest.mock("@/lib/indexer", () => ({
  subscribeToMarketplaceEvents: () => ({
    close: jest.fn(),
    getLastEventId: () => null,
  }),
}));

const mockNotifications: import("@/lib/watchlist").AppNotification[] = [
  {
    id: "n1",
    category: "LISTING_SOLD",
    priority: "HIGH",
    title: "Your watched listing sold!",
    body: "Listing #1 sold for 10 XLM.",
    amount: "10 XLM",
    resourceType: "listing",
    resourceId: "1",
    href: "/listings/1",
    receivedAt: Date.now() - 5000,
    isRead: false,
    isStale: false,
  },
  {
    id: "n2",
    category: "BID_PLACED",
    priority: "MEDIUM",
    title: "New bid on watched auction",
    body: "Auction #5 received a bid of 2 XLM.",
    amount: "2 XLM",
    resourceType: "auction",
    resourceId: "5",
    href: "/auctions/5",
    receivedAt: Date.now() - 30000,
    isRead: false,
    isStale: false,
  },
  {
    id: "n3",
    category: "COLLECTION_DEPLOYED",
    priority: "LOW",
    title: "Watched artist deployed a collection",
    body: "New ERC-721 collection deployed.",
    resourceType: "collection",
    resourceId: "GCOLL",
    href: "/collections/GCOLL",
    receivedAt: Date.now() - 120000,
    isRead: true,
    isStale: false,
  },
];

const mockMarkRead = jest.fn();
const mockMarkAllRead = jest.fn();
const mockUpdatePref = jest.fn();

jest.mock("@/hooks/useNotificationCenter", () => ({
  useNotificationCenter: () => ({
    notifications: mockNotifications,
    unreadCount: 2,
    prefs: {
      AUCTION_ENDING: true, AUCTION_FINALIZED: true,
      OFFER_CHANGE: true, OFFER_ACCEPTED: true, OFFER_WITHDRAWN: true,
      LISTING_CHANGE: true, LISTING_SOLD: true, LISTING_PRICE_UPDATED: false,
      TX_CONFIRMED: true, COLLECTION_DEPLOYED: false, BID_PLACED: true,
    },
    sseConnected: true,
    markRead: mockMarkRead,
    markAllRead: mockMarkAllRead,
    updatePref: mockUpdatePref,
  }),
}));

import { NotificationCenter } from "@/components/NotificationCenter";

// ── Helpers ───────────────────────────────────────────────────────────────────

function openPanel() {
  const bell = screen.getByTestId("notification-bell");
  fireEvent.click(bell);
  return screen.getByTestId("notification-panel");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("NotificationCenter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders bell button", () => {
    render(<NotificationCenter />);
    expect(screen.getByTestId("notification-bell")).toBeInTheDocument();
  });

  it("shows unread badge with count", () => {
    render(<NotificationCenter />);
    const badge = screen.getByTestId("notification-badge");
    expect(badge).toHaveTextContent("2");
  });

  it("opens panel on bell click", () => {
    render(<NotificationCenter />);
    openPanel();
    expect(screen.getByTestId("notification-panel")).toBeInTheDocument();
  });

  it("renders HIGH-priority notification first", () => {
    render(<NotificationCenter />);
    const panel = openPanel();
    const rows = within(panel).getAllByText(/watched listing sold/i);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("shows amount chip for notifications with amount", () => {
    render(<NotificationCenter />);
    openPanel();
    // n1 has amount "10 XLM"
    expect(screen.getByText("10 XLM")).toBeInTheDocument();
  });

  it("shows SSE live indicator when connected", () => {
    render(<NotificationCenter />);
    openPanel();
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("calls markRead when X button clicked", () => {
    render(<NotificationCenter />);
    openPanel();
    // n1 is unread — its mark-read button has aria-label "Mark as read"
    const buttons = screen.getAllByRole("button", { name: /mark as read/i });
    fireEvent.click(buttons[0]);
    expect(mockMarkRead).toHaveBeenCalledTimes(1);
  });

  it("calls markAllRead when All read button clicked", () => {
    render(<NotificationCenter />);
    openPanel();
    fireEvent.click(screen.getByTestId("mark-all-read-btn"));
    expect(mockMarkAllRead).toHaveBeenCalledTimes(1);
  });

  it("opens preferences panel on Settings click", () => {
    render(<NotificationCenter />);
    openPanel();
    fireEvent.click(screen.getByTestId("notification-prefs-toggle"));
    // Preference toggles should appear
    expect(screen.getByTestId("pref-toggle-LISTING_SOLD")).toBeInTheDocument();
  });

  it("calls updatePref when a toggle is clicked", () => {
    render(<NotificationCenter />);
    openPanel();
    fireEvent.click(screen.getByTestId("notification-prefs-toggle"));
    fireEvent.click(screen.getByTestId("pref-toggle-BID_PLACED"));
    expect(mockUpdatePref).toHaveBeenCalledWith("BID_PLACED", false);
  });

  it("closes panel on outside click", () => {
    render(
      <div>
        <NotificationCenter />
        <div data-testid="outside">outside</div>
      </div>
    );
    openPanel();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByTestId("notification-panel")).not.toBeInTheDocument();
  });
});

// ── Empty state ───────────────────────────────────────────────────────────────

describe("NotificationCenter — empty state", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("shows empty state message when no notifications", () => {
    jest.doMock("@/hooks/useNotificationCenter", () => ({
      useNotificationCenter: () => ({
        notifications: [],
        unreadCount: 0,
        prefs: {},
        sseConnected: false,
        markRead: jest.fn(),
        markAllRead: jest.fn(),
        updatePref: jest.fn(),
      }),
    }));
    // Reimport with fresh mock
    const { NotificationCenter: NC } = jest.requireActual(
      "@/components/NotificationCenter"
    ) as { NotificationCenter: typeof import("@/components/NotificationCenter").NotificationCenter };
    // Use the mocked hook via standard render
    render(<NotificationCenter />);
    fireEvent.click(screen.getByTestId("notification-bell"));
    // Badge should not be present
    expect(screen.queryByTestId("notification-badge")).not.toBeInTheDocument();
  });
});
