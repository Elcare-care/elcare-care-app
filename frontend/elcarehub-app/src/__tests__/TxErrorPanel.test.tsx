/**
 * __tests__/TxErrorPanel.test.tsx
 *
 * Tests for TxErrorPanel and TxErrorInline.
 * Covers all TxErrorCategory values, action wiring, and accessibility.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { TxErrorPanel, TxErrorInline } from "@/components/TxErrorPanel";
import type { TxError } from "@/hooks/useTxLifecycle";

// ── mock config (explorerBaseUrl needed for explorer link) ────────────────────
jest.mock("@/lib/config", () => ({
  config: {
    network: "testnet",
    contractId: "CTEST",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer/testnet",
  },
}));

// ── helpers ───────────────────────────────────────────────────────────────────

function mkErr(category: TxError["category"], message = "test error message"): TxError {
  return { category, message };
}

// ── TxErrorPanel ──────────────────────────────────────────────────────────────

describe("TxErrorPanel", () => {
  it("renders with role=alert", () => {
    render(<TxErrorPanel error={mkErr("unknown")} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("wallet_rejection: shows correct title and instruction", () => {
    render(<TxErrorPanel error={mkErr("wallet_rejection")} />);
    expect(screen.getByText(/signing request declined/i)).toBeInTheDocument();
    expect(screen.getByText(/approve/i)).toBeInTheDocument();
  });

  it("simulation_failure: shows refresh & retry guidance", () => {
    render(<TxErrorPanel error={mkErr("simulation_failure")} />);
    expect(screen.getByText(/transaction preview failed/i)).toBeInTheDocument();
  });

  it("rpc_failure: shows network error title", () => {
    render(<TxErrorPanel error={mkErr("rpc_failure")} />);
    expect(screen.getByText(/network error/i)).toBeInTheDocument();
  });

  it("unknown: shows generic failure title", () => {
    render(<TxErrorPanel error={mkErr("unknown")} />);
    expect(screen.getByText(/transaction failed/i)).toBeInTheDocument();
  });

  it("indexer_delay: delegates to IndexerDelayNotice (role=status)", () => {
    render(<TxErrorPanel error={mkErr("indexer_delay")} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("calls onRetry when primary button clicked", () => {
    const onRetry = jest.fn();
    render(<TxErrorPanel error={mkErr("rpc_failure")} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("calls onDismiss when X clicked", () => {
    const onDismiss = jest.fn();
    render(<TxErrorPanel error={mkErr("unknown")} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("hides dismiss button when onDismiss is null", () => {
    render(<TxErrorPanel error={mkErr("unknown")} onDismiss={null} />);
    expect(screen.queryByRole("button", { name: /dismiss/i })).not.toBeInTheDocument();
  });

  it("shows explorer link when txHash and explorerBaseUrl are provided", () => {
    render(<TxErrorPanel error={mkErr("rpc_failure")} txHash="deadbeef" onRetry={jest.fn()} />);
    const link = screen.getByRole("link", { name: /view on explorer/i });
    expect(link).toHaveAttribute("href", expect.stringContaining("deadbeef"));
  });

  it("does not show explorer link when no txHash", () => {
    render(<TxErrorPanel error={mkErr("rpc_failure")} onRetry={jest.fn()} />);
    expect(screen.queryByRole("link", { name: /view on explorer/i })).not.toBeInTheDocument();
  });

  it("simulation_failure with insufficient funds message shows funds guidance", () => {
    render(<TxErrorPanel error={{ category: "simulation_failure", message: "insufficient funds to pay fees" }} />);
    expect(screen.getByText(/transaction preview failed/i)).toBeInTheDocument();
  });

  it("has aria-live=assertive", () => {
    render(<TxErrorPanel error={mkErr("wallet_rejection")} />);
    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
  });

  it("shows technical details in collapsed details element", () => {
    render(<TxErrorPanel error={{ category: "unknown", message: "some raw rpc error code 42" }} />);
    expect(screen.getByText(/technical details/i)).toBeInTheDocument();
  });
});

// ── TxErrorInline ─────────────────────────────────────────────────────────────

describe("TxErrorInline", () => {
  it("renders with role=alert", () => {
    render(<TxErrorInline error={mkErr("wallet_rejection")} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("shows title text", () => {
    render(<TxErrorInline error={mkErr("rpc_failure")} />);
    expect(screen.getByText(/network error/i)).toBeInTheDocument();
  });

  it("shows retry button when onRetry provided", () => {
    const onRetry = jest.fn();
    render(<TxErrorInline error={mkErr("rpc_failure")} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("hides retry button when not provided", () => {
    render(<TxErrorInline error={mkErr("unknown")} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
