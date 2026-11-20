/**
 * Skeletons.test.tsx — Issue 1033
 *
 * Verifies that listing-card and auction-card skeletons:
 *   - preserve grid geometry (correct Tailwind classes) so the page does
 *     not reflow when real data arrives
 *   - expose a single accessible role="status" / aria-live announcement
 *     per grid rather than N announcements per card
 *   - hide individual cells from screen readers via aria-hidden
 *   - clean up (unmount) without leaving stale elements in the DOM
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import {
  ListingCardSkeleton,
  AuctionCardSkeleton,
  FeaturedListingSkeleton,
  ListingCardGridSkeleton,
  AuctionCardGridSkeleton,
} from "@/components/Skeletons";

// ── ListingCardSkeleton ───────────────────────────────────────

describe("ListingCardSkeleton", () => {
  it("renders an animate-pulse container", () => {
    const { container } = render(<ListingCardSkeleton />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain("animate-pulse");
  });

  it("is hidden from screen readers with aria-hidden", () => {
    const { container } = render(<ListingCardSkeleton />);
    const root = container.firstChild as HTMLElement;
    expect(root).toHaveAttribute("aria-hidden", "true");
  });

  it("contains an aspect-square image placeholder", () => {
    const { container } = render(<ListingCardSkeleton />);
    const imagePlaceholder = container.querySelector(".aspect-square");
    expect(imagePlaceholder).toBeInTheDocument();
  });

  it("renders the same number of info placeholder rows as the real card", () => {
    const { container } = render(<ListingCardSkeleton />);
    // 3 h-4/h-3 bars + 1 mt-4 price/button row = at least 4 gray placeholders
    const bars = container.querySelectorAll(".bg-gray-100");
    expect(bars.length).toBeGreaterThanOrEqual(4);
  });
});

// ── AuctionCardSkeleton ───────────────────────────────────────

describe("AuctionCardSkeleton", () => {
  it("renders an animate-pulse container", () => {
    const { container } = render(<AuctionCardSkeleton />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain("animate-pulse");
  });

  it("is hidden from screen readers with aria-hidden", () => {
    const { container } = render(<AuctionCardSkeleton />);
    const root = container.firstChild as HTMLElement;
    expect(root).toHaveAttribute("aria-hidden", "true");
  });

  it("contains an aspect-square image placeholder", () => {
    const { container } = render(<AuctionCardSkeleton />);
    expect(container.querySelector(".aspect-square")).toBeInTheDocument();
  });
});

// ── FeaturedListingSkeleton ───────────────────────────────────

describe("FeaturedListingSkeleton", () => {
  it("renders with animate-pulse and correct aspect ratio", () => {
    const { container } = render(<FeaturedListingSkeleton />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain("animate-pulse");
    expect(root.className).toMatch(/aspect-\[4\/5\]/);
  });

  it("is hidden from screen readers", () => {
    const { container } = render(<FeaturedListingSkeleton />);
    expect((container.firstChild as HTMLElement)).toHaveAttribute("aria-hidden", "true");
  });
});

// ── ListingCardGridSkeleton ───────────────────────────────────

describe("ListingCardGridSkeleton", () => {
  it("renders the default count of 12 cards", () => {
    const { container } = render(<ListingCardGridSkeleton />);
    // Each skeleton has an aspect-square div; count them as a proxy for card count
    const cards = container.querySelectorAll(".aspect-square");
    expect(cards.length).toBe(12);
  });

  it("renders the requested count of cards", () => {
    const { container } = render(<ListingCardGridSkeleton count={6} />);
    const cards = container.querySelectorAll(".aspect-square");
    expect(cards.length).toBe(6);
  });

  it("exposes a single role=status element (not one per card)", () => {
    render(<ListingCardGridSkeleton count={12} />);
    const statusEls = screen.getAllByRole("status");
    expect(statusEls).toHaveLength(1);
  });

  it("announces with aria-live=polite", () => {
    render(<ListingCardGridSkeleton />);
    const wrapper = screen.getByRole("status");
    expect(wrapper).toHaveAttribute("aria-live", "polite");
  });

  it("renders the default sr-only label for screen readers", () => {
    render(<ListingCardGridSkeleton />);
    expect(screen.getByText("Loading artworks…")).toBeInTheDocument();
  });

  it("renders a custom label when provided", () => {
    render(<ListingCardGridSkeleton label="Loading collection…" />);
    expect(screen.getByText("Loading collection…")).toBeInTheDocument();
  });

  it("applies grid classes that match the explore page grid", () => {
    const { container } = render(<ListingCardGridSkeleton />);
    const wrapper = container.firstChild as HTMLElement;
    // Must use the same breakpoint classes as the real grid
    expect(wrapper.className).toContain("sm:grid-cols-2");
    expect(wrapper.className).toContain("lg:grid-cols-3");
  });

  it("applies additional className when provided", () => {
    const { container } = render(<ListingCardGridSkeleton className="mt-8" />);
    expect((container.firstChild as HTMLElement).className).toContain("mt-8");
  });

  it("unmounts cleanly without leaving stale DOM elements", () => {
    const { unmount, container } = render(<ListingCardGridSkeleton count={4} />);
    expect(container.querySelectorAll(".aspect-square").length).toBe(4);
    unmount();
    expect(container.querySelectorAll(".aspect-square").length).toBe(0);
  });
});

// ── AuctionCardGridSkeleton ───────────────────────────────────

describe("AuctionCardGridSkeleton", () => {
  it("renders the default count of 8 cards", () => {
    const { container } = render(<AuctionCardGridSkeleton />);
    const cards = container.querySelectorAll(".aspect-square");
    expect(cards.length).toBe(8);
  });

  it("renders the requested count of cards", () => {
    const { container } = render(<AuctionCardGridSkeleton count={4} />);
    expect(container.querySelectorAll(".aspect-square").length).toBe(4);
  });

  it("exposes a single role=status element", () => {
    render(<AuctionCardGridSkeleton />);
    const statusEls = screen.getAllByRole("status");
    expect(statusEls).toHaveLength(1);
  });

  it("renders the default sr-only label", () => {
    render(<AuctionCardGridSkeleton />);
    expect(screen.getByText("Loading auctions…")).toBeInTheDocument();
  });

  it("applies correct grid breakpoints matching the auctions page grid", () => {
    const { container } = render(<AuctionCardGridSkeleton />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("sm:grid-cols-2");
    expect(wrapper.className).toContain("lg:grid-cols-3");
    expect(wrapper.className).toContain("xl:grid-cols-4");
  });
});
