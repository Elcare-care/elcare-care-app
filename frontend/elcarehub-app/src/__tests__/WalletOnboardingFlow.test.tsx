/**
 * __tests__/WalletOnboardingFlow.test.tsx
 *
 * Tests for WalletOnboardingProvider, WalletOnboardingModal, and
 * the useOnboarding hook.
 */
import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock("posthog-js", () => ({ capture: jest.fn() }));

jest.mock("@/context/WalletContext", () => ({
  useWalletContext: jest.fn(),
}));

jest.mock("@/components/ConnectWalletModal", () => ({
  ConnectWalletModal: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? (
      <div data-testid="connect-modal">
        <button onClick={onClose}>Close modal</button>
      </div>
    ) : null,
}));

import { WalletOnboardingProvider, useOnboarding } from "@/components/onboarding/WalletOnboardingFlow";
import { useWalletContext } from "@/context/WalletContext";

const mockWalletCtx = {
  isConnected: false,
  publicKey: null,
  walletType: null,
  freighter: { isInstalled: true },
  lobstr: { isInstalled: false },
  clearAllWalletErrors: jest.fn(),
};

// ── localStorage stub ─────────────────────────────────────────────────────────

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(window, "localStorage", { value: localStorageMock });

// ── helpers ───────────────────────────────────────────────────────────────────

function renderProvider(options: { alreadyCompleted?: boolean } = {}) {
  if (options.alreadyCompleted) {
    localStorageMock.setItem("elcarehub_onboarding_v1", "done");
  } else {
    localStorageMock.clear();
  }
  (useWalletContext as jest.Mock).mockReturnValue(mockWalletCtx);
  return render(
    <WalletOnboardingProvider>
      <div data-testid="app-content">App</div>
    </WalletOnboardingProvider>
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("WalletOnboardingProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorageMock.clear();
  });

  it("renders children regardless of onboarding state", () => {
    renderProvider();
    expect(screen.getByTestId("app-content")).toBeInTheDocument();
  });

  it("shows the modal on first visit (no localStorage key)", async () => {
    renderProvider();
    // Modal appears after mount (useEffect)
    await act(async () => {});
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("does not show modal when already completed", async () => {
    renderProvider({ alreadyCompleted: true });
    await act(async () => {});
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("step 1 shows 'What is a Wallet?' content", async () => {
    renderProvider();
    await act(async () => {});
    expect(screen.getByText(/what is a wallet\?/i)).toBeInTheDocument();
    expect(screen.getByText(/your digital identity/i)).toBeInTheDocument();
  });

  it("Next advances to step 2", async () => {
    renderProvider();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText(/choose your wallet/i)).toBeInTheDocument();
  });

  it("Back button is disabled on step 1", async () => {
    renderProvider();
    await act(async () => {});
    expect(screen.getByRole("button", { name: /back/i })).toBeDisabled();
  });

  it("Back returns to previous step", async () => {
    renderProvider();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.getByText(/what is a wallet\?/i)).toBeInTheDocument();
  });

  it("step 2 shows wallet options including detected badge for Freighter", async () => {
    renderProvider();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText(/freighter/i)).toBeInTheDocument();
    expect(screen.getByText(/detected/i)).toBeInTheDocument();
  });

  it("step 3 shows network & fees content", async () => {
    renderProvider();
    await act(async () => {});
    // advance to step 3
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText(/network & fees/i)).toBeInTheDocument();
    expect(screen.getByText(/what network should I use/i)).toBeInTheDocument();
  });

  it("step 4 shows connect button when not connected", async () => {
    renderProvider();
    await act(async () => {});
    // advance to step 4
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByRole("button", { name: /connect my wallet/i })).toBeInTheDocument();
  });

  it("step 4 shows connected state when wallet is connected", async () => {
    (useWalletContext as jest.Mock).mockReturnValue({ ...mockWalletCtx, isConnected: true, walletType: "freighter" });
    renderProvider();
    await act(async () => {});
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText(/you're connected!/i)).toBeInTheDocument();
  });

  it("clicking connect opens ConnectWalletModal on step 4", async () => {
    renderProvider();
    await act(async () => {});
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /connect my wallet/i }));
    expect(screen.getByTestId("connect-modal")).toBeInTheDocument();
  });

  it("X button closes the modal and persists completion", async () => {
    renderProvider();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /skip onboarding/i }));
    await act(async () => {});
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(localStorageMock.getItem("elcarehub_onboarding_v1")).toBe("done");
  });

  it("progress bar advances with steps", async () => {
    renderProvider();
    await act(async () => {});
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "1");
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
  });
});
