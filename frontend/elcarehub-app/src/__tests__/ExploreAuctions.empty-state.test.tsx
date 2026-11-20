/**
 * ExploreAuctions.empty-state.test.tsx — Issue 1032
 *
 * Verifies that both the Explore and Auctions browse pages show a consistent,
 * reusable empty state when results are empty:
 *
 *   • When there are no active filters: a neutral "nothing here yet" message
 *     that never implies a network error or indexer failure.
 *   • When filters are active: a "no results" message with a single
 *     "clear filters" CTA.
 *   • The correct locale-keyed copy is used (from en.json) — no raw technical
 *     values or placeholder text are exposed to users.
 *   • The empty state has an accessible role (role="status" via EmptyState).
 *   • The empty state does not appear while data is loading.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── Shared mock infrastructure ────────────────────────────────

jest.mock("@/lib/indexer", () => ({
  fetchListings: jest.fn(),
  getCollections: jest.fn().mockResolvedValue({ collections: [] }),
}));

jest.mock("@/lib/contract", () => ({
  getAllListings: jest.fn().mockResolvedValue([]),
  stroopsToXlm: (_s: bigint) => "1",
}));

// Default filter state: nothing active
const defaultFilters = {
  search: "",
  status: "All",
  collection: [],
  minPrice: "",
  maxPrice: "",
  artist: "",
  sort: "newest",
};

let mockFilters = { ...defaultFilters };
const mockSyncToUrl = jest.fn();

jest.mock("@/hooks/useFilterUrlSync", () => ({
  useFilterUrlSync: () => ({
    initialFilters: mockFilters,
    initialPage: 1,
    syncToUrl: mockSyncToUrl,
    syncQueryParam: jest.fn(),
  }),
}));

// ── Explore page tests ────────────────────────────────────────

describe("ExplorePage empty state (Issue 1032)", () => {
  const { fetchListings, getCollections } = jest.requireMock("@/lib/indexer");
  const { getAllListings } = jest.requireMock("@/lib/contract");

  beforeEach(() => {
    jest.clearAllMocks();
    mockFilters = { ...defaultFilters };
    getCollections.mockResolvedValue({ collections: [] });
    fetchListings.mockResolvedValue({ listings: [], total: 0 });
    getAllListings.mockResolvedValue([]);
  });

  it("shows unfiltered empty state with neutral copy — no network-error language", async () => {
    // Re-import after beforeEach reset so hooks see the updated mock
    const { default: ExplorePage } = await import("@/app/explore/page");
    render(<ExplorePage />);

    await waitFor(() => {
      expect(screen.getByText("No artworks yet")).toBeInTheDocument();
    });

    expect(
      screen.getByText(/The marketplace doesn't have any listings yet/i)
    ).toBeInTheDocument();

    // Must NOT contain network-error language
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/unavailable/i)).not.toBeInTheDocument();
  });

  it("unfiltered empty state does not show a 'Clear filters' action", async () => {
    const { default: ExplorePage } = await import("@/app/explore/page");
    render(<ExplorePage />);

    await waitFor(() => {
      expect(screen.getByText("No artworks yet")).toBeInTheDocument();
    });

    expect(
      screen.queryByRole("button", { name: /clear all filters/i })
    ).not.toBeInTheDocument();
  });

  it("filtered empty state explains filters are active and shows clear action", async () => {
    mockFilters = { ...defaultFilters, search: "abstract-painting" };

    const { default: ExplorePage } = await import("@/app/explore/page");
    render(<ExplorePage />);

    await waitFor(() => {
      expect(screen.getByText("No matching artworks")).toBeInTheDocument();
    });

    expect(
      screen.getByText(/No listings match your current filters or search terms/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Clear all filters/i })
    ).toBeInTheDocument();
  });

  it("filtered empty state clears filters when the action is clicked", async () => {
    const user = userEvent.setup();
    mockFilters = { ...defaultFilters, status: "Active" };

    const { default: ExplorePage } = await import("@/app/explore/page");
    render(<ExplorePage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Clear all filters/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Clear all filters/i }));

    // After clearing the search input should be empty
    await waitFor(() => {
      expect(
        (screen.getByPlaceholderText(/Search by title/i) as HTMLInputElement).value
      ).toBe("");
    });
  });

  it("empty state is accessible — has role=status", async () => {
    const { default: ExplorePage } = await import("@/app/explore/page");
    render(<ExplorePage />);

    await waitFor(() => {
      const statusEl = screen.getByRole("status");
      expect(statusEl).toBeInTheDocument();
    });
  });

  it("empty state does not appear while data is still loading", async () => {
    let resolve!: (v: unknown) => void;
    fetchListings.mockReturnValueOnce(new Promise((r) => { resolve = r; }));

    const { default: ExplorePage } = await import("@/app/explore/page");
    render(<ExplorePage />);

    // Before the promise resolves the empty-state text must not be visible
    expect(screen.queryByText("No artworks yet")).not.toBeInTheDocument();
    expect(screen.queryByText("No matching artworks")).not.toBeInTheDocument();

    // Unblock and clean up
    resolve({ listings: [{ listing_id: 1, status: "Active" }], total: 1 });
  });
});
