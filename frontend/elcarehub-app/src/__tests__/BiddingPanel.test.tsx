/**
 * Component tests for BiddingPanel.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockBid = jest.fn();
const mockFinalize = jest.fn();

jest.mock('@/context/WalletContext', () => ({
  useWalletContext: () => ({ publicKey: 'GBIDDER123' }),
}));

jest.mock('@/hooks/usePlaceBid', () => ({
  usePlaceBid: () => ({ bid: mockBid, isBidding: false, error: null }),
}));

jest.mock('@/hooks/useAuctions', () => ({
  useFinalizeAuction: () => ({ finalize: mockFinalize, isFinalizing: false, error: null }),
  useMinBidIncrement: () => 1_000_000n,
}));

jest.mock('@/hooks/useServerClock', () => ({
  useServerClock: () => ({ offsetMs: 0, isSynced: false }),
}));

jest.mock('@/hooks/useTxLifecycle', () => ({
  useTxLifecycle: () => ({
    txState: { state: 'idle', txHash: null, error: null },
    isActive: false,
    run: async (action: () => Promise<boolean>) => action(),
    reset: jest.fn(),
  }),
  txStatusMessage: () => '',
  isTxActive: () => false,
}));

jest.mock('@/components/WalletGuard', () => ({
  GuardButton: ({
    children,
    onAction,
    disabled,
  }: {
    children: React.ReactNode;
    onAction: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onAction} disabled={disabled}>
      {children}
    </button>
  ),
}));

jest.mock('@/components/TxErrorPanel', () => ({
  TxErrorPanel: () => null,
}));

jest.mock('@/lib/contract', () => ({
  stroopsToXlm: (v: bigint) => String(Number(v) / 10_000_000),
}));

jest.mock('@/config/tokens', () => ({
  getTokenConfigByAddress: () => null,
  getNativeTokenConfig: () => ({ address: 'NATIVE', decimals: 7, symbol: 'XLM' }),
}));

jest.mock('@/lib/config', () => ({
  config: { networkPassphrase: 'test-network', contractId: 'test-contract' },
}));

jest.mock('lucide-react', () =>
  Object.fromEntries(
    ['Gavel', 'Clock', 'Trophy', 'User', 'AlertCircle', 'CheckCircle', 'Loader2']
      .map((name) => [name, () => <span />])
  )
);

import { BiddingPanel } from '@/components/BiddingPanel';

function makeAuction(overrides = {}) {
  return {
    auction_id: 1,
    creator: 'GCREATOR',
    artist: 'GARTIST',
    metadata_cid: 'Qm',
    collection: 'CCOLLECTION',
    token_id: 1,
    token: 'CTOKEN',
    created_at: 100,
    recipients: [],
    reserve_price: 10_000_000n, // 1 XLM
    highest_bid: 0n,
    highest_bidder: null,
    end_time: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    status: 'Active' as const,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BiddingPanel', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders the reserve price label', () => {
    render(<BiddingPanel auction={makeAuction()} />);
    expect(screen.getByText(/reserve price/i)).toBeInTheDocument();
  });

  it('renders the bid input field for active auctions', () => {
    render(<BiddingPanel auction={makeAuction()} />);
    expect(screen.getByPlaceholderText(/min/i)).toBeInTheDocument();
  });

  it('calls bid with correct amount when Place Bid is clicked', async () => {
    mockBid.mockResolvedValueOnce(true);
    const onBidPlaced = jest.fn();
    const user = userEvent.setup();

    render(<BiddingPanel auction={makeAuction()} onBidPlaced={onBidPlaced} />);
    await user.clear(screen.getByPlaceholderText(/min/i));
    await user.type(screen.getByPlaceholderText(/min/i), '2');
    await user.click(screen.getByRole('button', { name: /place bid/i }));

    await waitFor(() => expect(mockBid).toHaveBeenCalledWith(1, 2));
    await waitFor(() => expect(onBidPlaced).toHaveBeenCalled());
  });

  it('shows current highest bid label when one exists', () => {
    render(
      <BiddingPanel auction={makeAuction({ highest_bid: 20_000_000n, highest_bidder: 'GBIDDER' })} />
    );
    expect(screen.getByText(/highest bidder/i)).toBeInTheDocument();
  });

  it('shows Finalize button for expired auctions', () => {
    render(
      <BiddingPanel
        auction={makeAuction({ end_time: 1, status: 'Active' })}
      />
    );
    expect(screen.getByRole('button', { name: /finalize/i })).toBeInTheDocument();
  });

  it('closes bidding and hides the bid action after the deadline', () => {
    render(<BiddingPanel auction={makeAuction({ end_time: 1 })} />);

    expect(screen.getByText(/bidding is closed because this auction has ended/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /place bid/i })).not.toBeInTheDocument();
  });

  it('calls finalize when Finalize Auction is clicked', async () => {
    mockFinalize.mockResolvedValueOnce(true);
    const onFinalized = jest.fn();
    const user = userEvent.setup();

    render(
      <BiddingPanel
        auction={makeAuction({ end_time: 1 })}
        onFinalized={onFinalized}
      />
    );
    await user.click(screen.getByRole('button', { name: /finalize/i }));
    await waitFor(() => expect(mockFinalize).toHaveBeenCalledWith(1));
    await waitFor(() => expect(onFinalized).toHaveBeenCalled());
  });

  it('shows Finalized badge for completed auctions', () => {
    render(<BiddingPanel auction={makeAuction({ status: 'Finalized' })} />);
    expect(screen.getByText(/finalized/i)).toBeInTheDocument();
  });

  // ── ISSUE-019 tests: minimum next bid ───────────────────────────────────────

  it('displays the minimum next bid when there is an existing bid', () => {
    render(
      <BiddingPanel
        auction={makeAuction({ highest_bid: 20_000_000n, highest_bidder: 'GBIDDER' })}
      />
    );
    expect(screen.getByTestId('minimum-next-bid')).toBeInTheDocument();
    // Minimum = 2 XLM (current) + 0.1 XLM (contract default increment) = 2.1
    expect(screen.getByTestId('minimum-next-bid').textContent).toContain('2.1');
  });

  it('shows the reserve as the minimum next bid before the first bid', () => {
    render(<BiddingPanel auction={makeAuction({ highest_bid: 0n })} />);
    expect(screen.getByTestId('minimum-next-bid').textContent).toContain('1 XLM');
  });

  it('blocks bids below the minimum next bid with an inline error', async () => {
    const user = userEvent.setup();
    mockBid.mockResolvedValueOnce(true);

    render(
      <BiddingPanel
        auction={makeAuction({ highest_bid: 20_000_000n, highest_bidder: 'GBIDDER' })}
      />
    );

    // Try to bid below the configured minimum (2.1 XLM) — should be rejected.
    const input = screen.getByPlaceholderText(/min/i);
    await user.clear(input);
    await user.type(input, '2');

    // Wait for validation error.
    await waitFor(() => {
      expect(screen.getByText(/minimum bid is/i)).toBeInTheDocument();
    });

    // Place Bid button should be disabled.
    const bidBtn = screen.getByRole('button', { name: /place bid/i });
    expect(bidBtn).toBeDisabled();

    // mockBid should NOT have been called.
    expect(mockBid).not.toHaveBeenCalled();
  });

  it('allows bids equal to or above the minimum next bid', async () => {
    const user = userEvent.setup();
    mockBid.mockResolvedValueOnce(true);

    render(
      <BiddingPanel
        auction={makeAuction({ highest_bid: 20_000_000n, highest_bidder: 'GBIDDER' })}
      />
    );

    const input = screen.getByPlaceholderText(/min/i);
    await user.clear(input);
    // Bid exactly minimum next bid: 2.1 XLM
    await user.type(input, '2.1');

    // Should have NO validation error.
    await waitFor(() => {
      expect(screen.queryByText(/minimum bid is/i)).not.toBeInTheDocument();
    });

    // Button should be enabled.
    const bidBtn = screen.getByRole('button', { name: /place bid/i });
    expect(bidBtn).not.toBeDisabled();

    await user.click(bidBtn);
    await waitFor(() => expect(mockBid).toHaveBeenCalledWith(1, 2.1));
  });

  it('pre-fills the input with the minimum next bid on mount', async () => {
    render(
      <BiddingPanel
        auction={makeAuction({ highest_bid: 20_000_000n, highest_bidder: 'GBIDDER' })}
      />
    );

    const input = screen.getByPlaceholderText(/min/i) as HTMLInputElement;
    // Should be pre-filled with 2.1 (current + contract increment).
    await waitFor(() => {
      expect(input.value).toBe('2.1');
    });
  });
});
