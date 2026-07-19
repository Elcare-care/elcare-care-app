/**
 * Tests for the listing detail page.
 *
 * Covers:
 *  1. ProvenanceTimeline rendering — all event types, loading, empty, error
 *  2. OfferPanel state — owner vs buyer view, make-offer modal open/close,
 *     accept / reject buttons
 *  3. PriceHistoryChart — loading, empty, renders svg
 *  4. SocialShare buttons — copy-link, twitter
 */

import React from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── Shared mocks ──────────────────────────────────────────────────────────────

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...props }: any) => (
    <a href={href} {...props}>{children}</a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock("@/lib/config", () => ({
  config: {
    network: "testnet",
    contractId: "CCONTRACT123",
    indexerUrl: "http://localhost:4000",
    baseUrl: "http://localhost:3000",
  },
}));

jest.mock("@/context/WalletContext", () => ({
  useWalletContext: () => ({
    publicKey: "GBUYER123456789",
    isConnected: true,
    isWrongNetwork: false,
    status: "CONNECTED",
    connect: jest.fn(),
    disconnect: jest.fn(),
    refresh: jest.fn(),
    isInstalled: true,
    isConnecting: false,
    error: null,
    networkPassphrase: null,
  }),
}));

jest.mock("@/components/WalletGuard", () => ({
  WalletGuard: ({ children }: any) => <>{children}</>,
  GuardButton: ({ children, onAction, disabled, className, ...rest }: any) => (
    <button onClick={onAction} disabled={disabled} className={className} {...rest}>
      {children}
    </button>
  ),
}));

jest.mock("@/hooks/useModalA11y", () => ({
  useModalA11y: (_isOpen: boolean, _onClose: () => void) => ({
    dialogRef: { current: null },
    titleId: "test-modal-title",
  }),
}));

jest.mock("@/lib/contract", () => ({
  stroopsToXlm: (s: bigint) => String(Number(s) / 10_000_000),
  getListing: jest.fn(),
  getAuction: jest.fn(),
}));

jest.mock("@/lib/ipfs", () => ({
  fetchMetadata: jest.fn().mockResolvedValue(null),
  cidToGatewayUrl: (cid: string) => `https://ipfs.io/ipfs/${cid}`,
}));

jest.mock("@/lib/indexer", () => ({
  getListingHistory: jest.fn().mockResolvedValue({ events: [], total: 0, hasMore: false }),
  getListingActivity: jest.fn().mockResolvedValue([]),
  getListingPriceHistory: jest.fn().mockResolvedValue([]),
}));

jest.mock("@/hooks/useMarketplace", () => ({
  useBuyArtwork: () => ({ buy: jest.fn(), isBuying: false, error: null }),
}));

jest.mock("@/hooks/usePlaceBid", () => ({
  usePlaceBid: () => ({ bid: jest.fn(), isBidding: false, error: null }),
}));

jest.mock("@/config/tokens", () => ({
  SUPPORTED_TOKENS: [
    { symbol: "XLM", name: "Stellar Lumens", address: "CTOKEN_XLM", decimals: 7 },
  ],
}));

// ── Offer hook mocks ─────────────────────────────────────────────────────────

const mockMakeOffer = jest.fn().mockResolvedValue(true);
const mockAcceptOffer = jest.fn().mockResolvedValue(true);
const mockRejectOffer = jest.fn().mockResolvedValue(true);
const mockRefreshOffers = jest.fn();

jest.mock("@/hooks/useOffers", () => ({
  useListingOffers: () => ({
    offers: [],
    isLoading: false,
    error: null,
    refresh: mockRefreshOffers,
  }),
  useMakeOffer: () => ({
    make: mockMakeOffer,
    isOffering: false,
    error: null,
  }),
  useAcceptOffer: () => ({
    accept: mockAcceptOffer,
    isAccepting: false,
    error: null,
  }),
  useRejectOffer: () => ({
    reject: mockRejectOffer,
    isRejecting: false,
    error: null,
  }),
}));

jest.mock("@/hooks/useUserActivity", () => ({
  useListingActivity: () => ({ activities: [], isLoading: false, error: null }),
}));

jest.mock("@/hooks/useListingHistory", () => ({
  useListingHistory: () => ({
    events: [],
    isLoading: false,
    isLoadingMore: false,
    error: null,
    hasMore: false,
    loadMore: jest.fn(),
    refresh: jest.fn(),
  }),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { getListing, getAuction } from "@/lib/contract";
import { getListingPriceHistory } from "@/lib/indexer";
import { ProvenanceTimeline, ProvenanceTimelineProps } from "@/components/ProvenanceTimeline";
import { OfferPanel, OfferPanelProps } from "@/components/OfferPanel";
import { PriceHistoryChart } from "@/components/PriceHistoryChart";
import { SocialShare } from "@/components/SocialShare";
import { ActivityEvent } from "@/lib/indexer";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ADDR_ARTIST = "GARTIST12345678901234567890123456789012345678901234";
const ADDR_BUYER  = "GBUYER123456789012345678901234567890123456789012345";

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: "evt_1",
    type: "LISTED",
    listing_id: 1,
    title: "Test",
    price: "10000000",
    timestamp: 1_700_000_000_000,
    from: ADDR_ARTIST,
    to: ADDR_BUYER,
    tx_hash: "realhash123",
    ...overrides,
  };
}

function makeOffer(id: number, overrides: Record<string, any> = {}) {
  return {
    offer_id: id,
    listing_id: 1,
    offerer: ADDR_BUYER,
    amount: BigInt(5_000_000),
    token: "CTOKEN_XLM",
    status: "Pending",
    created_at: 1_700_000_000,
    ...overrides,
  };
}

const timelineDefaultProps: ProvenanceTimelineProps = {
  events: [],
  isLoading: false,
  isLoadingMore: false,
  error: null,
  hasMore: false,
  onLoadMore: jest.fn(),
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. ProvenanceTimeline — rendering
// ═════════════════════════════════════════════════════════════════════════════

describe("ProvenanceTimeline", () => {
  it("shows loading state", () => {
    render(<ProvenanceTimeline {...timelineDefaultProps} isLoading />);
    expect(screen.getByTestId("timeline-loading")).toBeInTheDocument();
  });

  it("shows error state", () => {
    render(<ProvenanceTimeline {...timelineDefaultProps} error="Oops" />);
    expect(screen.getByTestId("timeline-error")).toBeInTheDocument();
    expect(screen.getByText("Oops")).toBeInTheDocument();
  });

  it("shows empty state when no events", () => {
    render(<ProvenanceTimeline {...timelineDefaultProps} />);
    expect(screen.getByTestId("timeline-empty")).toBeInTheDocument();
  });

  const EVENT_TYPES: Array<[ActivityEvent["type"], string]> = [
    ["LISTED",          "Created listing"],
    ["OFFER_SUBMITTED", "Submitted an offer"],
    ["OFFER_ACCEPTED",  "Accepted an offer"],
    ["PURCHASE",        "Purchased listing"],
    ["SALE",            "Sold listing"],
    ["ROYALTY",         "Royalty distributed"],
    ["CANCELLED",       "Listing cancelled"],
    ["TRANSFER",        "Transferred ownership"],
  ];

  it.each(EVENT_TYPES)("renders %s event with label '%s'", (type, label) => {
    render(
      <ProvenanceTimeline
        {...timelineDefaultProps}
        events={[makeEvent({ type, id: `evt_${type}` })]}
      />
    );
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("renders amount when price > 0", () => {
    render(
      <ProvenanceTimeline
        {...timelineDefaultProps}
        events={[makeEvent({ price: "10000000" })]}
      />
    );
    expect(screen.getByText(/1 XLM/)).toBeInTheDocument();
  });

  it("renders actor address truncated with link", () => {
    render(
      <ProvenanceTimeline
        {...timelineDefaultProps}
        events={[makeEvent({ from: ADDR_ARTIST, to: "—" })]}
      />
    );
    const links = screen.getAllByTestId("actor-link");
    expect(links[0]).toHaveAttribute("href", `/profile/${ADDR_ARTIST}`);
  });

  it("renders explorer tx link for real hashes", () => {
    render(
      <ProvenanceTimeline
        {...timelineDefaultProps}
        events={[makeEvent({ tx_hash: "actualtxhash456" })]}
      />
    );
    const link = screen.getByTestId("tx-link");
    expect(link).toHaveAttribute("href", expect.stringContaining("actualtxhash456"));
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("does not render tx link for ledger_ hashes", () => {
    render(
      <ProvenanceTimeline
        {...timelineDefaultProps}
        events={[makeEvent({ tx_hash: "ledger_99999" })]}
      />
    );
    expect(screen.queryByTestId("tx-link")).not.toBeInTheDocument();
  });

  it("shows Load more button and calls handler", () => {
    const onLoadMore = jest.fn();
    render(
      <ProvenanceTimeline
        {...timelineDefaultProps}
        events={[makeEvent()]}
        hasMore
        onLoadMore={onLoadMore}
      />
    );
    fireEvent.click(screen.getByTestId("load-more-button"));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. OfferPanel — owner vs buyer view, modal, accept/reject
// ═════════════════════════════════════════════════════════════════════════════

const baseOfferPanelProps: OfferPanelProps = {
  listingId: 1,
  listingToken: "CTOKEN_XLM",
  isOwner: false,
  offers: [],
  isLoadingOffers: false,
  onRefreshOffers: jest.fn(),
  onMakeOffer: jest.fn().mockResolvedValue(true),
  isMakingOffer: false,
  makeOfferError: null,
  isActive: true,
  ownerPublicKey: ADDR_ARTIST,
};

describe("OfferPanel — buyer view", () => {
  it("renders the offer panel", () => {
    render(<OfferPanel {...baseOfferPanelProps} />);
    expect(screen.getByTestId("offer-panel")).toBeInTheDocument();
  });

  it("renders Make Offer button when listing is active and viewer is not owner", () => {
    render(<OfferPanel {...baseOfferPanelProps} />);
    expect(screen.getByTestId("make-offer-trigger")).toBeInTheDocument();
  });

  it("does not render Make Offer button when listing is inactive", () => {
    render(<OfferPanel {...baseOfferPanelProps} isActive={false} />);
    expect(screen.queryByTestId("make-offer-trigger")).not.toBeInTheDocument();
  });

  it("opens the modal when Make Offer is clicked", async () => {
    const user = userEvent.setup();
    render(<OfferPanel {...baseOfferPanelProps} />);
    await user.click(screen.getByTestId("make-offer-trigger"));
    expect(screen.getByTestId("make-offer-modal")).toBeInTheDocument();
  });

  it("closes modal when X button is clicked", async () => {
    const user = userEvent.setup();
    render(<OfferPanel {...baseOfferPanelProps} />);
    await user.click(screen.getByTestId("make-offer-trigger"));
    expect(screen.getByTestId("make-offer-modal")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Close offer modal"));
    expect(screen.queryByTestId("make-offer-modal")).not.toBeInTheDocument();
  });

  it("renders pending offers in buyer view", () => {
    render(
      <OfferPanel
        {...baseOfferPanelProps}
        offers={[makeOffer(10), makeOffer(11)]}
      />
    );
    expect(screen.getByTestId("buyer-offer-row-10")).toBeInTheDocument();
    expect(screen.getByTestId("buyer-offer-row-11")).toBeInTheDocument();
  });
});

describe("OfferPanel — owner view", () => {
  const ownerProps: OfferPanelProps = {
    ...baseOfferPanelProps,
    isOwner: true,
    ownerPublicKey: ADDR_ARTIST,
  };

  it("renders owner offer list (empty state)", () => {
    render(<OfferPanel {...ownerProps} />);
    expect(screen.getByTestId("owner-offer-list")).toBeInTheDocument();
    expect(screen.getByTestId("no-offers-owner")).toBeInTheDocument();
  });

  it("does NOT render Make Offer button for the owner", () => {
    render(<OfferPanel {...ownerProps} />);
    expect(screen.queryByTestId("make-offer-trigger")).not.toBeInTheDocument();
  });

  it("renders accept and reject buttons for pending offers", () => {
    render(
      <OfferPanel
        {...ownerProps}
        offers={[makeOffer(20), makeOffer(21)]}
      />
    );
    expect(screen.getByTestId("accept-offer-btn-20")).toBeInTheDocument();
    expect(screen.getByTestId("reject-offer-btn-20")).toBeInTheDocument();
    expect(screen.getByTestId("accept-offer-btn-21")).toBeInTheDocument();
    expect(screen.getByTestId("reject-offer-btn-21")).toBeInTheDocument();
  });

  it("does NOT render accept/reject for non-pending offers", () => {
    render(
      <OfferPanel
        {...ownerProps}
        offers={[makeOffer(30, { status: "Accepted" }), makeOffer(31, { status: "Rejected" })]}
      />
    );
    expect(screen.queryByTestId("accept-offer-btn-30")).not.toBeInTheDocument();
    expect(screen.queryByTestId("reject-offer-btn-30")).not.toBeInTheDocument();
  });

  it("calls accept and refreshes on accept click", async () => {
    const onRefresh = jest.fn();
    const user = userEvent.setup();
    render(
      <OfferPanel
        {...ownerProps}
        offers={[makeOffer(40)]}
        onRefreshOffers={onRefresh}
      />
    );
    await user.click(screen.getByTestId("accept-offer-btn-40"));
    await waitFor(() => expect(mockAcceptOffer).toHaveBeenCalledWith(40));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it("calls reject and refreshes on reject click", async () => {
    const onRefresh = jest.fn();
    const user = userEvent.setup();
    render(
      <OfferPanel
        {...ownerProps}
        offers={[makeOffer(50)]}
        onRefreshOffers={onRefresh}
      />
    );
    await user.click(screen.getByTestId("reject-offer-btn-50"));
    await waitFor(() => expect(mockRejectOffer).toHaveBeenCalledWith(50));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });
});

describe("OfferPanel — Make Offer modal form", () => {
  it("shows validation error if amount is empty", async () => {
    const user = userEvent.setup();
    render(<OfferPanel {...baseOfferPanelProps} />);
    await user.click(screen.getByTestId("make-offer-trigger"));
    await user.click(screen.getByTestId("offer-submit-btn"));
    expect(screen.getByTestId("offer-modal-error")).toBeInTheDocument();
  });

  it("calls onMakeOffer with correct amount and token", async () => {
    const onMakeOffer = jest.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<OfferPanel {...baseOfferPanelProps} onMakeOffer={onMakeOffer} />);
    await user.click(screen.getByTestId("make-offer-trigger"));
    await user.type(screen.getByTestId("offer-amount-input"), "25");
    await user.click(screen.getByTestId("offer-submit-btn"));
    await waitFor(() =>
      expect(onMakeOffer).toHaveBeenCalledWith(25, "CTOKEN_XLM", undefined)
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. PriceHistoryChart
// ═════════════════════════════════════════════════════════════════════════════

describe("PriceHistoryChart", () => {
  it("renders loading state", () => {
    render(<PriceHistoryChart points={[]} isLoading />);
    expect(screen.getByTestId("price-chart-loading")).toBeInTheDocument();
  });

  it("renders error state", () => {
    render(<PriceHistoryChart points={[]} error="Failed to load" />);
    expect(screen.getByTestId("price-chart-error")).toBeInTheDocument();
  });

  it("renders empty state when fewer than 2 points", () => {
    render(<PriceHistoryChart points={[{ timestamp: Date.now(), price: "100" }]} />);
    expect(screen.getByTestId("price-chart-empty")).toBeInTheDocument();
  });

  it("renders sparkline SVG with 2+ points", () => {
    const points = [
      { timestamp: 1_700_000_000_000, price: "100000000" },
      { timestamp: 1_700_086_400_000, price: "120000000" },
      { timestamp: 1_700_172_800_000, price: "115000000" },
    ];
    render(<PriceHistoryChart points={points} />);
    expect(screen.getByTestId("price-sparkline-svg")).toBeInTheDocument();
    expect(screen.getByTestId("sparkline-path")).toBeInTheDocument();
    expect(screen.getByTestId("price-change-badge")).toBeInTheDocument();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. SocialShare
// ═════════════════════════════════════════════════════════════════════════════

describe("SocialShare", () => {
  const originalClipboard = navigator.clipboard;

  beforeAll(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterAll(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      configurable: true,
    });
  });

  it("renders twitter and copy-link buttons", () => {
    render(
      <SocialShare title="My Art" price="10 XLM" url="https://elcarehub.art/listings/1" />
    );
    expect(screen.getByTestId("social-share")).toBeInTheDocument();
    expect(screen.getByTestId("share-twitter-btn")).toBeInTheDocument();
    expect(screen.getByTestId("share-copy-btn")).toBeInTheDocument();
  });

  it("copy button writes to clipboard and shows 'Copied!' feedback", async () => {
    const user = userEvent.setup();
    render(
      <SocialShare title="My Art" price="10 XLM" url="https://elcarehub.art/listings/1" />
    );
    await user.click(screen.getByTestId("share-copy-btn"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "https://elcarehub.art/listings/1"
    );
    expect(await screen.findByText("Copied!")).toBeInTheDocument();
  });

  it("twitter button has aria-label mentioning the title", () => {
    render(<SocialShare title="Sunset over Sahara" url="https://elcarehub.art/listings/2" />);
    const btn = screen.getByTestId("share-twitter-btn");
    expect(btn).toHaveAttribute("aria-label", expect.stringContaining("Sunset over Sahara"));
  });
});
