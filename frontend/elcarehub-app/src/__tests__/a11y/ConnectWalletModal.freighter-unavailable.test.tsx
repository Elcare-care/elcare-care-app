import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock the freighter library so no live extension is required.
jest.mock('@/lib/freighter', () => ({
  isFreighterInstalled: jest.fn(),
  connectFreighter: jest.fn(),
  getFreighterPublicKey: jest.fn(),
  signTransaction: jest.fn(),
}));

// Mock the wallet context so we can observe connection state without a real wallet.
const mockConnect = jest.fn();
const mockDisconnect = jest.fn();

const mockWalletState = {
  isConnected: false,
  publicKey: null as string | null,
  connect: mockConnect,
  disconnect: mockDisconnect,
};

jest.mock('@/context/WalletContext', () => ({
  __esModule: true,
  useWallet: () => mockWalletState,
  WalletProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import * as freighter from '@/lib/freighter';
import ConnectWalletModal from '@/components/ConnectWalletModal';

const mockedIsFreighterInstalled = freighter.isFreighterInstalled as jest.Mock;
const mockedConnectFreighter = freighter.connectFreighter as jest.Mock;

describe('ConnectWalletModal - Freighter unavailable (#1137)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWalletState.isConnected = false;
    mockWalletState.publicKey = null;
    // Freighter is not installed in the browser.
    mockedIsFreighterInstalled.mockResolvedValue(false);
    // Attempting to connect rejects because the extension is absent.
    mockedConnectFreighter.mockRejectedValue(
      new Error('Freighter extension not found'),
    );
  });

  it('shows the "Wallet Extension Not Found" copy and install/retry action', async () => {
    render(<ConnectWalletModal isOpen onClose={jest.fn()} />);

    // Trigger the Freighter connect path.
    const freighterButton = await screen.findByRole('button', {
      name: /freighter/i,
    });
    fireEvent.click(freighterButton);

    expect(
      await screen.findByText(/wallet extension not found/i),
    ).toBeInTheDocument();

    // A safe next step (install / retry) is offered.
    expect(
      screen.getByRole('button', { name: /install|retry|try again/i }),
    ).toBeInTheDocument();
  });

  it('re-invokes the connect path when retry is clicked', async () => {
    render(<ConnectWalletModal isOpen onClose={jest.fn()} />);

    const freighterButton = await screen.findByRole('button', {
      name: /freighter/i,
    });
    fireEvent.click(freighterButton);

    await screen.findByText(/wallet extension not found/i);
    expect(mockedConnectFreighter).toHaveBeenCalledTimes(1);

    const retryButton = screen.getByRole('button', {
      name: /retry|try again/i,
    });
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(mockedConnectFreighter).toHaveBeenCalledTimes(2);
    });
  });

  it('never reports a connected wallet state when Freighter is unavailable', async () => {
    render(<ConnectWalletModal isOpen onClose={jest.fn()} />);

    const freighterButton = await screen.findByRole('button', {
      name: /freighter/i,
    });
    fireEvent.click(freighterButton);

    await screen.findByText(/wallet extension not found/i);

    // No false connected status should appear.
    expect(mockWalletState.isConnected).toBe(false);
    expect(mockWalletState.publicKey).toBeNull();
    expect(mockConnect).not.toHaveBeenCalled();
  });
});