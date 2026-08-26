/**
 * ListingWizard — step navigation and failed-submission tests (Issue #526).
 *
 * Covers:
 *   - Back navigation preserves already-entered state
 *   - A failed submission surfaces the typed error and leaves every earlier
 *     step's data intact so the creator can go back and retry
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── Mocks ─────────────────────────────────────────────────────────────────────
//
// jest.mock() factories are hoisted above this file's other top-level
// statements, so they must not close over module-scope `const`s declared
// later in the file (those wouldn't be initialized yet) — every value below
// is inlined as a literal. The equivalent named fixtures used by the actual
// test bodies are declared further down, after all the mocks.

const mockCreate = jest.fn();

jest.mock("@/hooks/useMarketplace", () => ({
  useCreateListing: (_pk: string | null) => ({
    create: mockCreate,
    isCreating: false,
    error: null,
  }),
}));

jest.mock("@/context/WalletContext", () => ({
  useWalletContext: () => ({ publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN" }),
}));

jest.mock("@/hooks/useSupportedTokens", () => ({
  useSupportedTokens: () => ({
    tokens: [
      {
        address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        symbol: "XLM",
        name: "Stellar Lumens",
        decimals: 7,
      },
    ],
  }),
}));

jest.mock("@/lib/token-support", () => ({
  getDefaultSupportedToken: (tokens: { address: string }[]) => tokens[0],
}));

jest.mock("@/config/tokens", () => ({
  DEFAULT_TOKEN: { address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC" },
}));

jest.mock("@/lib/config", () => ({
  config: { contractId: "CMARKETPLACECONTRACTID", network: "testnet" },
}));

jest.mock("@/lib/indexer", () => ({
  getCollections: jest.fn().mockResolvedValue({
    collections: [
      {
        id: 1,
        contractAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        kind: "normal_721",
        creator: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
        name: "Test Collection",
        symbol: "TC",
        deployedAtLedger: 100,
      },
    ],
    total: 1,
  }),
}));

jest.mock("@/lib/contract", () => ({
  getNftOwner: jest.fn().mockResolvedValue("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN"),
  getNftBalance: jest.fn().mockResolvedValue(0n),
  isApprovedForAll: jest.fn().mockResolvedValue(true),
  checkAndApproveMarketplace: jest.fn().mockResolvedValue(true),
  getProtocolFee: jest.fn().mockResolvedValue(0),
}));

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: { capture: jest.fn() },
}));

jest.mock("@/components/WalletGuard", () => ({
  GuardButton: ({
    children,
    onAction,
    disabled,
    type,
  }: {
    children: React.ReactNode;
    onAction?: (e: React.MouseEvent) => void;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
  }) => (
    <button type={type ?? "button"} onClick={onAction as any} disabled={disabled}>
      {children}
    </button>
  ),
}));

jest.mock("@/components/TxErrorPanel", () => ({
  TxErrorPanel: ({ error }: { error: { message: string } }) => (
    <div data-testid="tx-error-panel">{error.message}</div>
  ),
}));

import { ListingWizard } from "@/components/ListingWizard";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function selectCollectionAndAdvanceToOwnership(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(screen.getByText("Test Collection")).toBeInTheDocument());
  await user.click(screen.getByText("Test Collection"));
  await user.click(screen.getByRole("button", { name: /^next$/i }));
}

async function advanceThroughOwnership(user: ReturnType<typeof userEvent.setup>) {
  const tokenIdInput = screen.getByRole("spinbutton");
  await user.type(tokenIdInput, "1");
  await waitFor(() => expect(screen.getByText(/you own this token/i)).toBeInTheDocument());
  await waitFor(() =>
    expect(screen.getByText(/marketplace is approved/i)).toBeInTheDocument()
  );
  await user.click(screen.getByRole("button", { name: /^next$/i }));
}

async function fillPriceAndAdvance(user: ReturnType<typeof userEvent.setup>, price: string) {
  const priceInput = screen.getByPlaceholderText("0.00");
  await user.clear(priceInput);
  await user.type(priceInput, price);
  await user.click(screen.getByRole("button", { name: /^next$/i }));
}

async function reachReviewStep(user: ReturnType<typeof userEvent.setup>, price = "10") {
  await selectCollectionAndAdvanceToOwnership(user);
  await advanceThroughOwnership(user);
  await fillPriceAndAdvance(user, price);
  // Royalties step: default recipient is 100% to the connected wallet already.
  await user.click(screen.getByRole("button", { name: /^next$/i }));
  // Expiry step: "No expiry" is selected by default.
  await user.click(screen.getByRole("button", { name: /^next$/i }));
  await waitFor(() => expect(screen.getByText(/review & sign/i)).toBeInTheDocument());
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ListingWizard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate.mockReset();
  });

  it("renders the collection step on mount", async () => {
    render(<ListingWizard />);
    expect(screen.getByText(/choose a collection/i)).toBeInTheDocument();
  });

  describe("back navigation", () => {
    it("returns to the collection step and preserves the selected collection", async () => {
      const user = userEvent.setup();
      render(<ListingWizard />);

      await waitFor(() => expect(screen.getByText("Test Collection")).toBeInTheDocument());
      await user.click(screen.getByText("Test Collection"));
      await user.click(screen.getByRole("button", { name: /^next$/i }));

      // Now on the Ownership step.
      expect(screen.getByText(/verify ownership/i)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /^back$/i }));

      // Back on the Collection step, with the same collection still selected.
      expect(screen.getByText(/choose a collection/i)).toBeInTheDocument();
      const selectedCard = screen.getByText("Test Collection").closest("button");
      expect(selectedCard).toHaveClass("border-brand-500");
    });

    it("preserves the entered price when navigating back from Royalties to Pricing", async () => {
      const user = userEvent.setup();
      render(<ListingWizard />);

      await selectCollectionAndAdvanceToOwnership(user);
      await advanceThroughOwnership(user);
      await fillPriceAndAdvance(user, "42.5");

      // Now on the Royalties step — go back.
      expect(screen.getByText(/revenue split/i)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /^back$/i }));

      expect(screen.getByText(/set your price/i)).toBeInTheDocument();
      expect(screen.getByPlaceholderText("0.00")).toHaveValue("42.5");
    });
  });

  describe("failed submission", () => {
    it("shows the typed error and preserves editable draft state for retry", async () => {
      mockCreate.mockRejectedValue(new Error("insufficient funds to cover this listing"));

      const user = userEvent.setup();
      render(<ListingWizard />);

      await reachReviewStep(user, "10");

      await user.click(screen.getByRole("button", { name: /sign & create listing/i }));

      await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.getByTestId("tx-error-panel")).toBeInTheDocument()
      );

      // Still on the Review step, not the success screen.
      expect(screen.getByText(/review & sign/i)).toBeInTheDocument();
      expect(screen.queryByText(/listing #.*created/i)).not.toBeInTheDocument();

      // Navigate all the way back to Pricing — the price entered before
      // submission must still be there for the creator to edit and retry.
      await user.click(screen.getByRole("button", { name: /^back$/i })); // Review -> Expiry
      await user.click(screen.getByRole("button", { name: /^back$/i })); // Expiry -> Royalties
      await user.click(screen.getByRole("button", { name: /^back$/i })); // Royalties -> Pricing

      expect(screen.getByText(/set your price/i)).toBeInTheDocument();
      expect(screen.getByPlaceholderText("0.00")).toHaveValue("10");
    });
  });
});
