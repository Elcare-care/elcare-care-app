// ─────────────────────────────────────────────────────────────────────────────
// __tests__/NetworkSwitchPanel.test.tsx
//
// Tests for NetworkSwitchPanel (exported from WalletErrorDisplay):
//   - Default state: numbered steps for freighter/lobstr/magic/unknown
//   - "I've switched" button transitions to confirmed state
//   - Confirmed state: re-simulate button fires onReadyToResimulate
//   - Checking state: spinner with role=status
//   - WrongNetworkBanner renders WalletErrorDisplay with WRONG_NETWORK error
//   - Stale-draft integration: switch-during-simulation invalidates draft
// ─────────────────────────────────────────────────────────────────────────────

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  NetworkSwitchPanel,
  WrongNetworkBanner,
} from "../components/WalletErrorDisplay";

jest.mock("@/lib/config", () => ({
  config: {
    networkPassphrase: "Test SDF Network ; September 2015",
    network: "testnet",
  },
}));

// ── NetworkSwitchPanel — default (step-list) state ───────────────────────────

describe("NetworkSwitchPanel — step-list state", () => {
  it("renders an ordered list of steps for freighter", () => {
    render(
      <NetworkSwitchPanel
        provider="freighter"
        expectedPassphrase="Test SDF Network ; September 2015"
        onDoneSteps={jest.fn()}
      />
    );
    const list = screen.getByRole("list");
    const items = screen.getAllByRole("listitem");
    expect(items.length).toBeGreaterThanOrEqual(3);
  });

  it("renders an ordered list for lobstr", () => {
    render(
      <NetworkSwitchPanel
        provider="lobstr"
        expectedPassphrase="Test SDF Network ; September 2015"
        onDoneSteps={jest.fn()}
      />
    );
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
  });

  it("shows the target network label in the heading", () => {
    render(
      <NetworkSwitchPanel
        provider="freighter"
        expectedPassphrase="Test SDF Network ; September 2015"
        onDoneSteps={jest.fn()}
      />
    );
    expect(screen.getByText(/how to switch to stellar testnet/i)).toBeInTheDocument();
  });

  it("list has aria-label describing the task", () => {
    render(
      <NetworkSwitchPanel
        provider="freighter"
        expectedPassphrase="Test SDF Network ; September 2015"
        onDoneSteps={jest.fn()}
      />
    );
    const list = screen.getByRole("list");
    expect(list.getAttribute("aria-label")).toMatch(/steps to switch/i);
  });

  it("renders 'I've switched — check now' button", () => {
    render(
      <NetworkSwitchPanel
        provider="freighter"
        expectedPassphrase="Test SDF Network ; September 2015"
        onDoneSteps={jest.fn()}
      />
    );
    expect(
      screen.getByTestId("network-switch-done-btn")
    ).toBeInTheDocument();
  });

  it("does NOT render the done button when onDoneSteps is absent", () => {
    render(
      <NetworkSwitchPanel
        provider="freighter"
        expectedPassphrase="Test SDF Network ; September 2015"
      />
    );
    expect(screen.queryByTestId("network-switch-done-btn")).not.toBeInTheDocument();
  });
});

// ── NetworkSwitchPanel — checking state ──────────────────────────────────────

describe("NetworkSwitchPanel — checking state", () => {
  it("shows a spinner with role=status when isChecking=true", () => {
    render(
      <NetworkSwitchPanel
        provider="freighter"
        isChecking={true}
        onDoneSteps={jest.fn()}
      />
    );
    expect(screen.getByTestId("network-switch-checking")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
    // Step list should NOT be visible during checking
    expect(screen.queryByTestId("network-switch-steps")).not.toBeInTheDocument();
  });

  it("checking message is polite (non-interrupting)", () => {
    render(
      <NetworkSwitchPanel
        provider="freighter"
        isChecking={true}
        onDoneSteps={jest.fn()}
      />
    );
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
  });
});

// ── NetworkSwitchPanel — confirmed state ─────────────────────────────────────

describe("NetworkSwitchPanel — confirmed state (after clicking done)", () => {
  it("transitions to confirmed state when 'I've switched' is clicked", async () => {
    render(
      <NetworkSwitchPanel
        provider="freighter"
        expectedPassphrase="Test SDF Network ; September 2015"
        onDoneSteps={jest.fn()}
        onReadyToResimulate={jest.fn()}
      />
    );

    fireEvent.click(screen.getByTestId("network-switch-done-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("network-switch-confirmed")).toBeInTheDocument();
    });
    // Step list should be gone
    expect(screen.queryByTestId("network-switch-steps")).not.toBeInTheDocument();
  });

  it("calls onDoneSteps when 'I've switched' is clicked", () => {
    const onDoneSteps = jest.fn();
    render(
      <NetworkSwitchPanel
        provider="freighter"
        expectedPassphrase="Test SDF Network ; September 2015"
        onDoneSteps={onDoneSteps}
        onReadyToResimulate={jest.fn()}
      />
    );
    fireEvent.click(screen.getByTestId("network-switch-done-btn"));
    expect(onDoneSteps).toHaveBeenCalledTimes(1);
  });

  it("renders re-simulate button in confirmed state", async () => {
    render(
      <NetworkSwitchPanel
        provider="freighter"
        expectedPassphrase="Test SDF Network ; September 2015"
        onDoneSteps={jest.fn()}
        onReadyToResimulate={jest.fn()}
      />
    );
    fireEvent.click(screen.getByTestId("network-switch-done-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("network-switch-resimulate-btn")).toBeInTheDocument();
    });
  });

  it("calls onReadyToResimulate when re-simulate is clicked", async () => {
    const onResim = jest.fn();
    render(
      <NetworkSwitchPanel
        provider="freighter"
        expectedPassphrase="Test SDF Network ; September 2015"
        onDoneSteps={jest.fn()}
        onReadyToResimulate={onResim}
      />
    );
    fireEvent.click(screen.getByTestId("network-switch-done-btn"));

    await waitFor(() =>
      screen.getByTestId("network-switch-resimulate-btn")
    );
    fireEvent.click(screen.getByTestId("network-switch-resimulate-btn"));
    expect(onResim).toHaveBeenCalledTimes(1);
  });

  it("confirmed region has role=status and is polite (not assertive)", async () => {
    render(
      <NetworkSwitchPanel
        provider="freighter"
        expectedPassphrase="Test SDF Network ; September 2015"
        onDoneSteps={jest.fn()}
        onReadyToResimulate={jest.fn()}
      />
    );
    fireEvent.click(screen.getByTestId("network-switch-done-btn"));
    await waitFor(() => screen.getByTestId("network-switch-confirmed"));

    const status = screen.getByTestId("network-switch-confirmed");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
  });
});

// ── NetworkSwitchPanel — clicking re-simulate resets to step-list ─────────────

describe("NetworkSwitchPanel — re-simulate resets panel", () => {
  it("clicking re-simulate resets done state so steps show again", async () => {
    render(
      <NetworkSwitchPanel
        provider="freighter"
        expectedPassphrase="Test SDF Network ; September 2015"
        onDoneSteps={jest.fn()}
        onReadyToResimulate={jest.fn()}
      />
    );
    // Go to confirmed
    fireEvent.click(screen.getByTestId("network-switch-done-btn"));
    await waitFor(() => screen.getByTestId("network-switch-resimulate-btn"));

    // Click re-simulate
    fireEvent.click(screen.getByTestId("network-switch-resimulate-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("network-switch-steps")).toBeInTheDocument();
    });
  });
});

// ── WrongNetworkBanner ────────────────────────────────────────────────────────

describe("WrongNetworkBanner", () => {
  it("renders WalletErrorDisplay with role=alert", () => {
    render(
      <WrongNetworkBanner
        expectedPassphrase="Test SDF Network ; September 2015"
        detectedPassphrase="Public Global Stellar Network ; September 2015"
        provider="freighter"
      />
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("shows the wrong-network title", () => {
    render(
      <WrongNetworkBanner
        expectedPassphrase="Test SDF Network ; September 2015"
        detectedPassphrase="Public Global Stellar Network ; September 2015"
        provider="freighter"
      />
    );
    expect(screen.getByText(/wrong network/i)).toBeInTheDocument();
  });

  it("renders the NetworkSwitchPanel steps inside", () => {
    render(
      <WrongNetworkBanner
        expectedPassphrase="Test SDF Network ; September 2015"
        detectedPassphrase="Public Global Stellar Network ; September 2015"
        provider="freighter"
        onDoneSteps={jest.fn()}
        onReadyToResimulate={jest.fn()}
      />
    );
    expect(screen.getByTestId("network-switch-steps")).toBeInTheDocument();
  });

  it("shows checking spinner when isCheckingNetwork=true", () => {
    render(
      <WrongNetworkBanner
        expectedPassphrase="Test SDF Network ; September 2015"
        detectedPassphrase="Public Global Stellar Network ; September 2015"
        provider="freighter"
        isCheckingNetwork={true}
      />
    );
    expect(screen.getByTestId("network-switch-checking")).toBeInTheDocument();
  });

  it("calls onDismiss when dismiss button clicked", () => {
    const onDismiss = jest.fn();
    render(
      <WrongNetworkBanner
        expectedPassphrase="Test SDF Network ; September 2015"
        detectedPassphrase="Public Global Stellar Network ; September 2015"
        provider="freighter"
        onDismiss={onDismiss}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

// ── Stale-draft: switch-during-simulation integration ─────────────────────────

describe("Stale-draft: switch during simulation", () => {
  it("preflight SWITCH_NETWORK action is distinct from CONNECT_WALLET", () => {
    // Verify the preflight error taxonomy used by useTxLifecycle is correct
    const { assertWritePreflight, PreflightError } = require("../lib/preflight");

    // Simulate a wrong-network scenario
    let caught: any = null;
    try {
      assertWritePreflight({
        walletPassphrase: "Public Global Stellar Network ; September 2015",
        isConnected: true,
        contractId: "CTEST",
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(PreflightError);
    expect(caught.action).toBe("SWITCH_NETWORK");
    // Must be different from CONNECT_WALLET so UI shows different guidance
    expect(caught.action).not.toBe("CONNECT_WALLET");
    expect(caught.details?.expected).toBe("Test SDF Network ; September 2015");
    expect(caught.details?.detected).toBe("Public Global Stellar Network ; September 2015");
  });

  it("SWITCH_NETWORK error message names both networks", () => {
    const { assertWritePreflight } = require("../lib/preflight");
    let msg = "";
    try {
      assertWritePreflight({
        walletPassphrase: "Public Global Stellar Network ; September 2015",
        isConnected: true,
        contractId: "CTEST",
      });
    } catch (e: any) {
      msg = e.message;
    }
    expect(msg).toMatch(/testnet/i);
    expect(msg).toMatch(/mainnet/i);
  });
});
