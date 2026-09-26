/**
 * __tests__/WalletErrorDisplay.test.tsx
 *
 * Tests for the unified WalletErrorDisplay component and its variants.
 * Covers all WalletAdapterError.kind values, action wiring, and accessibility.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  WalletErrorDisplay,
  WalletErrorInline,
  IndexerDelayNotice,
} from "@/components/WalletErrorDisplay";
import type { WalletAdapterError } from "@/lib/wallet-adapter";

// ── helpers ───────────────────────────────────────────────────────────────────

function mkError(kind: WalletAdapterError["kind"], extra: Record<string, unknown> = {}): WalletAdapterError {
  if (kind === "WRONG_NETWORK") {
    return { kind, message: "wrong network", expected: "Test SDF", detected: "Public SDF", ...extra } as WalletAdapterError;
  }
  if (kind === "UNSUPPORTED_CAPABILITY") {
    return { kind, message: "unsupported", capability: "canUsePasskey", ...extra } as WalletAdapterError;
  }
  return { kind, message: `${kind} error`, ...extra } as WalletAdapterError;
}

// ── WalletErrorDisplay ────────────────────────────────────────────────────────

describe("WalletErrorDisplay", () => {
  it("renders with role=alert", () => {
    render(<WalletErrorDisplay error={mkError("NOT_INSTALLED")} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("shows title and instruction for NOT_INSTALLED", () => {
    render(<WalletErrorDisplay error={mkError("NOT_INSTALLED")} />);
    expect(screen.getByText(/wallet extension not found/i)).toBeInTheDocument();
    expect(screen.getByText(/install/i)).toBeInTheDocument();
  });

  it("shows install link for NOT_INSTALLED", () => {
    render(<WalletErrorDisplay error={mkError("NOT_INSTALLED")} />);
    const link = screen.getByRole("link", { name: /install freighter/i });
    expect(link).toHaveAttribute("href", "https://www.freighter.app/");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("shows USER_REJECTED title and retry button", () => {
    const onRetry = jest.fn();
    render(<WalletErrorDisplay error={mkError("USER_REJECTED")} onRetry={onRetry} />);
    expect(screen.getByText(/request declined/i)).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /try again/i });
    fireEvent.click(btn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows WRONG_NETWORK with expected/detected in explanation", () => {
    render(
      <WalletErrorDisplay
        error={{ kind: "WRONG_NETWORK", message: "wrong", expected: "Test SDF Network", detected: "Public Global" }}
      />
    );
    expect(screen.getByText(/wrong network/i)).toBeInTheDocument();
    expect(screen.getByText(/stellar testnet/i)).toBeInTheDocument();
  });

  it("calls onSwitchNetwork for WRONG_NETWORK primary action", () => {
    const onSwitch = jest.fn();
    render(
      <WalletErrorDisplay
        error={{ kind: "WRONG_NETWORK", message: "wrong", expected: "Test SDF", detected: null }}
        onSwitchNetwork={onSwitch}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /refresh connection/i }));
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });

  it("calls onDismiss when X is clicked", () => {
    const onDismiss = jest.fn();
    render(<WalletErrorDisplay error={mkError("SIGN_FAILED")} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("hides dismiss button when onDismiss is null", () => {
    render(<WalletErrorDisplay error={mkError("SIGN_FAILED")} onDismiss={null} />);
    expect(screen.queryByRole("button", { name: /dismiss/i })).not.toBeInTheDocument();
  });

  it("renders ACCOUNT_UNAVAILABLE with reconnect action", () => {
    const onRetry = jest.fn();
    render(<WalletErrorDisplay error={mkError("ACCOUNT_UNAVAILABLE")} onRetry={onRetry} />);
    expect(screen.getByText(/account unavailable/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("renders PROVIDER_CONFLICT with reload action", () => {
    const reloadSpy = jest.spyOn(window.location, "reload").mockImplementation(() => {});
    render(<WalletErrorDisplay error={mkError("PROVIDER_CONFLICT")} />);
    expect(screen.getByText(/wallet conflict/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /reload page/i }));
    expect(reloadSpy).toHaveBeenCalled();
    reloadSpy.mockRestore();
  });

  it("renders UNKNOWN error with message", () => {
    render(<WalletErrorDisplay error={{ kind: "UNKNOWN", message: "something broke" }} />);
    expect(screen.getByText(/something broke/i)).toBeInTheDocument();
  });

  it("has aria-live=assertive", () => {
    render(<WalletErrorDisplay error={mkError("SIGN_FAILED")} />);
    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
  });
});

// ── WalletErrorInline ─────────────────────────────────────────────────────────

describe("WalletErrorInline", () => {
  it("renders with role=alert", () => {
    render(<WalletErrorInline error={mkError("USER_REJECTED")} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("shows title text", () => {
    render(<WalletErrorInline error={mkError("USER_REJECTED")} />);
    expect(screen.getByText(/request declined/i)).toBeInTheDocument();
  });

  it("shows retry button when onRetry provided", () => {
    const onRetry = jest.fn();
    render(<WalletErrorInline error={mkError("UNKNOWN")} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("hides retry button when onRetry not provided", () => {
    render(<WalletErrorInline error={mkError("NOT_INSTALLED")} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

// ── IndexerDelayNotice ────────────────────────────────────────────────────────

describe("IndexerDelayNotice", () => {
  it("renders with role=status", () => {
    render(<IndexerDelayNotice />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows txHash when provided", () => {
    render(<IndexerDelayNotice txHash="abc123" />);
    expect(screen.getByText(/abc123/)).toBeInTheDocument();
  });

  it("calls onRefresh when refresh button clicked", () => {
    const onRefresh = jest.fn();
    render(<IndexerDelayNotice onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it("hides refresh button when onRefresh not provided", () => {
    render(<IndexerDelayNotice />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
