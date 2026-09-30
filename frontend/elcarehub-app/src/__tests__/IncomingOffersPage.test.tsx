/**
 * Page-level tests for app/offers/incoming/page.tsx — Incoming Offer Inbox.
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockAccept = jest.fn();
const mockReject = jest.fn();
const mockRefresh = jest.fn();

jest.mock('@/context/WalletContext', () => ({
  useWalletContext: () => ({
    publicKey: 'GOWNER',
    isConnected: true,
    isWrongNetwork: false,
    status: 'connected',
    connect: jest.fn(),
    disconnect: jest.fn(),
    refresh: jest.fn(),
    isInstalled: true,
    isConnecting: false,
    error: null,
    networkPassphrase: null,
  }),
}));

jest.mock('@/components/WalletGuard', () => ({
  WalletGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('@/components/ConnectWalletModal', () => ({
  ConnectWalletModal: () => null,
}));

const mockUseIncomingOffers = jest.fn();
const mockUseAcceptOffer = jest.fn();
const mockUseRejectOffer = jest.fn();

jest.mock('@/hooks/useOffers', () => ({
  useIncomingOffers: (...args: unknown[]) => mockUseIncomingOffers(...args),
  useAcceptOffer: (...args: unknown[]) => mockUseAcceptOffer(...args),
  useRejectOffer: (...args: unknown[]) => mockUseRejectOffer(...args),
}));

jest.mock('@/lib/contract', () => ({
  stroopsToXlm: (s: bigint) => String(Number(s) / 10_000_000),
}));

jest.mock('@/config/tokens', () => ({
  SUPPORTED_TOKENS: [
    { symbol: 'XLM', name: 'Stellar Lumens', address: 'CTOKEN_XLM', decimals: 7 },
  ],
}));

jest.mock('clsx', () => ({
  clsx: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

jest.mock('lucide-react', () => {
  const icon = (name: string) =>
    function MockIcon(props: Record<string, unknown>) {
      return <span data-testid={`icon-${name}`} />;
    };
  return {
    Inbox: icon('Inbox'),
    Clock: icon('Clock'),
    CheckCircle: icon('CheckCircle'),
    XCircle: icon('XCircle'),
    MoreVertical: icon('MoreVertical'),
    ArrowUpRight: icon('ArrowUpRight'),
    History: icon('History'),
    Activity: icon('Activity'),
    TrendingUp: icon('TrendingUp'),
    Loader2: icon('Loader2'),
    User: icon('User'),
    Tag: icon('Tag'),
    CalendarClock: icon('CalendarClock'),
  };
});

import IncomingOffersPage from '@/app/offers/incoming/page';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeListing(id: number, overrides: Record<string, unknown> = {}) {
  return {
    listing_id: id,
    artist: 'GARTIST',
    status: 'Active',
    price: 10_000_000n,
    metadata_cid: 'Qm',
    ...overrides,
  };
}

function makeOffer(id: number, overrides: Record<string, unknown> = {}) {
  return {
    offer_id: id,
    listing_id: 1,
    offerer: 'GOFFERER1234567890',
    amount: 5_000_000n,
    token: 'CTOKEN_XLM',
    status: 'Pending',
    created_at: 1700000000,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('IncomingOffersPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAcceptOffer.mockReturnValue({
      accept: mockAccept,
      isAccepting: false,
      error: null,
    });
    mockUseRejectOffer.mockReturnValue({
      reject: mockReject,
      isRejecting: false,
      error: null,
    });
  });

  it('renders loading skeletons when isLoading is true', () => {
    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [],
      isLoading: true,
      error: null,
      refresh: mockRefresh,
    });

    render(<IncomingOffersPage />);
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThanOrEqual(1);
  });

  it('renders empty state when no incoming offers', () => {
    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [],
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    render(<IncomingOffersPage />);
    expect(screen.getByText('No incoming offers yet.')).toBeInTheDocument();
  });

  it('renders grouped offers by listing', () => {
    const listing1 = makeListing(1);
    const listing2 = makeListing(2);

    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [
        { listing: listing1, offers: [makeOffer(10), makeOffer(11)] },
        { listing: listing2, offers: [makeOffer(12)] },
      ],
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    render(<IncomingOffersPage />);

    // Listing headers
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();

    // Offer cards
    expect(screen.getByTestId('offer-card-10')).toBeInTheDocument();
    expect(screen.getByTestId('offer-card-11')).toBeInTheDocument();
    expect(screen.getByTestId('offer-card-12')).toBeInTheDocument();
  });

  it('accept button calls accept and triggers refresh', async () => {
    mockAccept.mockResolvedValueOnce(true);

    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [
        { listing: makeListing(1), offers: [makeOffer(20, { status: 'Pending' })] },
      ],
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    const user = userEvent.setup();
    render(<IncomingOffersPage />);

    const btn = screen.getByTestId('accept-btn-20');
    await user.click(btn);

    await waitFor(() => expect(mockAccept).toHaveBeenCalledWith(20));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('reject button calls reject and triggers refresh', async () => {
    mockReject.mockResolvedValueOnce(true);

    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [
        { listing: makeListing(1), offers: [makeOffer(25, { status: 'Pending' })] },
      ],
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    const user = userEvent.setup();
    render(<IncomingOffersPage />);

    const btn = screen.getByTestId('reject-btn-25');
    await user.click(btn);

    await waitFor(() => expect(mockReject).toHaveBeenCalledWith(25));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('does not show accept/reject buttons for non-Pending offers', () => {
    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [
        { listing: makeListing(1), offers: [makeOffer(30, { status: 'Accepted' })] },
      ],
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    render(<IncomingOffersPage />);
    expect(screen.queryByTestId('accept-btn-30')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reject-btn-30')).not.toBeInTheDocument();
  });

  it('displays correct stats counters', () => {
    const offers = [
      makeOffer(40, { status: 'Pending' }),
      makeOffer(41, { status: 'Pending' }),
      makeOffer(42, { status: 'Accepted' }),
    ];

    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [{ listing: makeListing(1), offers }],
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    render(<IncomingOffersPage />);
    const stats = screen.getByTestId('stats-grid');
    // Total Received: 3, Needs Review: 2, Total Accepted: 1
    expect(within(stats).getByText('3')).toBeInTheDocument();
    expect(within(stats).getByText('2')).toBeInTheDocument();
    expect(within(stats).getByText('1')).toBeInTheDocument();
  });

  it('renders cross-navigation link to outgoing offers', () => {
    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [],
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    render(<IncomingOffersPage />);
    const navLink = screen.getByTestId('nav-outgoing');
    expect(navLink).toBeInTheDocument();
    expect(navLink).toHaveAttribute('href', '/offers');
  });

  it('displays listing expiry in group header when present', () => {
    const futureTs = Math.floor(Date.now() / 1000) + 86400;
    const listing = makeListing(5, { expires_at: futureTs });

    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [
        { listing, offers: [makeOffer(50)] },
      ],
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    render(<IncomingOffersPage />);
    const expiryEl = screen.getByTestId('listing-expiry-5');
    expect(expiryEl).toBeInTheDocument();
  });

  it('does not show listing expiry when not present', () => {
    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [
        { listing: makeListing(6), offers: [makeOffer(60)] },
      ],
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    render(<IncomingOffersPage />);
    expect(screen.queryByTestId('listing-expiry-6')).not.toBeInTheDocument();
  });

  it('renders error banner when there is an error', () => {
    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [],
      isLoading: false,
      error: 'Failed to load incoming offers',
      refresh: mockRefresh,
    });

    render(<IncomingOffersPage />);
    expect(screen.getByText('Failed to load incoming offers')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Additional tests — expired offers, escrow/refund visibility, disabled actions
// ─────────────────────────────────────────────────────────────────────────────

// Re-mock lucide-react to include new icons
jest.mock('lucide-react', () => {
  const icon = (name: string) =>
    function MockIcon(props: Record<string, unknown>) {
      return <span data-testid={`icon-${name}`} />;
    };
  return {
    Inbox: icon('Inbox'),
    Clock: icon('Clock'),
    CheckCircle: icon('CheckCircle'),
    XCircle: icon('XCircle'),
    MoreVertical: icon('MoreVertical'),
    ArrowUpRight: icon('ArrowUpRight'),
    History: icon('History'),
    Activity: icon('Activity'),
    TrendingUp: icon('TrendingUp'),
    Loader2: icon('Loader2'),
    User: icon('User'),
    Tag: icon('Tag'),
    CalendarClock: icon('CalendarClock'),
    ExternalLink: icon('ExternalLink'),
    AlertOctagon: icon('AlertOctagon'),
  };
});

// Override contract mock to include deriveOfferUIStatus
jest.mock('@/lib/contract', () => ({
  stroopsToXlm: (s: bigint) => String(Number(s) / 10_000_000),
  deriveOfferUIStatus: jest.fn((offer: any) => {
    if (offer.__testUIStatus) return offer.__testUIStatus;
    return offer.status;
  }),
  isOfferActionable: (s: string) => s === 'Pending' || s === 'Stale',
}));

describe('IncomingOffersPage — extended offer state tests', () => {
  const { deriveOfferUIStatus } = require('@/lib/contract');

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAcceptOffer.mockReturnValue({ accept: mockAccept, isAccepting: false, error: null });
    mockUseRejectOffer.mockReturnValue({ reject: mockReject, isRejecting: false, error: null });
    (deriveOfferUIStatus as jest.Mock).mockImplementation((offer: any) => {
      if (offer.__testUIStatus) return offer.__testUIStatus;
      return offer.status;
    });
  });

  it('shows "Expired" badge for an expired offer', () => {
    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [
        { listing: makeListing(1), offers: [makeOffer(200, { status: 'Pending', expires_at: 1, __testUIStatus: 'Expired' })] },
      ],
      isLoading: false, error: null, refresh: mockRefresh,
    });

    render(<IncomingOffersPage />);
    const badge = screen.getByTestId('offer-status-badge-200');
    expect(badge.textContent).toBe('Expired');
  });

  it('hides accept/reject buttons for an expired offer', () => {
    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [
        { listing: makeListing(1), offers: [makeOffer(201, { status: 'Pending', expires_at: 1, __testUIStatus: 'Expired' })] },
      ],
      isLoading: false, error: null, refresh: mockRefresh,
    });

    render(<IncomingOffersPage />);
    expect(screen.queryByTestId('accept-btn-201')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reject-btn-201')).not.toBeInTheDocument();
  });

  it('shows expired notice banner for an expired offer', () => {
    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [
        { listing: makeListing(1), offers: [makeOffer(202, { status: 'Pending', expires_at: 1, __testUIStatus: 'Expired' })] },
      ],
      isLoading: false, error: null, refresh: mockRefresh,
    });

    render(<IncomingOffersPage />);
    expect(screen.getByTestId('offer-expired-notice-202')).toBeInTheDocument();
  });

  it('shows accept/reject buttons for a Stale (still actionable) offer', () => {
    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [
        { listing: makeListing(1), offers: [makeOffer(203, { status: 'Pending', __testUIStatus: 'Stale' })] },
      ],
      isLoading: false, error: null, refresh: mockRefresh,
    });

    render(<IncomingOffersPage />);
    expect(screen.getByTestId('accept-btn-203')).toBeInTheDocument();
    expect(screen.getByTestId('reject-btn-203')).toBeInTheDocument();
  });

  it('hides accept/reject buttons for an Accepted offer', () => {
    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [
        { listing: makeListing(1), offers: [makeOffer(204, { status: 'Accepted', __testUIStatus: 'Accepted' })] },
      ],
      isLoading: false, error: null, refresh: mockRefresh,
    });

    render(<IncomingOffersPage />);
    expect(screen.queryByTestId('accept-btn-204')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reject-btn-204')).not.toBeInTheDocument();
  });

  it('hides accept/reject buttons for a Rejected offer', () => {
    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [
        { listing: makeListing(1), offers: [makeOffer(205, { status: 'Rejected', __testUIStatus: 'Rejected' })] },
      ],
      isLoading: false, error: null, refresh: mockRefresh,
    });

    render(<IncomingOffersPage />);
    expect(screen.queryByTestId('accept-btn-205')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reject-btn-205')).not.toBeInTheDocument();
  });

  it('hides accept/reject buttons for a Withdrawn offer', () => {
    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [
        { listing: makeListing(1), offers: [makeOffer(206, { status: 'Withdrawn', __testUIStatus: 'Withdrawn' })] },
      ],
      isLoading: false, error: null, refresh: mockRefresh,
    });

    render(<IncomingOffersPage />);
    expect(screen.queryByTestId('accept-btn-206')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reject-btn-206')).not.toBeInTheDocument();
  });

  it('shows escrow tx link when escrow_tx_hash is present', () => {
    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [
        { listing: makeListing(1), offers: [makeOffer(210, { escrow_tx_hash: 'ESCROWHASH12345' })] },
      ],
      isLoading: false, error: null, refresh: mockRefresh,
    });

    render(<IncomingOffersPage />);
    expect(screen.getByTestId('escrow-tx-210')).toBeInTheDocument();
  });

  it('shows refund tx link when refund_tx_hash is present on Rejected offer', () => {
    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [
        { listing: makeListing(1), offers: [makeOffer(211, { status: 'Rejected', __testUIStatus: 'Rejected', refund_tx_hash: 'REFUNDHASH67890' })] },
      ],
      isLoading: false, error: null, refresh: mockRefresh,
    });

    render(<IncomingOffersPage />);
    expect(screen.getByTestId('refund-tx-211')).toBeInTheDocument();
  });

  it('shows "Payment:" label for Accepted offer with refund_tx_hash', () => {
    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [
        { listing: makeListing(1), offers: [makeOffer(212, { status: 'Accepted', __testUIStatus: 'Accepted', refund_tx_hash: 'PAYMENTHASH' })] },
      ],
      isLoading: false, error: null, refresh: mockRefresh,
    });

    render(<IncomingOffersPage />);
    const refundEl = screen.getByTestId('refund-tx-212');
    expect(refundEl.textContent).toContain('Payment:');
  });

  it('does not show escrow/refund elements when hashes are absent', () => {
    mockUseIncomingOffers.mockReturnValue({
      offersByListing: [
        { listing: makeListing(1), offers: [makeOffer(213)] },
      ],
      isLoading: false, error: null, refresh: mockRefresh,
    });

    render(<IncomingOffersPage />);
    expect(screen.queryByTestId('escrow-tx-213')).not.toBeInTheDocument();
    expect(screen.queryByTestId('refund-tx-213')).not.toBeInTheDocument();
  });
});
