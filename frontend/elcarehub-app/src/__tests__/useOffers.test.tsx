/**
 * Unit tests for useOffers.ts hooks.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetOffer = jest.fn();
const mockGetOffererOffers = jest.fn();
const mockGetListingOffers = jest.fn();
const mockGetArtistListings = jest.fn();
const mockGetListing = jest.fn();
const mockWithdrawOffer = jest.fn();
const mockAcceptOffer = jest.fn();
const mockRejectOffer = jest.fn();
const mockMakeOffer = jest.fn();
const mockPushToast = jest.fn();
const mockTxToastRun = jest.fn();

jest.mock('@/lib/contract', () => ({
  getOffer: (...args: unknown[]) => mockGetOffer(...args),
  getOffererOffers: (...args: unknown[]) => mockGetOffererOffers(...args),
  getListingOffers: (...args: unknown[]) => mockGetListingOffers(...args),
  getArtistListings: (...args: unknown[]) => mockGetArtistListings(...args),
  getListing: (...args: unknown[]) => mockGetListing(...args),
  withdrawOffer: (...args: unknown[]) => mockWithdrawOffer(...args),
  acceptOffer: (...args: unknown[]) => mockAcceptOffer(...args),
  rejectOffer: (...args: unknown[]) => mockRejectOffer(...args),
  makeOffer: (...args: unknown[]) => mockMakeOffer(...args),
}));

jest.mock('@/lib/errors', () => ({
  getReadableErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

jest.mock('@/hooks/useTransientErrorToast', () => ({
  useTransientErrorToast: jest.fn(),
}));

jest.mock('@/components/ToastProvider', () => ({
  useToast: () => ({ pushToast: mockPushToast }),
}));

// Mock useTxToast so action hooks don't block on the 30-second indexer timer.
// The mock calls pushToast with the action label (matching what the hooks pass),
// invokes fn(), and returns the result — or null on failure.
jest.mock('@/hooks/useTxToast', () => ({
  useTxToast: () => ({
    run: mockTxToastRun,
    isRunning: false,
    phase: 'idle',
  }),
}));

import {
  useOffererOffers,
  useListingOffers,
  useIncomingOffers,
  useWithdrawOffer,
  useAcceptOffer,
  useRejectOffer,
  useMakeOffer,
} from '@/hooks/useOffers';

// Configure mockTxToastRun as a transparent pass-through by default.
// Tests that need failure behaviour reset it per-test.
beforeEach(() => {
  jest.clearAllMocks();
  mockTxToastRun.mockImplementation(
    async (fn: () => Promise<unknown>, opts?: { action?: string; successMessage?: () => string }) => {
      const action = opts?.action ?? 'Transaction';
      mockPushToast(`${action}\u2026`, 'info');
      try {
        const result = await fn();
        const successMsg = opts?.successMessage ? opts.successMessage() : `${action} confirmed`;
        mockPushToast(successMsg, 'success');
        return result;
      } catch (_err) {
        return null;
      }
    }
  );
});

function makeOffer(id: number) {
  return {
    offer_id: id,
    listing_id: 1,
    offerer: 'GOFFERER',
    amount: 5_000_000n,
    token: 'CTOKEN',
    status: 'Pending',
    created_at: 1000,
  };
}

function makeListing(id: number) {
  return {
    listing_id: id,
    artist: 'GARTIST',
    status: 'Active',
    price: 10_000_000n,
    metadata_cid: 'Qm',
  };
}

// ── useOffererOffers ──────────────────────────────────────────────────────────

describe('useOffererOffers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does nothing when publicKey is null', () => {
    function Comp() {
      const { offers, isLoading } = useOffererOffers(null);
      return (
        <div>
          <span data-testid="count">{offers.length}</span>
          <span data-testid="loading">{String(isLoading)}</span>
        </div>
      );
    }
    render(<Comp />);
    expect(screen.getByTestId('count').textContent).toBe('0');
    expect(screen.getByTestId('loading').textContent).toBe('false');
  });

  it('loads and enriches offers with listing data', async () => {
    mockGetOffererOffers.mockResolvedValueOnce([10, 11]);
    mockGetOffer
      .mockResolvedValueOnce(makeOffer(10))
      .mockResolvedValueOnce(makeOffer(11));
    mockGetListing.mockResolvedValue(makeListing(1));

    function Comp() {
      const { offers } = useOffererOffers('GOFFERER');
      return <span data-testid="count">{offers.length}</span>;
    }
    render(<Comp />);
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('2'));
  });

  it('sets error when fetch fails', async () => {
    mockGetOffererOffers.mockRejectedValueOnce(new Error('fail'));

    function Comp() {
      const { error } = useOffererOffers('GOFFERER');
      return <span data-testid="error">{error ?? 'none'}</span>;
    }
    render(<Comp />);
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).not.toBe('none')
    );
  });
});

// ── useListingOffers ──────────────────────────────────────────────────────────

describe('useListingOffers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does nothing when listingId is null', () => {
    function Comp() {
      const { offers, isLoading } = useListingOffers(null);
      return (
        <div>
          <span data-testid="count">{offers.length}</span>
          <span data-testid="loading">{String(isLoading)}</span>
        </div>
      );
    }
    render(<Comp />);
    expect(screen.getByTestId('count').textContent).toBe('0');
    expect(screen.getByTestId('loading').textContent).toBe('false');
  });

  it('fetches offers for a listing', async () => {
    mockGetListingOffers.mockResolvedValueOnce([5, 6]);
    mockGetOffer
      .mockResolvedValueOnce(makeOffer(5))
      .mockResolvedValueOnce(makeOffer(6));

    function Comp() {
      const { offers } = useListingOffers(1);
      return <span data-testid="count">{offers.length}</span>;
    }
    render(<Comp />);
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('2'));
  });
});

// ── useIncomingOffers ─────────────────────────────────────────────────────────

describe('useIncomingOffers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does nothing when ownerPublicKey is null', () => {
    function Comp() {
      const { offersByListing } = useIncomingOffers(null);
      return <span data-testid="count">{offersByListing.length}</span>;
    }
    render(<Comp />);
    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  it('fetches offers for all active listings of the owner', async () => {
    mockGetArtistListings.mockResolvedValueOnce([1]);
    mockGetListing.mockResolvedValueOnce(makeListing(1));
    mockGetListingOffers.mockResolvedValueOnce([7]);
    mockGetOffer.mockResolvedValueOnce(makeOffer(7));

    function Comp() {
      const { offersByListing } = useIncomingOffers('GOWNER');
      return <span data-testid="count">{offersByListing.length}</span>;
    }
    render(<Comp />);
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('1'));
  });
});

// ── useWithdrawOffer ──────────────────────────────────────────────────────────

describe('useWithdrawOffer', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns false when publicKey is null', async () => {
    function Comp() {
      const { withdraw } = useWithdrawOffer(null);
      const [result, setResult] = React.useState<boolean | undefined>(undefined);
      return (
        <div>
          <button onClick={async () => setResult(await withdraw(1))}>w</button>
          <span data-testid="result">{String(result)}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('false'));
  });

  it('calls withdrawOffer and returns true on success', async () => {
    mockWithdrawOffer.mockResolvedValueOnce(undefined);

    function Comp() {
      const { withdraw } = useWithdrawOffer('GPUBLICKEY');
      const [result, setResult] = React.useState<boolean | undefined>(undefined);
      return (
        <div>
          <button onClick={async () => setResult(await withdraw(3))}>w</button>
          <span data-testid="result">{String(result)}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('true'));
    expect(mockWithdrawOffer).toHaveBeenCalledWith('GPUBLICKEY', 3);
  });
});

// ── useAcceptOffer ────────────────────────────────────────────────────────────

describe('useAcceptOffer', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns false when publicKey is null', async () => {
    function Comp() {
      const { accept } = useAcceptOffer(null);
      const [result, setResult] = React.useState<boolean | undefined>(undefined);
      return (
        <div>
          <button onClick={async () => setResult(await accept(1))}>a</button>
          <span data-testid="result">{String(result)}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('false'));
  });

  it('calls acceptOffer and returns true on success', async () => {
    mockAcceptOffer.mockResolvedValueOnce(undefined);

    function Comp() {
      const { accept } = useAcceptOffer('GARTIST');
      const [result, setResult] = React.useState<boolean | undefined>(undefined);
      return (
        <div>
          <button onClick={async () => setResult(await accept(5))}>a</button>
          <span data-testid="result">{String(result)}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('true'));
    expect(mockAcceptOffer).toHaveBeenCalledWith('GARTIST', 5);
  });
});

// ── useRejectOffer ────────────────────────────────────────────────────────────

describe('useRejectOffer', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls rejectOffer and returns true on success', async () => {
    mockRejectOffer.mockResolvedValueOnce(undefined);

    function Comp() {
      const { reject } = useRejectOffer('GARTIST');
      const [result, setResult] = React.useState<boolean | undefined>(undefined);
      return (
        <div>
          <button onClick={async () => setResult(await reject(8))}>r</button>
          <span data-testid="result">{String(result)}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('true'));
    expect(mockRejectOffer).toHaveBeenCalledWith('GARTIST', 8);
  });

  it('sets error and returns false on failure', async () => {
    mockRejectOffer.mockRejectedValueOnce(new Error('reject failed'));

    function Comp() {
      const { reject, error } = useRejectOffer('GARTIST');
      const [result, setResult] = React.useState<boolean | undefined>(undefined);
      return (
        <div>
          <button onClick={async () => setResult(await reject(8))}>r</button>
          <span data-testid="result">{String(result)}</span>
          <span data-testid="error">{error ?? 'none'}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('false'));
    expect(screen.getByTestId('error').textContent).not.toBe('none');
  });
});

// ── useMakeOffer ──────────────────────────────────────────────────────────────

describe('useMakeOffer', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns false when publicKey is null', async () => {
    function Comp() {
      const { make } = useMakeOffer(null);
      const [result, setResult] = React.useState<boolean | undefined>(undefined);
      return (
        <div>
          <button onClick={async () => setResult(await make(1, 5, 'CTOKEN'))}>m</button>
          <span data-testid="result">{String(result)}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('false'));
  });

  it('calls makeOffer and returns true on success', async () => {
    mockMakeOffer.mockResolvedValueOnce(undefined);

    function Comp() {
      const { make } = useMakeOffer('GBIDDER');
      const [result, setResult] = React.useState<boolean | undefined>(undefined);
      return (
        <div>
          <button onClick={async () => setResult(await make(2, 3, 'CTOKEN'))}>m</button>
          <span data-testid="result">{String(result)}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('true'));
    expect(mockMakeOffer).toHaveBeenCalledWith('GBIDDER', 2, 3, 'CTOKEN');
  });
});

// ── useWithdrawOffer — extended tests ─────────────────────────────────────────

describe('useWithdrawOffer (extended)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sets error and returns false on failure', async () => {
    mockWithdrawOffer.mockRejectedValueOnce(new Error('withdraw failed'));

    function Comp() {
      const { withdraw, error } = useWithdrawOffer('GPUBLICKEY');
      const [result, setResult] = React.useState<boolean | undefined>(undefined);
      return (
        <div>
          <button onClick={async () => setResult(await withdraw(5))}>w</button>
          <span data-testid="result">{String(result)}</span>
          <span data-testid="error">{error ?? 'none'}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('false'));
    expect(screen.getByTestId('error').textContent).not.toBe('none');
  });

  it('shows lifecycle toasts on successful withdraw', async () => {
    mockWithdrawOffer.mockResolvedValueOnce(undefined);

    function Comp() {
      const { withdraw } = useWithdrawOffer('GPUBLICKEY');
      return <button onClick={() => withdraw(1)}>w</button>;
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => {
      expect(mockPushToast).toHaveBeenCalledWith('Withdrawing offer\u2026', 'info');
      expect(mockPushToast).toHaveBeenCalledWith('Offer withdrawn successfully', 'success');
    });
  });
});

// ── useOffererOffers — refresh test ───────────────────────────────────────────

describe('useOffererOffers (extended)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('can refresh manually to re-fetch offers', async () => {
    // First load
    mockGetOffererOffers.mockResolvedValueOnce([10]);
    mockGetOffer.mockResolvedValueOnce(makeOffer(10));
    mockGetListing.mockResolvedValueOnce(makeListing(1));

    function Comp() {
      const { offers, refresh } = useOffererOffers('GOFFERER');
      return (
        <div>
          <span data-testid="count">{offers.length}</span>
          <button onClick={refresh}>refresh</button>
        </div>
      );
    }
    render(<Comp />);
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('1'));

    // Second call setup
    mockGetOffererOffers.mockResolvedValueOnce([10, 11]);
    mockGetOffer
      .mockResolvedValueOnce(makeOffer(10))
      .mockResolvedValueOnce(makeOffer(11));
    mockGetListing.mockResolvedValue(makeListing(1));

    const user = userEvent.setup();
    await user.click(screen.getByText('refresh'));
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('2'));
  });
});

// ── useIncomingOffers — inactive listings skipped ─────────────────────────────

describe('useIncomingOffers (extended)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('skips non-Active listings and only fetches offers for active ones', async () => {
    const activeListing = makeListing(1);
    const soldListing = { ...makeListing(2), status: 'Sold' };

    mockGetArtistListings.mockResolvedValueOnce([1, 2]);
    mockGetListing
      .mockResolvedValueOnce(activeListing)
      .mockResolvedValueOnce(soldListing);
    // Only the active listing should trigger getListingOffers
    mockGetListingOffers.mockResolvedValueOnce([7]);
    mockGetOffer.mockResolvedValueOnce(makeOffer(7));

    function Comp() {
      const { offersByListing } = useIncomingOffers('GOWNER');
      return (
        <div>
          <span data-testid="count">{offersByListing.length}</span>
          {offersByListing.map((g: any) => (
            <span key={g.listing.listing_id} data-testid={`group-${g.listing.listing_id}`}>
              {g.offers.length}
            </span>
          ))}
        </div>
      );
    }
    render(<Comp />);
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('1'));
    // Only listing 1 should have a group
    expect(screen.getByTestId('group-1')).toBeInTheDocument();
    expect(screen.queryByTestId('group-2')).not.toBeInTheDocument();
    // getListingOffers should only have been called once (for the active listing)
    expect(mockGetListingOffers).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests for useFreshOffer and preflight-guarded action hooks
// ─────────────────────────────────────────────────────────────────────────────

// Additional contract mocks needed for preflight tests
const mockDeriveOfferUIStatus = jest.fn();

jest.mock('@/lib/contract', () => ({
  getOffer: (...args: unknown[]) => mockGetOffer(...args),
  getOffererOffers: (...args: unknown[]) => mockGetOffererOffers(...args),
  getListingOffers: (...args: unknown[]) => mockGetListingOffers(...args),
  getArtistListings: (...args: unknown[]) => mockGetArtistListings(...args),
  getListing: (...args: unknown[]) => mockGetListing(...args),
  withdrawOffer: (...args: unknown[]) => mockWithdrawOffer(...args),
  acceptOffer: (...args: unknown[]) => mockAcceptOffer(...args),
  rejectOffer: (...args: unknown[]) => mockRejectOffer(...args),
  makeOffer: (...args: unknown[]) => mockMakeOffer(...args),
  deriveOfferUIStatus: (...args: unknown[]) => mockDeriveOfferUIStatus(...args),
}));

import { useFreshOffer, useReclaimOffer } from '@/hooks/useOffers';

describe('useFreshOffer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: deriveOfferUIStatus returns the offer's status
    mockDeriveOfferUIStatus.mockImplementation((o: any) => o.status);
  });

  it('returns offer and its derived uiStatus on success', async () => {
    const offer = makeOffer(50);
    mockGetOffer.mockResolvedValueOnce(offer);
    mockDeriveOfferUIStatus.mockReturnValueOnce('Pending');

    let result: any;
    function Comp() {
      const { fetchFreshOffer } = useFreshOffer();
      return (
        <button
          onClick={async () => {
            result = await fetchFreshOffer(50);
          }}
        >
          fetch
        </button>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(result).not.toBeUndefined());
    expect(result?.offer.offer_id).toBe(50);
    expect(result?.uiStatus).toBe('Pending');
  });

  it('returns null when getOffer throws', async () => {
    mockGetOffer.mockRejectedValueOnce(new Error('network error'));

    let result: any = 'initial';
    function Comp() {
      const { fetchFreshOffer } = useFreshOffer();
      return (
        <button
          onClick={async () => {
            result = await fetchFreshOffer(99);
          }}
        >
          fetch
        </button>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(result).toBe(null));
  });
});

describe('useWithdrawOffer — preflight guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeriveOfferUIStatus.mockImplementation((o: any) => o.status);
  });

  it('aborts and returns false when fresh state is "Accepted"', async () => {
    // Fresh fetch returns an accepted offer → preflight blocks the withdraw
    mockGetOffer.mockResolvedValueOnce({ ...makeOffer(60), status: 'Accepted' });
    mockDeriveOfferUIStatus.mockReturnValueOnce('Accepted');

    function Comp() {
      const { withdraw } = useWithdrawOffer('GPUBKEY');
      const [res, setRes] = React.useState<boolean | undefined>(undefined);
      return (
        <div>
          <button onClick={async () => setRes(await withdraw(60))}>w</button>
          <span data-testid="result">{String(res)}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('false'));
    // withdrawOffer should never have been called
    expect(mockWithdrawOffer).not.toHaveBeenCalled();
  });

  it('aborts and returns false when fresh state is "Expired"', async () => {
    mockGetOffer.mockResolvedValueOnce({ ...makeOffer(61), status: 'Pending', expires_at: 1 });
    mockDeriveOfferUIStatus.mockReturnValueOnce('Expired');

    function Comp() {
      const { withdraw } = useWithdrawOffer('GPUBKEY');
      const [res, setRes] = React.useState<boolean | undefined>(undefined);
      return (
        <div>
          <button onClick={async () => setRes(await withdraw(61))}>w</button>
          <span data-testid="result">{String(res)}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('false'));
    expect(mockWithdrawOffer).not.toHaveBeenCalled();
  });

  it('proceeds when fresh state is "Pending"', async () => {
    mockGetOffer.mockResolvedValueOnce(makeOffer(62));
    mockDeriveOfferUIStatus.mockReturnValueOnce('Pending');
    mockWithdrawOffer.mockResolvedValueOnce(undefined);

    function Comp() {
      const { withdraw } = useWithdrawOffer('GPUBKEY');
      const [res, setRes] = React.useState<boolean | undefined>(undefined);
      return (
        <div>
          <button onClick={async () => setRes(await withdraw(62))}>w</button>
          <span data-testid="result">{String(res)}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('true'));
    expect(mockWithdrawOffer).toHaveBeenCalledWith('GPUBKEY', 62);
  });

  it('proceeds when fresh state is "Stale" (still actionable)', async () => {
    mockGetOffer.mockResolvedValueOnce(makeOffer(63));
    mockDeriveOfferUIStatus.mockReturnValueOnce('Stale');
    mockWithdrawOffer.mockResolvedValueOnce(undefined);

    function Comp() {
      const { withdraw } = useWithdrawOffer('GPUBKEY');
      const [res, setRes] = React.useState<boolean | undefined>(undefined);
      return (
        <div>
          <button onClick={async () => setRes(await withdraw(63))}>w</button>
          <span data-testid="result">{String(res)}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('true'));
    expect(mockWithdrawOffer).toHaveBeenCalledWith('GPUBKEY', 63);
  });
});

describe('useAcceptOffer — preflight guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeriveOfferUIStatus.mockImplementation((o: any) => o.status);
  });

  it('aborts when fresh state is "Withdrawn"', async () => {
    mockGetOffer.mockResolvedValueOnce({ ...makeOffer(70), status: 'Withdrawn' });
    mockDeriveOfferUIStatus.mockReturnValueOnce('Withdrawn');

    function Comp() {
      const { accept } = useAcceptOffer('GARTIST');
      const [res, setRes] = React.useState<boolean | undefined>(undefined);
      return (
        <div>
          <button onClick={async () => setRes(await accept(70))}>a</button>
          <span data-testid="result">{String(res)}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('false'));
    expect(mockAcceptOffer).not.toHaveBeenCalled();
  });

  it('proceeds when fresh state is "Pending"', async () => {
    mockGetOffer.mockResolvedValueOnce(makeOffer(71));
    mockDeriveOfferUIStatus.mockReturnValueOnce('Pending');
    mockAcceptOffer.mockResolvedValueOnce(undefined);

    function Comp() {
      const { accept } = useAcceptOffer('GARTIST');
      const [res, setRes] = React.useState<boolean | undefined>(undefined);
      return (
        <div>
          <button onClick={async () => setRes(await accept(71))}>a</button>
          <span data-testid="result">{String(res)}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('true'));
    expect(mockAcceptOffer).toHaveBeenCalledWith('GARTIST', 71);
  });
});

describe('useRejectOffer — preflight guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeriveOfferUIStatus.mockImplementation((o: any) => o.status);
  });

  it('aborts when fresh state is "Accepted"', async () => {
    mockGetOffer.mockResolvedValueOnce({ ...makeOffer(80), status: 'Accepted' });
    mockDeriveOfferUIStatus.mockReturnValueOnce('Accepted');

    function Comp() {
      const { reject } = useRejectOffer('GARTIST');
      const [res, setRes] = React.useState<boolean | undefined>(undefined);
      return (
        <div>
          <button onClick={async () => setRes(await reject(80))}>r</button>
          <span data-testid="result">{String(res)}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('false'));
    expect(mockRejectOffer).not.toHaveBeenCalled();
  });

  it('proceeds when fresh state is "Pending"', async () => {
    mockGetOffer.mockResolvedValueOnce(makeOffer(81));
    mockDeriveOfferUIStatus.mockReturnValueOnce('Pending');
    mockRejectOffer.mockResolvedValueOnce(undefined);

    function Comp() {
      const { reject } = useRejectOffer('GARTIST');
      const [res, setRes] = React.useState<boolean | undefined>(undefined);
      return (
        <div>
          <button onClick={async () => setRes(await reject(81))}>r</button>
          <span data-testid="result">{String(res)}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('true'));
    expect(mockRejectOffer).toHaveBeenCalledWith('GARTIST', 81);
  });
});

describe('useReclaimOffer — preflight guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('aborts when fresh state is not "Expired"', async () => {
    mockGetOffer.mockResolvedValueOnce(makeOffer(90));
    mockDeriveOfferUIStatus.mockReturnValueOnce('Pending');

    function Comp() {
      const { reclaim } = useReclaimOffer('GPUBKEY');
      const [res, setRes] = React.useState<boolean | undefined>(undefined);
      return (
        <div>
          <button onClick={async () => setRes(await reclaim(90))}>rc</button>
          <span data-testid="result">{String(res)}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('false'));
  });
});
