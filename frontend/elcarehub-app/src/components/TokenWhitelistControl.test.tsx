/**
 * TokenWhitelistControl.test.tsx — minimal test coverage
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import TokenWhitelistControl from "./TokenWhitelistControl";

describe("TokenWhitelistControl", () => {
  const defaultProps = {
    marketplaceContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    network: "testnet" as const,
  };

  it("renders form with action selection", () => {
    render(<TokenWhitelistControl {...defaultProps} />);
    expect(screen.getByText("Token Whitelist Management")).toBeInTheDocument();
    expect(screen.getByLabelText("Add token")).toBeInTheDocument();
    expect(screen.getByLabelText("Remove token")).toBeInTheDocument();
  });

  it("validates Stellar contract address format", async () => {
    render(<TokenWhitelistControl {...defaultProps} />);

    const addressInput = screen.getByPlaceholderText(
      /CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX/
    );
    const symbolInput = screen.getByPlaceholderText("USDC");

    // Invalid address
    fireEvent.change(addressInput, { target: { value: "INVALID" } });
    fireEvent.change(symbolInput, { target: { value: "USDC" } });

    await waitFor(() => {
      expect(screen.getByText(/Invalid address format/)).toBeInTheDocument();
    });

    // Valid address
    fireEvent.change(addressInput, {
      target: {
        value: "CUSDC7YNEZKVQXT5U5XCJZKTQcd4V3CX6AIUJJGPXEUEA2JREOFCQN7",
      },
    });

    await waitFor(() => {
      expect(screen.queryByText(/Invalid address format/)).not.toBeInTheDocument();
    });
  });

  it("requires all verification checklist items before submit", async () => {
    render(<TokenWhitelistControl {...defaultProps} />);

    const submitButton = screen.getByRole("button", {
      name: /Add Token/,
    });

    // Initially disabled
    expect(submitButton).toBeDisabled();

    // Check all items
    const checkboxes = screen.getAllByRole("checkbox");
    checkboxes.forEach((checkbox) => {
      fireEvent.click(checkbox);
    });

    // Now enabled
    await waitFor(() => {
      expect(submitButton).not.toBeDisabled();
    });
  });

  it("warns on non-standard decimals", async () => {
    render(<TokenWhitelistControl {...defaultProps} />);

    const decimalsInput = screen.getByDisplayValue("7");
    fireEvent.change(decimalsInput, { target: { value: "6" } });

    await waitFor(() => {
      expect(
        screen.getByText(/Non-standard decimals require engineering sign-off/)
      ).toBeInTheDocument();
    });
  });

  it("calls onTokenAdded callback on successful add", async () => {
    const onTokenAdded = jest.fn();
    render(
      <TokenWhitelistControl
        {...defaultProps}
        onTokenAdded={onTokenAdded}
      />
    );

    // Fill form
    const addressInput = screen.getByPlaceholderText(
      /CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX/
    );
    const symbolInput = screen.getByPlaceholderText("USDC");

    fireEvent.change(addressInput, {
      target: {
        value: "CUSDC7YNEZKVQXT5U5XCJZKTQCD4V3CX6AIUJJGPXEUEA2JREOFCQN7",
      },
    });
    fireEvent.change(symbolInput, { target: { value: "USDC" } });

    // Check all verification items
    const checkboxes = screen.getAllByRole("checkbox");
    checkboxes.forEach((checkbox) => {
      fireEvent.click(checkbox);
    });

    // Mock fetch
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            txHash: "0x123abc",
          }),
      })
    ) as jest.Mock;

    // Submit
    const submitButton = screen.getByRole("button", { name: /Add Token/ });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(onTokenAdded).toHaveBeenCalledWith(
        "CUSDC7YNEZKVQXT5U5XCJZKTQCD4V3CX6AIUJJGPXEUEA2JREOFCQN7"
      );
    });
  });

  it("displays error on API failure", async () => {
    render(<TokenWhitelistControl {...defaultProps} />);

    // Fill form
    const addressInput = screen.getByPlaceholderText(
      /CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX/
    );
    const symbolInput = screen.getByPlaceholderText("USDC");

    fireEvent.change(addressInput, {
      target: {
        value: "CUSDC7YNEZKVQXT5U5XCJZKTQCD4V3CX6AIUJJGPXEUEA2JREOFCQN7",
      },
    });
    fireEvent.change(symbolInput, { target: { value: "USDC" } });

    // Check all verification items
    const checkboxes = screen.getAllByRole("checkbox");
    checkboxes.forEach((checkbox) => {
      fireEvent.click(checkbox);
    });

    // Mock fetch failure
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        json: () =>
          Promise.resolve({
            message: "Token already whitelisted",
          }),
      })
    ) as jest.Mock;

    // Submit
    const submitButton = screen.getByRole("button", { name: /Add Token/ });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(
        screen.getByText(/Token already whitelisted/)
      ).toBeInTheDocument();
    });
  });

  it("toggles between add and remove actions", () => {
    render(<TokenWhitelistControl {...defaultProps} />);

    const removeRadio = screen.getByLabelText("Remove token");
    fireEvent.click(removeRadio);

    const submitButton = screen.getByRole("button", { name: /Remove Token/ });
    expect(submitButton).toBeInTheDocument();
  });
});
