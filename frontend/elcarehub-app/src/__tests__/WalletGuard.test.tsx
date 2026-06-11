/**
 * Component tests for WalletGuard and GuardButton.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockWalletContext = {
  isConnected: true,
  isWrongNetwork: false,
  status: 'connected' as const,
  publicKey: 'GPUBKEY',
  connect: jest.fn(),
  disconnect: jest.fn(),
  refresh: jest.fn(),
  isInstalled: true,
  isConnecting: false,
  error: null,
  networkPassphrase: null,
};

jest.mock('@/context/WalletContext', () => ({
  useWalletContext: () => mockWalletContext,
}));

// ConnectWalletModal — render nothing to keep tests simple
jest.mock('@/components/ConnectWalletModal', () => ({
  ConnectWalletModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="connect-modal" /> : null,
}));

jest.mock('lucide-react', () => ({
  Wallet: () => <span />,
  AlertTriangle: () => <span />,
}));

import { WalletGuard, GuardButton } from '@/components/WalletGuard';

// ── WalletGuard ───────────────────────────────────────────────────────────────

describe('WalletGuard', () => {
  beforeEach(() => {
    mockWalletContext.isConnected = true;
    mockWalletContext.isWrongNetwork = false;
    jest.clearAllMocks();
  });

  it('renders children when wallet is connected', () => {
    render(
      <WalletGuard>
        <span data-testid="child">Protected Content</span>
      </WalletGuard>
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('renders the default fallback (Connect Wallet) when disconnected', () => {
    mockWalletContext.isConnected = false;
    render(
      <WalletGuard>
        <span data-testid="child">Protected Content</span>
      </WalletGuard>
    );
    expect(screen.getByRole('button', { name: /connect wallet/i })).toBeInTheDocument();
    expect(screen.queryByTestId('child')).not.toBeInTheDocument();
  });

  it('renders custom fallback when provided and disconnected', () => {
    mockWalletContext.isConnected = false;
    render(
      <WalletGuard fallback={<span data-testid="custom-fallback">Login</span>}>
        <span>Protected</span>
      </WalletGuard>
    );
    expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
  });

  it('opens ConnectWalletModal when Connect Wallet button is clicked while disconnected', async () => {
    mockWalletContext.isConnected = false;
    const user = userEvent.setup();
    render(
      <WalletGuard>
        <span>Protected</span>
      </WalletGuard>
    );
    await user.click(screen.getByRole('button', { name: /connect wallet/i }));
    await waitFor(() =>
      expect(screen.getByTestId('connect-modal')).toBeInTheDocument()
    );
  });
});

// ── GuardButton ───────────────────────────────────────────────────────────────

describe('GuardButton', () => {
  beforeEach(() => {
    mockWalletContext.isConnected = true;
    mockWalletContext.isWrongNetwork = false;
    jest.clearAllMocks();
  });

  it('calls onAction when wallet is connected', async () => {
    const onAction = jest.fn();
    const user = userEvent.setup();
    render(
      <GuardButton onAction={onAction}>Buy Now</GuardButton>
    );
    await user.click(screen.getByRole('button', { name: /buy now/i }));
    expect(onAction).toHaveBeenCalled();
  });

  it('opens ConnectWalletModal and does NOT call onAction when wallet is disconnected', async () => {
    mockWalletContext.isConnected = false;
    const onAction = jest.fn();
    const user = userEvent.setup();
    render(
      <GuardButton onAction={onAction}>Buy Now</GuardButton>
    );
    await user.click(screen.getByRole('button', { name: /buy now/i }));
    expect(onAction).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId('connect-modal')).toBeInTheDocument()
    );
  });

  it('opens ConnectWalletModal when wallet is on wrong network', async () => {
    mockWalletContext.isConnected = true;
    mockWalletContext.isWrongNetwork = true;
    const onAction = jest.fn();
    const user = userEvent.setup();
    render(
      <GuardButton onAction={onAction}>Buy Now</GuardButton>
    );
    await user.click(screen.getByRole('button', { name: /buy now/i }));
    expect(onAction).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId('connect-modal')).toBeInTheDocument()
    );
  });

  it('respects the disabled prop', () => {
    render(
      <GuardButton onAction={jest.fn()} disabled>
        Disabled
      </GuardButton>
    );
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
