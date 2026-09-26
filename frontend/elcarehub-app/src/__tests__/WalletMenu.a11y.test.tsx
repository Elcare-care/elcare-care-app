// ─────────────────────────────────────────────────────────────────────────────
// __tests__/WalletMenu.a11y.test.tsx
//
// Accessibility tests for WalletMenu:
//   - Copy button has accessible name that changes on copy success
//   - Full address is exposed via sr-only text
//   - Balance region announces loading and value states to AT
//   - Disconnect button has an accessible name
//   - All interactive elements are keyboard reachable
// ─────────────────────────────────────────────────────────────────────────────

import React from "react";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WalletMenu } from "../components/WalletMenu";

const DEFAULT_PROPS = {
  address: "GABC1234567890GABC1234567890GABC1234567890GABC1234567890ABC",
  balance: "42.5000000",
  isLoadingBalance: false,
  onDisconnect: jest.fn(),
};

// Mock clipboard
Object.assign(navigator, {
  clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("WalletMenu — copy button a11y", () => {
  it("has an accessible name when not copied", () => {
    render(<WalletMenu {...DEFAULT_PROPS} />);
    expect(
      screen.getByRole("button", { name: /copy wallet address/i })
    ).toBeInTheDocument();
  });

  it("accessible name changes to 'copied' after clicking", async () => {
    render(<WalletMenu {...DEFAULT_PROPS} />);
    const btn = screen.getByRole("button", { name: /copy wallet address/i });

    await act(async () => {
      fireEvent.click(btn);
    });

    expect(
      screen.getByRole("button", { name: /address copied/i })
    ).toBeInTheDocument();
  });

  it("aria-pressed is true after copy and false initially", async () => {
    render(<WalletMenu {...DEFAULT_PROPS} />);
    const btn = screen.getByRole("button", { name: /copy wallet address/i });
    expect(btn).toHaveAttribute("aria-pressed", "false");

    await act(async () => { fireEvent.click(btn); });

    expect(
      screen.getByRole("button", { name: /address copied/i })
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("accessible name reverts after 2 seconds", async () => {
    render(<WalletMenu {...DEFAULT_PROPS} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /copy wallet address/i }));
    });
    expect(screen.queryByRole("button", { name: /copy wallet address/i })).toBeNull();

    act(() => jest.advanceTimersByTime(2001));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /copy wallet address/i })
      ).toBeInTheDocument();
    });
  });
});

describe("WalletMenu — full address exposure", () => {
  it("exposes the full address in sr-only text", () => {
    render(<WalletMenu {...DEFAULT_PROPS} />);
    // The sr-only span contains the full address
    expect(screen.getByText(/full wallet address:/i)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(DEFAULT_PROPS.address))).toBeInTheDocument();
  });
});

describe("WalletMenu — balance live region", () => {
  it("balance container has role=status and aria-live=polite", () => {
    render(<WalletMenu {...DEFAULT_PROPS} />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
  });

  it("aria-label includes the balance value when loaded", () => {
    render(<WalletMenu {...DEFAULT_PROPS} />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-label")).toMatch(/42\.5/);
    expect(region.getAttribute("aria-label")).toMatch(/XLM/i);
  });

  it("aria-label says 'Fetching balance' while loading", () => {
    render(<WalletMenu {...DEFAULT_PROPS} isLoadingBalance={true} />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-label")).toMatch(/fetching balance/i);
  });

  it("renders sr-only loading message while loading", () => {
    render(<WalletMenu {...DEFAULT_PROPS} isLoadingBalance={true} />);
    expect(screen.getByText(/fetching balance, please wait/i)).toBeInTheDocument();
  });
});

describe("WalletMenu — disconnect button a11y", () => {
  it("has an accessible name mentioning disconnect", () => {
    render(<WalletMenu {...DEFAULT_PROPS} />);
    const btn = screen.getByRole("button", { name: /disconnect wallet/i });
    expect(btn).toBeInTheDocument();
  });

  it("calls onDisconnect when clicked", async () => {
    const onDisconnect = jest.fn();
    render(<WalletMenu {...DEFAULT_PROPS} onDisconnect={onDisconnect} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /disconnect wallet/i }));
    });
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});

describe("WalletMenu — keyboard navigation", () => {
  it("all interactive elements are reachable via Tab", async () => {
    const user = userEvent.setup({ delay: null });
    render(<WalletMenu {...DEFAULT_PROPS} />);

    // Tab through: copy button → disconnect button
    await user.tab();
    const focused1 = document.activeElement;
    expect(focused1?.getAttribute("aria-label")).toMatch(/copy wallet address/i);

    await user.tab();
    const focused2 = document.activeElement;
    expect(focused2?.getAttribute("aria-label")).toMatch(/disconnect wallet/i);
  });
});
