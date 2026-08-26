// ─────────────────────────────────────────────────────────────────────────────
// __tests__/WalletGuard.a11y.test.tsx
//
// Accessibility tests for WalletGuard and GuardButton:
//   - Disconnected state: landmark region, sr-only status, visible button
//   - Wrong-network state: landmark region, WrongNetworkBanner rendered
//   - GuardButton: aria-label includes actionName, aria-disabled, aria-busy
//   - Modal opens on GuardButton click when not connected
//   - Focus returns to trigger after modal closes
// ─────────────────────────────────────────────────────────────────────────────

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WalletGuard, GuardButton } from "../components/WalletGuard";

// ── Mock WalletContext ────────────────────────────────────────────────────────

const mockContextBase = {
  isConnected: false,
  isWrongNetwork: false,
  isConnecting: false,
  networkStatus: "not_connected" as const,
  walletType: null,
  networkPassphrase: null,
  publicKey: null,
  balance: null,
  isLoadingBalance: false,
  isInstalled: false,
  error: null,
  status: "DISCONNECTED" as const,
  walletErrorState: { connection: null, signing: null, transaction: null, general: null },
  activeWalletError: null,
  hasWalletError: false,
  staleNetworkDraft: false,
  connect: jest.fn(),
  disconnect: jest.fn(),
  refresh: jest.fn().mockResolvedValue(undefined),
  connectFreighter: jest.fn(),
  connectLobstr: jest.fn(),
  connectMagicEmail: jest.fn(),
  connectMagicPasskey: jest.fn(),
  setSigningError: jest.fn(),
  setTransactionError: jest.fn(),
  clearAllWalletErrors: jest.fn(),
  snapshotDraft: jest.fn().mockReturnValue(0),
  isDraftStale: jest.fn().mockReturnValue(false),
  invalidateDraft: jest.fn(),
  clearStaleDraft: jest.fn(),
  onNetworkChange: jest.fn().mockReturnValue(() => {}),
  freighter: {} as any,
  lobstr: {} as any,
  magic: {} as any,
};

let mockCtx = { ...mockContextBase };

jest.mock("@/context/WalletContext", () => ({
  useWalletContext: () => mockCtx,
}));

// Mock ConnectWalletModal so we don't need its full dep tree
jest.mock("../components/ConnectWalletModal", () => ({
  ConnectWalletModal: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? (
      <div role="dialog" aria-label="Connect Wallet" data-testid="mock-connect-modal">
        <button onClick={onClose} aria-label="Close connect wallet dialog">
          Close
        </button>
      </div>
    ) : null,
}));

// Mock WrongNetworkBanner
jest.mock("../components/WalletErrorDisplay", () => ({
  WrongNetworkBanner: () => (
    <div data-testid="wrong-network-banner">Wrong network</div>
  ),
}));

beforeEach(() => {
  mockCtx = { ...mockContextBase };
});

// ── WalletGuard — disconnected ────────────────────────────────────────────────

describe("WalletGuard — disconnected state a11y", () => {
  it("renders a landmark region with aria-label", () => {
    render(<WalletGuard><p>Protected</p></WalletGuard>);
    expect(
      screen.getByRole("region", { name: /wallet connection required/i })
    ).toBeInTheDocument();
  });

  it("has a sr-only status element with the network status", () => {
    render(<WalletGuard><p>Protected</p></WalletGuard>);
    const status = screen.getByRole("status");
    expect(status).toHaveClass("sr-only");
    // networkStatus = "not_connected" → label contains "not connected"
    expect(status.textContent?.toLowerCase()).toContain("not connected");
  });

  it("renders a connect button with an accessible name", () => {
    render(<WalletGuard><p>Protected</p></WalletGuard>);
    expect(
      screen.getByRole("button", { name: /connect your wallet to continue/i })
    ).toBeInTheDocument();
  });

  it("opens the modal when connect button is clicked", async () => {
    render(<WalletGuard><p>Protected</p></WalletGuard>);
    fireEvent.click(
      screen.getByRole("button", { name: /connect your wallet to continue/i })
    );
    await waitFor(() => {
      expect(screen.getByTestId("mock-connect-modal")).toBeInTheDocument();
    });
  });

  it("shows children when connected", () => {
    mockCtx = { ...mockContextBase, isConnected: true, networkStatus: "correct" as const };
    render(<WalletGuard><p data-testid="protected-content">Protected</p></WalletGuard>);
    expect(screen.getByTestId("protected-content")).toBeInTheDocument();
  });
});

// ── WalletGuard — wrong-network ───────────────────────────────────────────────

describe("WalletGuard — wrong-network state a11y", () => {
  beforeEach(() => {
    mockCtx = {
      ...mockContextBase,
      isConnected: true,
      isWrongNetwork: true,
      networkStatus: "wrong_network" as const,
      walletType: "freighter",
      networkPassphrase: "Public Global Stellar Network ; September 2015",
    };
  });

  it("renders a landmark region labelled 'Wallet network error'", () => {
    render(<WalletGuard><p>Protected</p></WalletGuard>);
    expect(
      screen.getByRole("region", { name: /wallet network error/i })
    ).toBeInTheDocument();
  });

  it("renders a sr-only live region announcing wrong network", () => {
    render(<WalletGuard><p>Protected</p></WalletGuard>);
    const status = screen.getByRole("status");
    expect(status).toHaveClass("sr-only");
    expect(status.textContent?.toLowerCase()).toContain("wrong network");
  });

  it("renders the WrongNetworkBanner", () => {
    render(<WalletGuard><p>Protected</p></WalletGuard>);
    expect(screen.getByTestId("wrong-network-banner")).toBeInTheDocument();
  });

  it("does NOT render protected children when on wrong network", () => {
    render(
      <WalletGuard>
        <p data-testid="protected-content">Protected</p>
      </WalletGuard>
    );
    expect(screen.queryByTestId("protected-content")).not.toBeInTheDocument();
  });
});

// ── GuardButton ────────────────────────────────────────────────────────────────

describe("GuardButton a11y", () => {
  it("has default visible text from children", () => {
    render(
      <GuardButton actionName="Place bid" onAction={jest.fn()}>
        Place Bid
      </GuardButton>
    );
    expect(screen.getByRole("button", { name: /place bid/i })).toBeInTheDocument();
  });

  it("is not disabled when wallet is connected and on correct network", () => {
    mockCtx = { ...mockContextBase, isConnected: true, networkStatus: "correct" as const };
    const onAction = jest.fn();
    render(
      <GuardButton onAction={onAction}>
        Place Bid
      </GuardButton>
    );
    const btn = screen.getByRole("button", { name: /place bid/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("opens modal instead of firing onAction when wallet not connected", async () => {
    const onAction = jest.fn();
    render(<GuardButton onAction={onAction}>Place Bid</GuardButton>);

    fireEvent.click(screen.getByRole("button", { name: /place bid/i }));
    await waitFor(() =>
      expect(screen.getByTestId("mock-connect-modal")).toBeInTheDocument()
    );
    expect(onAction).not.toHaveBeenCalled();
  });

  it("has aria-busy=true when isLoading", () => {
    mockCtx = { ...mockContextBase, isConnected: true, networkStatus: "correct" as const };
    render(<GuardButton isLoading>Place Bid</GuardButton>);
    expect(screen.getByRole("button")).toHaveAttribute("aria-busy", "true");
  });

  it("is disabled when isLoading is true", () => {
    mockCtx = { ...mockContextBase, isConnected: true, networkStatus: "correct" as const };
    render(<GuardButton isLoading>Place Bid</GuardButton>);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("has aria-disabled when wallet not ready", () => {
    render(<GuardButton>Buy</GuardButton>);
    // wallet is not connected — button should signal it's not actionable
    const btn = screen.getByRole("button", { name: /buy/i });
    expect(btn).toHaveAttribute("aria-disabled");
  });
});

// ── GuardButton — focus return ────────────────────────────────────────────────

describe("GuardButton — focus return after modal close", () => {
  it("returns focus to the button after the modal closes", async () => {
    mockCtx = { ...mockContextBase, isConnected: false };
    render(<GuardButton>Buy</GuardButton>);

    const btn = screen.getByRole("button", { name: /buy/i });
    btn.focus();
    fireEvent.click(btn);

    await waitFor(() =>
      expect(screen.getByTestId("mock-connect-modal")).toBeInTheDocument()
    );

    // Close the modal
    fireEvent.click(screen.getByRole("button", { name: /close connect wallet/i }));

    await waitFor(() => {
      expect(document.activeElement).toBe(btn);
    });
  });
});
