/**
 * Unit tests for useMagicWallet.ts
 */
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockIsMagicLoggedIn = jest.fn();
const mockLoginWithMagicLink = jest.fn();
const mockLoginWithPasskey = jest.fn();
const mockGetMagicUserMetadata = jest.fn();
const mockLogoutFromMagic = jest.fn();

jest.mock('@/lib/magic', () => ({
  isMagicLoggedIn: (...args: unknown[]) => mockIsMagicLoggedIn(...args),
  loginWithMagicLink: (...args: unknown[]) => mockLoginWithMagicLink(...args),
  loginWithPasskey: (...args: unknown[]) => mockLoginWithPasskey(...args),
  getMagicUserMetadata: (...args: unknown[]) => mockGetMagicUserMetadata(...args),
  logoutFromMagic: (...args: unknown[]) => mockLogoutFromMagic(...args),
}));

jest.mock('@/providers/PostHogProvider', () => ({
  trackEvent: {
    walletConnected: jest.fn(),
    walletConnectionDropOff: jest.fn(),
  },
}));

import { useMagicWallet } from '@/hooks/useMagicWallet';

// ── Helpers ───────────────────────────────────────────────────────────────────

function StatusComp() {
  const { status, email, publicAddress, isConnecting, isConnected, error,
          loginWithEmail, loginWithPasskey, logout, refresh } = useMagicWallet();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="email">{email ?? 'null'}</span>
      <span data-testid="address">{publicAddress ?? 'null'}</span>
      <span data-testid="connecting">{String(isConnecting)}</span>
      <span data-testid="connected">{String(isConnected)}</span>
      <span data-testid="error">{error ?? 'none'}</span>
      <button data-testid="login-email" onClick={() => loginWithEmail('test@test.com')}>email</button>
      <button data-testid="login-passkey" onClick={() => loginWithPasskey()}>passkey</button>
      <button data-testid="logout" onClick={() => logout()}>logout</button>
      <button data-testid="refresh" onClick={() => refresh()}>refresh</button>
    </div>
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useMagicWallet', () => {
  beforeEach(() => jest.clearAllMocks());

  it('starts in NOT_INITIALIZED status and transitions to DISCONNECTED after refresh', async () => {
    mockIsMagicLoggedIn.mockResolvedValueOnce(false);
    render(<StatusComp />);
    // Initially NOT_INITIALIZED
    expect(screen.getByTestId('status').textContent).toBe('NOT_INITIALIZED');
    await waitFor(() =>
      expect(screen.getByTestId('status').textContent).toBe('DISCONNECTED')
    );
  });

  it('shows CONNECTED status when already logged in on mount', async () => {
    mockIsMagicLoggedIn.mockResolvedValueOnce(true);
    mockGetMagicUserMetadata.mockResolvedValueOnce({
      email: 'user@test.com',
      publicAddress: 'GMAGIC',
    });
    render(<StatusComp />);
    await waitFor(() =>
      expect(screen.getByTestId('status').textContent).toBe('CONNECTED')
    );
    expect(screen.getByTestId('email').textContent).toBe('user@test.com');
    expect(screen.getByTestId('address').textContent).toBe('GMAGIC');
    expect(screen.getByTestId('connected').textContent).toBe('true');
  });

  it('loginWithEmail sets connected state on success', async () => {
    mockIsMagicLoggedIn.mockResolvedValueOnce(false);
    mockLoginWithMagicLink.mockResolvedValueOnce({
      email: 'new@test.com',
      publicAddress: 'GNEW',
    });

    const user = userEvent.setup();
    render(<StatusComp />);
    await waitFor(() =>
      expect(screen.getByTestId('status').textContent).toBe('DISCONNECTED')
    );

    await user.click(screen.getByTestId('login-email'));
    await waitFor(() =>
      expect(screen.getByTestId('status').textContent).toBe('CONNECTED')
    );
    expect(screen.getByTestId('email').textContent).toBe('new@test.com');
    expect(screen.getByTestId('address').textContent).toBe('GNEW');
  });

  it('loginWithEmail sets error state on failure', async () => {
    mockIsMagicLoggedIn.mockResolvedValueOnce(false);
    mockLoginWithMagicLink.mockRejectedValueOnce(new Error('email login failed'));

    // Render a version of the component that swallows the rethrow from the hook
    function SafeStatusComp() {
      const { status, error, loginWithEmail } = useMagicWallet();
      return (
        <div>
          <span data-testid="status">{status}</span>
          <span data-testid="error">{error ?? 'none'}</span>
          <button
            data-testid="login-email"
            onClick={() => loginWithEmail('test@test.com').catch(() => { /* swallow */ })}
          >email</button>
        </div>
      );
    }

    const user = userEvent.setup();
    render(<SafeStatusComp />);
    await waitFor(() =>
      expect(screen.getByTestId('status').textContent).toBe('DISCONNECTED')
    );

    await user.click(screen.getByTestId('login-email'));
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).not.toBe('none')
    );
    expect(screen.getByTestId('status').textContent).toBe('DISCONNECTED');
  });

  it('loginWithPasskey sets connected state on success', async () => {
    mockIsMagicLoggedIn.mockResolvedValueOnce(false);
    mockLoginWithPasskey.mockResolvedValueOnce({
      email: 'pk@test.com',
      publicAddress: 'GPK',
    });

    const user = userEvent.setup();
    render(<StatusComp />);
    await waitFor(() =>
      expect(screen.getByTestId('status').textContent).toBe('DISCONNECTED')
    );

    await user.click(screen.getByTestId('login-passkey'));
    await waitFor(() =>
      expect(screen.getByTestId('status').textContent).toBe('CONNECTED')
    );
    expect(screen.getByTestId('address').textContent).toBe('GPK');
  });

  it('logout clears state', async () => {
    mockIsMagicLoggedIn.mockResolvedValueOnce(true);
    mockGetMagicUserMetadata.mockResolvedValueOnce({
      email: 'user@test.com',
      publicAddress: 'GMAGIC',
    });
    mockLogoutFromMagic.mockResolvedValueOnce(undefined);

    const user = userEvent.setup();
    render(<StatusComp />);
    await waitFor(() =>
      expect(screen.getByTestId('connected').textContent).toBe('true')
    );

    await user.click(screen.getByTestId('logout'));
    await waitFor(() =>
      expect(screen.getByTestId('status').textContent).toBe('DISCONNECTED')
    );
    expect(screen.getByTestId('email').textContent).toBe('null');
    expect(screen.getByTestId('address').textContent).toBe('null');
  });

  it('refresh re-checks login status', async () => {
    mockIsMagicLoggedIn
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mockGetMagicUserMetadata.mockResolvedValueOnce({
      email: 'refreshed@test.com',
      publicAddress: 'GREFRESHED',
    });

    const user = userEvent.setup();
    render(<StatusComp />);
    await waitFor(() =>
      expect(screen.getByTestId('status').textContent).toBe('DISCONNECTED')
    );

    await user.click(screen.getByTestId('refresh'));
    await waitFor(() =>
      expect(screen.getByTestId('status').textContent).toBe('CONNECTED')
    );
    expect(screen.getByTestId('address').textContent).toBe('GREFRESHED');
  });
});
