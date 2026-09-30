/**
 * Unit tests for useAdmin.ts hooks.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetTotalListings = jest.fn();
const mockGetAllListings = jest.fn();
const mockGetTreasury = jest.fn();
const mockGetProtocolFee = jest.fn();
const mockGetAdmin = jest.fn();
const mockRevokeArtist = jest.fn();
const mockReinstateArtist = jest.fn();
const mockIsArtistRevoked = jest.fn();
const mockAddTokenToWhitelist = jest.fn();
const mockRemoveTokenFromWhitelist = jest.fn();
const mockGetTokenWhitelist = jest.fn();

jest.mock('@/lib/contract', () => ({
  getTotalListings: (...args: unknown[]) => mockGetTotalListings(...args),
  getAllListings: (...args: unknown[]) => mockGetAllListings(...args),
  getTreasury: (...args: unknown[]) => mockGetTreasury(...args),
  getProtocolFee: (...args: unknown[]) => mockGetProtocolFee(...args),
  getAdmin: (...args: unknown[]) => mockGetAdmin(...args),
  revokeArtist: (...args: unknown[]) => mockRevokeArtist(...args),
  reinstateArtist: (...args: unknown[]) => mockReinstateArtist(...args),
  isArtistRevoked: (...args: unknown[]) => mockIsArtistRevoked(...args),
  addTokenToWhitelist: (...args: unknown[]) => mockAddTokenToWhitelist(...args),
  removeTokenFromWhitelist: (...args: unknown[]) => mockRemoveTokenFromWhitelist(...args),
  getTokenWhitelist: (...args: unknown[]) => mockGetTokenWhitelist(...args),
}));

// Horizon.Server mock — not needed for these tests
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: {
    Server: jest.fn().mockImplementation(() => ({
      loadAccount: jest.fn().mockResolvedValue({ balances: [] }),
    })),
  },
}));

jest.mock('@/lib/config', () => ({
  config: { contractId: 'CTEST123', horizonUrl: 'https://horizon-testnet.stellar.org', networkPassphrase: 'Test SDF Network ; September 2015', network: 'testnet', rpcUrl: 'https://soroban-testnet.stellar.org', indexerUrl: '' },
}));

import {
  useAdminStats,
  useModeration,
  useTokenManagement,
  useAdminCheck,
  useListingOversight,
} from '@/hooks/useAdmin';

// ── useAdminStats ─────────────────────────────────────────────────────────────

describe('useAdminStats', () => {
  beforeEach(() => jest.clearAllMocks());

  it('loads stats successfully', async () => {
    mockGetTotalListings.mockResolvedValueOnce(10);
    mockGetAllListings.mockResolvedValueOnce([
      { artist: 'GA' },
      { artist: 'GB' },
      { artist: 'GA' }, // duplicate — unique count = 2
    ]);
    mockGetProtocolFee.mockResolvedValueOnce(250);
    mockGetTreasury.mockResolvedValueOnce('GTREASURY');

    function Comp() {
      const { stats, isLoading } = useAdminStats();
      if (isLoading || !stats) return <span data-testid="loading">yes</span>;
      return (
        <div>
          <span data-testid="listings">{stats.totalListings}</span>
          <span data-testid="users">{stats.totalUsers}</span>
          <span data-testid="fee">{stats.protocolFeeBps}</span>
          <span data-testid="treasury">{stats.treasuryAddress}</span>
        </div>
      );
    }
    render(<Comp />);
    await waitFor(() => expect(screen.queryByTestId('loading')).not.toBeInTheDocument());
    expect(screen.getByTestId('listings').textContent).toBe('10');
    expect(screen.getByTestId('users').textContent).toBe('2');
    expect(screen.getByTestId('fee').textContent).toBe('250');
    expect(screen.getByTestId('treasury').textContent).toBe('GTREASURY');
  });

  it('sets error when contract call fails', async () => {
    mockGetTotalListings.mockRejectedValueOnce(new Error('chain down'));

    function Comp() {
      const { error } = useAdminStats();
      return <span data-testid="error">{error ?? 'none'}</span>;
    }
    render(<Comp />);
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).not.toBe('none')
    );
  });
});

// ── useModeration ─────────────────────────────────────────────────────────────

describe('useModeration', () => {
  beforeEach(() => jest.clearAllMocks());

  it('revoke does nothing when adminPublicKey is null', async () => {
    function Comp() {
      const { revoke } = useModeration(null);
      const [done, setDone] = React.useState(false);
      return (
        <div>
          <button onClick={async () => { await revoke('GARTIST'); setDone(true); }}>r</button>
          <span data-testid="done">{String(done)}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('done').textContent).toBe('true'));
    expect(mockRevokeArtist).not.toHaveBeenCalled();
  });

  it('calls revokeArtist with correct args', async () => {
    mockRevokeArtist.mockResolvedValueOnce(undefined);
    function Comp() {
      const { revoke } = useModeration('GADMIN');
      const [result, setResult] = React.useState<boolean | undefined>(undefined);
      return (
        <div>
          <button onClick={async () => setResult(await revoke('GARTIST') as boolean)}>r</button>
          <span data-testid="result">{String(result)}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('true'));
    expect(mockRevokeArtist).toHaveBeenCalledWith('GADMIN', 'GARTIST');
  });

  it('calls reinstateArtist with correct args', async () => {
    mockReinstateArtist.mockResolvedValueOnce(undefined);
    function Comp() {
      const { reinstate } = useModeration('GADMIN');
      const [result, setResult] = React.useState<boolean | undefined>(undefined);
      return (
        <div>
          <button onClick={async () => setResult(await reinstate('GARTIST') as boolean)}>re</button>
          <span data-testid="result">{String(result)}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('true'));
    expect(mockReinstateArtist).toHaveBeenCalledWith('GADMIN', 'GARTIST');
  });

  it('checkStatus returns revoked flag from contract', async () => {
    mockIsArtistRevoked.mockResolvedValueOnce(true);
    function Comp() {
      const { checkStatus } = useModeration('GADMIN');
      const [status, setStatus] = React.useState<boolean | undefined>(undefined);
      return (
        <div>
          <button onClick={async () => setStatus(await checkStatus('GARTIST'))}>c</button>
          <span data-testid="status">{String(status)}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await user.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('true'));
  });
});

// ── useTokenManagement ────────────────────────────────────────────────────────

describe('useTokenManagement', () => {
  beforeEach(() => jest.clearAllMocks());

  it('loads the token whitelist on mount', async () => {
    mockGetTokenWhitelist.mockResolvedValueOnce(['CTOKENA', 'CTOKENB']);

    function Comp() {
      const { whitelistedTokens } = useTokenManagement('GADMIN');
      return <span data-testid="tokens">{whitelistedTokens.join(',')}</span>;
    }
    render(<Comp />);
    await waitFor(() =>
      expect(screen.getByTestId('tokens').textContent).toBe('CTOKENA,CTOKENB')
    );
  });

  it('adds a token optimistically and confirms on success', async () => {
    mockGetTokenWhitelist.mockResolvedValueOnce([]);
    mockAddTokenToWhitelist.mockResolvedValueOnce(undefined);

    function Comp() {
      const { whitelistedTokens, whitelist } = useTokenManagement('GADMIN');
      return (
        <div>
          <button onClick={() => whitelist('CNEWTOKEN')}>add</button>
          <span data-testid="tokens">{whitelistedTokens.join(',')}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await waitFor(() => expect(screen.getByTestId('tokens').textContent).toBe(''));
    await user.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(screen.getByTestId('tokens').textContent).toBe('CNEWTOKEN')
    );
  });

  it('rolls back token addition on contract failure', async () => {
    mockGetTokenWhitelist.mockResolvedValueOnce(['CEXISTING']);
    mockAddTokenToWhitelist.mockRejectedValueOnce(new Error('failed'));

    function Comp() {
      const { whitelistedTokens, whitelist } = useTokenManagement('GADMIN');
      return (
        <div>
          <button onClick={() => whitelist('CFAIL')}>add</button>
          <span data-testid="tokens">{whitelistedTokens.join(',')}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await waitFor(() => expect(screen.getByTestId('tokens').textContent).toBe('CEXISTING'));
    await user.click(screen.getByRole('button'));
    // After rollback, should revert to the original list
    await waitFor(() =>
      expect(screen.getByTestId('tokens').textContent).toBe('CEXISTING')
    );
  });
});

// ── useAdminCheck ─────────────────────────────────────────────────────────────

describe('useAdminCheck', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns isAdmin=false when publicKey is null', async () => {
    function Comp() {
      const { isAdmin, isLoading } = useAdminCheck(null);
      return (
        <div>
          <span data-testid="admin">{String(isAdmin)}</span>
          <span data-testid="loading">{String(isLoading)}</span>
        </div>
      );
    }
    render(<Comp />);
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('admin').textContent).toBe('false');
  });

  it('returns isAdmin=true when publicKey matches admin address', async () => {
    mockGetAdmin.mockResolvedValueOnce('GADMIN');
    function Comp() {
      const { isAdmin, isLoading } = useAdminCheck('GADMIN');
      return (
        <div>
          <span data-testid="admin">{String(isAdmin)}</span>
          <span data-testid="loading">{String(isLoading)}</span>
        </div>
      );
    }
    render(<Comp />);
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('admin').textContent).toBe('true');
  });

  it('returns isAdmin=false when publicKey does not match', async () => {
    mockGetAdmin.mockResolvedValueOnce('GADMIN');
    function Comp() {
      const { isAdmin } = useAdminCheck('GNOTADMIN');
      return <span data-testid="admin">{String(isAdmin)}</span>;
    }
    render(<Comp />);
    await waitFor(() => expect(screen.getByTestId('admin').textContent).toBe('false'));
  });
});

// ── useListingOversight ───────────────────────────────────────────────────────

describe('useListingOversight', () => {
  beforeEach(() => jest.clearAllMocks());

  const mockListings = [
    { listing_id: 1, artist: 'GA', collection: 'CA', token_id: 1, price: 100n, currency: 'XLM', token: 'XLM', recipients: [], status: 'Active', owner: null, created_at: 1000000 },
    { listing_id: 2, artist: 'GB', collection: 'CB', token_id: 2, price: 200n, currency: 'XLM', token: 'XLM', recipients: [], status: 'Sold', owner: 'GX', created_at: 1000001 },
    { listing_id: 3, artist: 'GA', collection: 'CC', token_id: 3, price: 300n, currency: 'XLM', token: 'XLM', recipients: [], status: 'Cancelled', owner: null, created_at: 1000002 },
  ];

  it('loads listings and returns first page when admin key is provided', async () => {
    mockGetAllListings.mockResolvedValueOnce(mockListings);
    function Comp() {
      const { listings, totalCount, isLoading } = useListingOversight('GADMIN');
      if (isLoading) return <span data-testid="loading">yes</span>;
      return (
        <div>
          <span data-testid="count">{totalCount}</span>
          <span data-testid="first">{listings[0]?.listing_id}</span>
        </div>
      );
    }
    render(<Comp />);
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('3'));
    expect(screen.getByTestId('first').textContent).toBe('1');
  });

  it('returns empty list and does not call getAllListings when admin key is null', () => {
    function Comp() {
      const { listings, isLoading } = useListingOversight(null);
      return (
        <div>
          <span data-testid="count">{listings.length}</span>
          <span data-testid="loading">{String(isLoading)}</span>
        </div>
      );
    }
    render(<Comp />);
    expect(screen.getByTestId('count').textContent).toBe('0');
    expect(mockGetAllListings).not.toHaveBeenCalled();
  });

  it('filters by artist address when filter is set', async () => {
    mockGetAllListings.mockResolvedValueOnce(mockListings);
    function Comp() {
      const { listings, totalCount, setFilter, isLoading } = useListingOversight('GADMIN');
      if (isLoading) return <span data-testid="loading">yes</span>;
      return (
        <div>
          <button onClick={() => setFilter('gb')}>Filter GB</button>
          <span data-testid="count">{totalCount}</span>
          <span data-testid="first-artist">{listings[0]?.artist}</span>
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Comp />);
    await waitFor(() => expect(screen.queryByTestId('loading')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /filter gb/i }));
    expect(screen.getByTestId('count').textContent).toBe('1');
    expect(screen.getByTestId('first-artist').textContent).toBe('GB');
  });

  it('shows error message when getAllListings rejects', async () => {
    mockGetAllListings.mockRejectedValueOnce(new Error('Network error'));
    function Comp() {
      const { error, isLoading } = useListingOversight('GADMIN');
      if (isLoading) return <span data-testid="loading">yes</span>;
      return <span data-testid="error">{error ?? 'none'}</span>;
    }
    render(<Comp />);
    await waitFor(() => expect(screen.getByTestId('error').textContent).toMatch(/network error/i));
  });
});
