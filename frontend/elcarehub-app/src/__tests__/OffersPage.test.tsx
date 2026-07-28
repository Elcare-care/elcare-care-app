/**
 * Page-level tests for app/offers/page.tsx — Outgoing Offers Dashboard.
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockWithdraw = jest.fn();
const mockRefresh = jest.fn();

jest.mock('@/context/WalletContext', () => ({
  useWalletContext: () => ({
    publicKey: 'GPUBKEY',
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

jest.mock('@/components/PageStates', () => ({
  ResourceState: ({ isLoading, error, isEmpty, empty, children }: any) => {
    if (isLoading) return <div data-testid="resource-loading">Loading…</div>;
    if (error) return <div data-testid="resource-error">{error.message || error}</div>;
    if (isEmpty && empty) return (
      <div data-testid="resource-empty">
        <span>{empty.title}</span>
        {empty.action && <a href={empty.action.href}>{empty.action.label}</a>}
      </div>
    );
    return <>{children}</>;
  },
}));

jest.mock('@/lib/pageState', () => ({
  categorizePageError: (_err: unknown, opts: any) => ({
    message: typeof _err === 'string' ? _err : String(_err),
    resourceLabel: opts?.resourceLabel,
  }),
}));

// Default: return offers
const mockUseOffererOffers = jest.fn();
const mockUseWithdrawOffer = jest.fn();

jest.mock('@/hooks/useOffers', () => ({
  useOffererOffers: (...args: unknown[]) => mockUseOffererOffers(...args),
  useWithdrawOffer: (...args: unknown[]) => mockUseWithdrawOffer(...args),
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

// Stub lucide-react icons
jest.mock('lucide-react', () => {
  const icon = (name: string) =>
    function MockIcon(props: Record<string, unknown>) {
      return <span data-testid={`icon-${name}`} />;
    };
  return {
    ShoppingBag: icon('ShoppingBag'),
    Clock: icon('Clock'),
    CheckCircle: icon('CheckCircle'),
    XCircle: icon('XCircle'),
    ArrowUpRight: icon('ArrowUpRight'),
    History: icon('History'),
    Activity: icon('Activity'),
    TrendingUp: icon('TrendingUp'),
    Loader2: icon('Loader2'),
    Inbox: icon('Inbox'),
    CalendarClock: icon('CalendarClock'),
    Timer: icon('Timer'),
    Coins: icon('Coins'),
    AlertTriangle: icon('AlertTriangle'),
    X: icon('X'),
    ExternalLink: icon('ExternalLink'),
    AlertOctagon: icon('AlertOctagon'),
    AlertCircle: icon('AlertCircle'),
    RefreshCw: icon('RefreshCw'),
    Package: icon('Package'),
    SearchX: icon('SearchX'),
    ShieldAlert: icon('ShieldAlert'),
    FileQuestion: icon('FileQuestion'),
    ServerCrash: icon('ServerCrash'),
  };
});

import OffersPage from '@/app/offers/page';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOffer(id: number, overrides: Record<string, unknown> = {}) {
  return {
    offer_id: id,
    listing_id: 1,
    offerer: 'GOFFERER',
    amount: 5_000_000n,
    token: 'CTOKEN_XLM',
    status: 'Pending',
    created_at: 1700000000,
    listing: {
      listing_id: 1,
      artist: 'GARTIST',
      status: 'Active',
      price: 10_000_000n,
      metadata_cid: 'Qm',
      expires_at: undefined,
    },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OffersPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseWithdrawOffer.mockReturnValue({
      withdraw: mockWithdraw,
      isWithdrawing: false,
      error: null,
    });
  });

  it('renders loading skeletons when isLoading is true', () => {
    mockUseOffererOffers.mockReturnValue({
      offers: [],
      isLoading: true,
      error: null,
      refresh: mockRefresh,
    });

    render(<OffersPage />);
    // Skeleton placeholders are rendered as pulse divs
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThanOrEqual(1);
  });

  it('renders empty state when no offers', () => {
    mockUseOffererOffers.mockReturnValue({
      offers: [],
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    render(<OffersPage />);
    expect(screen.getByText('No offers yet.')).toBeInTheDocument();
    expect(screen.getByText('Browse listings')).toBeInTheDocument();
  });

  it('renders offer cards with status, amount, token, and listing link', () => {
    const offers = [
      makeOffer(10, { status: 'Pending' }),
      makeOffer(11, { status: 'Accepted' }),
    ];

    mockUseOffererOffers.mockReturnValue({
      offers,
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    render(<OffersPage />);

    // Both cards rendered
    expect(screen.getByTestId('offer-card-10')).toBeInTheDocument();
    expect(screen.getByTestId('offer-card-11')).toBeInTheDocument();

    // Status badges — use getAllByText since tab buttons also have these labels
    expect(screen.getAllByText('Pending').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Accepted').length).toBeGreaterThanOrEqual(1);

    // Amount displayed (stroopsToXlm mock returns "0.5")
    const amounts = screen.getAllByText('0.5');
    expect(amounts.length).toBe(2);

    // Token symbol
    const tokenLabels = screen.getAllByText('XLM');
    expect(tokenLabels.length).toBe(2);

    // Listing links
    const listingLinks = screen.getAllByText('#1');
    expect(listingLinks.length).toBeGreaterThanOrEqual(2);
  });

  it('displays listing expiry when present', () => {
    const futureTs = Math.floor(Date.now() / 1000) + 86400;
    const offers = [
      makeOffer(20, {
        listing: {
          listing_id: 1,
          artist: 'GARTIST',
          status: 'Active',
          price: 10_000_000n,
          metadata_cid: 'Qm',
          expires_at: futureTs,
        },
      }),
    ];

    mockUseOffererOffers.mockReturnValue({
      offers,
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    render(<OffersPage />);
    const expiryEl = screen.getByTestId('offer-expiry-20');
    expect(expiryEl).toBeInTheDocument();
    // Should NOT say "No expiry" since we have an expires_at value
    expect(expiryEl.textContent).not.toContain('No expiry');
  });

  it('displays "No expiry" when listing has no expires_at', () => {
    const offers = [makeOffer(21)];

    mockUseOffererOffers.mockReturnValue({
      offers,
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    render(<OffersPage />);
    const expiryEl = screen.getByTestId('offer-expiry-21');
    expect(expiryEl.textContent).toContain('No expiry');
  });

  it('withdraw button calls withdraw and triggers refresh', async () => {
    mockWithdraw.mockResolvedValueOnce(true);
    const offers = [makeOffer(30, { status: 'Pending' })];

    mockUseOffererOffers.mockReturnValue({
      offers,
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    const user = userEvent.setup();
    render(<OffersPage />);

    const btn = screen.getByTestId('withdraw-btn-30');
    await user.click(btn);

    await waitFor(() => expect(mockWithdraw).toHaveBeenCalledWith(30));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('does not show withdraw button for non-Pending offers', () => {
    const offers = [makeOffer(31, { status: 'Accepted' })];

    mockUseOffererOffers.mockReturnValue({
      offers,
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    render(<OffersPage />);
    expect(screen.queryByTestId('withdraw-btn-31')).not.toBeInTheDocument();
  });

  it('tab filtering shows only matching status', async () => {
    const offers = [
      makeOffer(40, { status: 'Pending' }),
      makeOffer(41, { status: 'Accepted' }),
    ];

    mockUseOffererOffers.mockReturnValue({
      offers,
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    const user = userEvent.setup();
    render(<OffersPage />);

    // All tab — both visible
    expect(screen.getByTestId('offer-card-40')).toBeInTheDocument();
    expect(screen.getByTestId('offer-card-41')).toBeInTheDocument();

    // Click "Accepted" tab
    await user.click(screen.getByRole('button', { name: /^Accepted$/i }));

    // Only accepted card visible
    expect(screen.queryByTestId('offer-card-40')).not.toBeInTheDocument();
    expect(screen.getByTestId('offer-card-41')).toBeInTheDocument();
  });

  it('renders cross-navigation link to offer inbox', () => {
    mockUseOffererOffers.mockReturnValue({
      offers: [],
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    render(<OffersPage />);
    const navLink = screen.getByTestId('nav-incoming');
    expect(navLink).toBeInTheDocument();
    expect(navLink).toHaveAttribute('href', '/offers/incoming');
  });

  it('displays correct stats counters', () => {
    const offers = [
      makeOffer(50, { status: 'Pending' }),
      makeOffer(51, { status: 'Pending' }),
      makeOffer(52, { status: 'Accepted' }),
    ];

    mockUseOffererOffers.mockReturnValue({
      offers,
      isLoading: false,
      error: null,
      refresh: mockRefresh,
    });

    render(<OffersPage />);
    const stats = screen.getByTestId('stats-grid');
    // Total Placed: 3, Pending Response: 2, Successfully Accepted: 1
    expect(within(stats).getByText('3')).toBeInTheDocument();
    expect(within(stats).getByText('2')).toBeInTheDocument();
    expect(within(stats).getByText('1')).toBeInTheDocument();
  });

  it('renders error banner when there is an error', () => {
    mockUseOffererOffers.mockReturnValue({
      offers: [],
      isLoading: false,
      error: 'Something went wrong',
      refresh: mockRefresh,
    });

    render(<OffersPage />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Additional tests — offer status states, escrow/refund visibility,
// disabled actions, Expired tab, and Stale badge.
// ─────────────────────────────────────────────────────────────────────────────

// Re-mock lucide-react to include new icons used after the changes
jest.mock('lucide-react', () => {
  const icon = (name: string) =>
    function MockIcon(props: Record<string, unknown>) {
      return <span data-testid={`icon-${name}`} />;
    };
  return {
    ShoppingBag: icon('ShoppingBag'),
    Clock: icon('Clock'),
    CheckCircle: icon('CheckCircle'),
    XCircle: icon('XCircle'),
    ArrowUpRight: icon('ArrowUpRight'),
    History: icon('History'),
    Activity: icon('Activity'),
    TrendingUp: icon('TrendingUp'),
    Loader2: icon('Loader2'),
    Inbox: icon('Inbox'),
    CalendarClock: icon('CalendarClock'),
    Timer: icon('Timer'),
    Coins: icon('Coins'),
    AlertTriangle: icon('AlertTriangle'),
    X: icon('X'),
    ExternalLink: icon('ExternalLink'),
    AlertOctagon: icon('AlertOctagon'),
    AlertCircle: icon('AlertCircle'),
    RefreshCw: icon('RefreshCw'),
    Package: icon('Package'),
    SearchX: icon('SearchX'),
    ShieldAlert: icon('ShieldAlert'),
    FileQuestion: icon('FileQuestion'),
    ServerCrash: icon('ServerCrash'),
  };
});

// Mock useReclaimOffer which is imported by OffersPage
const mockReclaim = jest.fn();
jest.mock('@/hooks/useOffers', () => ({
  useOffererOffers: (...args: unknown[]) => mockUseOffererOffers(...args),
  useWithdrawOffer: (...args: unknown[]) => mockUseWithdrawOffer(...args),
  useReclaimOffer: () => ({ reclaim: mockReclaim, isReclaiming: false, error: null }),
}));

// Mock deriveOfferUIStatus from contract so we can control it in tests
jest.mock('@/lib/contract', () => ({
  stroopsToXlm: (s: bigint) => String(Number(s) / 10_000_000),
  deriveOfferUIStatus: jest.fn((offer: any, _nowMs: number) => {
    // Default: return the raw status unless overridden per test
    if (offer.__testUIStatus) return offer.__testUIStatus;
    if (offer.status === 'Pending' && offer.expires_at != null) {
      const now = Date.now();
      if (offer.expires_at * 1000 <= now) return 'Expired';
    }
    return offer.status;
  }),
  isOfferActionable: (s: string) => s === 'Pending' || s === 'Stale',
}));

describe('OffersPage — extended offer state tests', () => {
  const { deriveOfferUIStatus } = require('@/lib/contract');

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseWithdrawOffer.mockReturnValue({
      withdraw: mockWithdraw,
      isWithdrawing: false,
      error: null,
    });
    (deriveOfferUIStatus as jest.Mock).mockImplementation((offer: any) => {
      if (offer.__testUIStatus) return offer.__testUIStatus;
      return offer.status;
    });
  });

  it('shows "Expired" badge for an expired offer', () => {
    const pastExpiry = Math.floor(Date.now() / 1000) - 100;
    const offers = [makeOffer(100, { status: 'Pending', expires_at: pastExpiry, __testUIStatus: 'Expired' })];

    mockUseOffererOffers.mockReturnValue({ offers, isLoading: false, error: null, refresh: mockRefresh });

    render(<OffersPage />);
    const badge = screen.getByTestId('offer-status-badge-100');
    expect(badge.textContent).toBe('Expired');
  });

  it('shows reclaim button for expired offers, not withdraw', () => {
    const pastExpiry = Math.floor(Date.now() / 1000) - 100;
    const offers = [makeOffer(101, { status: 'Pending', expires_at: pastExpiry, __testUIStatus: 'Expired' })];

    mockUseOffererOffers.mockReturnValue({ offers, isLoading: false, error: null, refresh: mockRefresh });

    render(<OffersPage />);
    expect(screen.getByTestId('reclaim-btn-101')).toBeInTheDocument();
    expect(screen.queryByTestId('withdraw-btn-101')).not.toBeInTheDocument();
  });

  it('does not show action buttons for Accepted offers', () => {
    const offers = [makeOffer(102, { status: 'Accepted', __testUIStatus: 'Accepted' })];

    mockUseOffererOffers.mockReturnValue({ offers, isLoading: false, error: null, refresh: mockRefresh });

    render(<OffersPage />);
    expect(screen.queryByTestId('withdraw-btn-102')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reclaim-btn-102')).not.toBeInTheDocument();
  });

  it('does not show action buttons for Rejected offers', () => {
    const offers = [makeOffer(103, { status: 'Rejected', __testUIStatus: 'Rejected' })];

    mockUseOffererOffers.mockReturnValue({ offers, isLoading: false, error: null, refresh: mockRefresh });

    render(<OffersPage />);
    expect(screen.queryByTestId('withdraw-btn-103')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reclaim-btn-103')).not.toBeInTheDocument();
  });

  it('does not show action buttons for Withdrawn offers', () => {
    const offers = [makeOffer(104, { status: 'Withdrawn', __testUIStatus: 'Withdrawn' })];

    mockUseOffererOffers.mockReturnValue({ offers, isLoading: false, error: null, refresh: mockRefresh });

    render(<OffersPage />);
    expect(screen.queryByTestId('withdraw-btn-104')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reclaim-btn-104')).not.toBeInTheDocument();
  });

  it('shows "Stale" badge for a stale pending offer', () => {
    const offers = [makeOffer(105, { status: 'Pending', __testUIStatus: 'Stale' })];

    mockUseOffererOffers.mockReturnValue({ offers, isLoading: false, error: null, refresh: mockRefresh });

    render(<OffersPage />);
    const badge = screen.getByTestId('offer-status-badge-105');
    expect(badge.textContent).toBe('Stale');
  });

  it('shows withdraw button for a Stale offer (still actionable)', () => {
    const offers = [makeOffer(106, { status: 'Pending', __testUIStatus: 'Stale' })];

    mockUseOffererOffers.mockReturnValue({ offers, isLoading: false, error: null, refresh: mockRefresh });

    render(<OffersPage />);
    expect(screen.getByTestId('withdraw-btn-106')).toBeInTheDocument();
  });

  it('shows escrow tx link when escrow_tx_hash is present', () => {
    const offers = [makeOffer(110, { escrow_tx_hash: 'ESCROWHASH12345' })];

    mockUseOffererOffers.mockReturnValue({ offers, isLoading: false, error: null, refresh: mockRefresh });

    render(<OffersPage />);
    expect(screen.getByTestId('escrow-tx-110')).toBeInTheDocument();
  });

  it('shows refund tx link when refund_tx_hash is present on Rejected offer', () => {
    const offers = [makeOffer(111, { status: 'Rejected', __testUIStatus: 'Rejected', refund_tx_hash: 'REFUNDHASH67890' })];

    mockUseOffererOffers.mockReturnValue({ offers, isLoading: false, error: null, refresh: mockRefresh });

    render(<OffersPage />);
    expect(screen.getByTestId('refund-tx-111')).toBeInTheDocument();
  });

  it('shows payment tx link (not refund label) when Accepted offer has refund_tx_hash', () => {
    const offers = [makeOffer(112, { status: 'Accepted', __testUIStatus: 'Accepted', refund_tx_hash: 'PAYMENTHASH' })];

    mockUseOffererOffers.mockReturnValue({ offers, isLoading: false, error: null, refresh: mockRefresh });

    render(<OffersPage />);
    const refundEl = screen.getByTestId('refund-tx-112');
    expect(refundEl.textContent).toContain('Payment:');
  });

  it('does not show escrow/refund elements when hashes are absent', () => {
    const offers = [makeOffer(113, { status: 'Pending' })];

    mockUseOffererOffers.mockReturnValue({ offers, isLoading: false, error: null, refresh: mockRefresh });

    render(<OffersPage />);
    expect(screen.queryByTestId('escrow-tx-113')).not.toBeInTheDocument();
    expect(screen.queryByTestId('refund-tx-113')).not.toBeInTheDocument();
  });

  it('Expired tab filters to show only expired offers', async () => {
    const offers = [
      makeOffer(120, { status: 'Pending', __testUIStatus: 'Pending' }),
      makeOffer(121, { status: 'Pending', expires_at: 1, __testUIStatus: 'Expired' }),
    ];

    // deriveOfferUIStatus mock: return __testUIStatus
    mockUseOffererOffers.mockReturnValue({ offers, isLoading: false, error: null, refresh: mockRefresh });

    const user = userEvent.setup();
    render(<OffersPage />);

    // Click the Expired tab
    await user.click(screen.getByRole('button', { name: /^Expired$/i }));

    // Only the expired card should remain
    expect(screen.queryByTestId('offer-card-120')).not.toBeInTheDocument();
    expect(screen.getByTestId('offer-card-121')).toBeInTheDocument();
  });

  it('countdown is shown for pending offers with a future expires_at', () => {
    const futureTs = Math.floor(Date.now() / 1000) + 7200;
    const offers = [makeOffer(130, { status: 'Pending', expires_at: futureTs })];

    mockUseOffererOffers.mockReturnValue({ offers, isLoading: false, error: null, refresh: mockRefresh });

    render(<OffersPage />);
    expect(screen.getByTestId('offer-countdown-130')).toBeInTheDocument();
  });
});
