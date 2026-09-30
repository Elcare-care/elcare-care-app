/**
 * Component tests for CollectionForm wizard.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockDeploy = jest.fn();
const mockPushToast = jest.fn();
let mockPublicKey: string | null = "GPUBKEY";

jest.mock("@/context/WalletContext", () => ({
  useWalletContext: () => ({ publicKey: mockPublicKey }),
}));

jest.mock("@/hooks/useLaunchpad", () => ({
  useDeployCollection: () => ({
    deploy: mockDeploy,
    isDeploying: false,
    error: null,
  }),
}));

jest.mock("@/hooks/useSupportedTokens", () => ({
  useSupportedTokens: () => ({
    tokens: [{ address: "CTOKEN", code: "XLM", issuer: "", name: "Stellar Lumens", symbol: "XLM" }],
  }),
}));

jest.mock("@/lib/token-support", () => ({
  getDefaultSupportedToken: (tokens: { address: string }[]) => tokens[0],
}));

jest.mock("@/config/tokens", () => ({
  DEFAULT_TOKEN: { address: "CTOKEN" },
}));

jest.mock("@/lib/launchpad", () => ({}));

jest.mock("@/components/ToastProvider", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
}));

jest.mock("@/components/WalletGuard", () => ({
  GuardButton: ({
    children,
    onAction,
    disabled,
  }: {
    children: React.ReactNode;
    onAction?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onAction} disabled={disabled}>
      {children}
    </button>
  ),
}));

jest.mock("lucide-react", () =>
  Object.fromEntries(
    [
      "Loader2",
      "Rocket",
      "CheckCircle",
      "ArrowRight",
      "ArrowLeft",
      "Check",
      "AlertTriangle",
      "Info",
      "ExternalLink",
      "Save",
      "X",
    ].map((name) => [name, () => <span data-testid={`icon-${name}`} />])
  )
);

jest.mock("@stellar/stellar-sdk", () => ({
  StrKey: {
    isValidEd25519PublicKey: (addr: string) =>
      typeof addr === "string" && addr.startsWith("G") && addr.length === 56,
    decodeEd25519PublicKey: () => new Uint8Array(32),
  },
}));

jest.mock("@/lib/config", () => ({
  config: { network: "testnet", contractId: "CTEST" },
}));

import { CollectionForm } from "@/components/CollectionForm";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function advanceToStep(user: ReturnType<typeof userEvent.setup>, stepIndex: number) {
  for (let i = 0; i < stepIndex; i++) {
    const nextBtn = screen.getByRole("button", { name: /next/i });
    await user.click(nextBtn);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CollectionForm wizard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPublicKey = "GPUBKEY";
  });

  // ── Step 0: Kind Selection ─────────────────────────────────────────────────

  describe("Step 0 – Collection Kind", () => {
    it("renders kind selection cards on mount", () => {
      render(<CollectionForm />);
      expect(screen.getByText(/choose collection type/i)).toBeInTheDocument();
    });

    it("renders all four collection kind options", () => {
      render(<CollectionForm />);
      expect(screen.getByText("Standard 721")).toBeInTheDocument();
      expect(screen.getByText("Standard 1155")).toBeInTheDocument();
      expect(screen.getByText("Lazy 721")).toBeInTheDocument();
      expect(screen.getByText("Lazy 1155")).toBeInTheDocument();
    });

    it("Next button is enabled on step 0 (kind is pre-selected)", () => {
      render(<CollectionForm />);
      expect(screen.getByRole("button", { name: /next/i })).not.toBeDisabled();
    });

    it("changes selection when a different kind is clicked", async () => {
      const user = userEvent.setup();
      render(<CollectionForm />);
      const lazyRadio = screen.getByRole("radio", { name: /lazy 1155/i });
      await user.click(lazyRadio);
      expect(lazyRadio).toBeChecked();
    });
  });

  // ── Step 1: Metadata ───────────────────────────────────────────────────────

  describe("Step 1 – Details", () => {
    it("shows the name input after advancing from step 0", async () => {
      const user = userEvent.setup();
      render(<CollectionForm />);
      await advanceToStep(user, 1);
      expect(screen.getByPlaceholderText(/african legends/i)).toBeInTheDocument();
    });

    it("shows symbol and max supply inputs for 721 kind", async () => {
      const user = userEvent.setup();
      render(<CollectionForm />);
      await advanceToStep(user, 1);
      expect(screen.getByPlaceholderText(/AFRL/i)).toBeInTheDocument();
      expect(screen.getByText(/max supply/i)).toBeInTheDocument();
    });

    it("does not show symbol for 1155 kind", async () => {
      const user = userEvent.setup();
      render(<CollectionForm />);
      // Select 1155
      await user.click(screen.getByRole("radio", { name: /standard 1155/i }));
      await advanceToStep(user, 1);
      expect(screen.queryByPlaceholderText(/AFRL/i)).not.toBeInTheDocument();
    });

    it("Next button is disabled when name is empty", async () => {
      const user = userEvent.setup();
      render(<CollectionForm />);
      await advanceToStep(user, 1);
      expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
    });

    it("Next button is enabled after filling in name and symbol", async () => {
      const user = userEvent.setup();
      render(<CollectionForm />);
      await advanceToStep(user, 1);
      await user.type(screen.getByPlaceholderText(/african legends/i), "My Collection");
      await user.type(screen.getByPlaceholderText(/AFRL/i), "MC");
      expect(screen.getByRole("button", { name: /next/i })).not.toBeDisabled();
    });

    it("Back button returns to step 0", async () => {
      const user = userEvent.setup();
      render(<CollectionForm />);
      await advanceToStep(user, 1);
      await user.click(screen.getByRole("button", { name: /back/i }));
      expect(screen.getByText(/choose collection type/i)).toBeInTheDocument();
    });
  });

  // ── Step 2: Economics ──────────────────────────────────────────────────────

  describe("Step 2 – Economics", () => {
    async function goToStep2(user: ReturnType<typeof userEvent.setup>) {
      render(<CollectionForm />);
      await advanceToStep(user, 1);
      await user.type(screen.getByPlaceholderText(/african legends/i), "My Collection");
      await user.type(screen.getByPlaceholderText(/AFRL/i), "MC");
      await user.click(screen.getByRole("button", { name: /next/i }));
    }

    it("shows royalty BPS field", async () => {
      const user = userEvent.setup();
      await goToStep2(user);
      expect(screen.getByText(/royalty.*bps/i)).toBeInTheDocument();
    });

    it("shows fee payment token selector", async () => {
      const user = userEvent.setup();
      await goToStep2(user);
      expect(screen.getByRole("combobox")).toBeInTheDocument();
    });

    it("shows royalty receiver address field", async () => {
      const user = userEvent.setup();
      await goToStep2(user);
      expect(screen.getByText(/royalty receiver/i)).toBeInTheDocument();
    });

    it("Next button is enabled when tokens are available", async () => {
      const user = userEvent.setup();
      await goToStep2(user);
      expect(screen.getByRole("button", { name: /next/i })).not.toBeDisabled();
    });
  });

  // ── Step 3: Review & Deploy ────────────────────────────────────────────────

  describe("Step 3 – Review & Deploy", () => {
    async function goToStep3(user: ReturnType<typeof userEvent.setup>) {
      render(<CollectionForm />);
      await advanceToStep(user, 1);
      await user.type(screen.getByPlaceholderText(/african legends/i), "My Collection");
      await user.type(screen.getByPlaceholderText(/AFRL/i), "MC");
      await user.click(screen.getByRole("button", { name: /next/i }));
      await user.click(screen.getByRole("button", { name: /next/i }));
    }

    it("shows the review heading", async () => {
      const user = userEvent.setup();
      await goToStep3(user);
      expect(screen.getByText(/review.*deploy/i)).toBeInTheDocument();
    });

    it("displays collection type in review summary", async () => {
      const user = userEvent.setup();
      await goToStep3(user);
      expect(screen.getByText("Normal721")).toBeInTheDocument();
    });

    it("displays collection name in review summary", async () => {
      const user = userEvent.setup();
      await goToStep3(user);
      expect(screen.getByText("My Collection")).toBeInTheDocument();
    });

    it("renders the Deploy Collection button", async () => {
      const user = userEvent.setup();
      await goToStep3(user);
      expect(
        screen.getByRole("button", { name: /deploy collection/i })
      ).toBeInTheDocument();
    });

    it("calls deploy when Deploy Collection button is clicked", async () => {
      mockDeploy.mockResolvedValueOnce(null);
      const user = userEvent.setup();
      await goToStep3(user);
      await user.click(screen.getByRole("button", { name: /deploy collection/i }));
      await waitFor(() => expect(mockDeploy).toHaveBeenCalled());
    });

    it("shows success state with deployed address after successful deploy", async () => {
      mockDeploy.mockResolvedValueOnce("CDEPLOYED_ADDRESS_123");
      const user = userEvent.setup();
      await goToStep3(user);
      await user.click(screen.getByRole("button", { name: /deploy collection/i }));
      await waitFor(() =>
        expect(screen.getByText(/collection deployed/i)).toBeInTheDocument()
      );
      expect(screen.getByText("CDEPLOYED_ADDRESS_123")).toBeInTheDocument();
    });

    it("fires a success toast after successful deploy", async () => {
      mockDeploy.mockResolvedValueOnce("CDEPLOYED_ADDRESS_123");
      const user = userEvent.setup();
      await goToStep3(user);
      await user.click(screen.getByRole("button", { name: /deploy collection/i }));
      await waitFor(() =>
        expect(mockPushToast).toHaveBeenCalledWith(
          "Collection deployed successfully!",
          "success"
        )
      );
    });

    it("fires an error toast when deploy returns null", async () => {
      mockDeploy.mockResolvedValueOnce(null);
      const user = userEvent.setup();
      await goToStep3(user);
      await user.click(screen.getByRole("button", { name: /deploy collection/i }));
      await waitFor(() =>
        expect(mockPushToast).toHaveBeenCalledWith(
          expect.stringMatching(/failed/i),
          "error"
        )
      );
    });

    it("shows explorer link after successful deploy", async () => {
      mockDeploy.mockResolvedValueOnce("CDEPLOYED_ADDRESS_123");
      const user = userEvent.setup();
      await goToStep3(user);
      await user.click(screen.getByRole("button", { name: /deploy collection/i }));
      await waitFor(() =>
        expect(screen.getByText(/view on stellar explorer/i)).toBeInTheDocument()
      );
    });
  });

  // ── Validation error messages ──────────────────────────────────────────────

  describe("Step 1 — field-level validation errors", () => {
    it("shows 'Collection name is required' when Next is clicked with empty name", async () => {
      const user = userEvent.setup();
      render(<CollectionForm />);
      await user.click(screen.getByRole("button", { name: /next/i })); // step 0 → 1
      // Now on step 1 with no name entered
      await user.click(screen.getByRole("button", { name: /next/i }));
      expect(
        await screen.findByText(/collection name is required/i)
      ).toBeInTheDocument();
    });

    it("shows symbol error when symbol contains special characters", async () => {
      const user = userEvent.setup();
      render(<CollectionForm />);
      await user.click(screen.getByRole("button", { name: /next/i })); // step 0 → 1
      await user.type(screen.getByPlaceholderText(/african legends/i), "My NFT");
      const symbolInput = screen.getByPlaceholderText(/AFRL/i);
      await user.clear(symbolInput);
      await user.type(symbolInput, "MY!@#");
      await user.click(screen.getByRole("button", { name: /next/i }));
      expect(
        await screen.findByText(/uppercase letters or digits/i)
      ).toBeInTheDocument();
    });

    it("does not show errors when all step 1 fields are valid", async () => {
      const user = userEvent.setup();
      render(<CollectionForm />);
      await user.click(screen.getByRole("button", { name: /next/i })); // step 0 → 1
      await user.type(screen.getByPlaceholderText(/african legends/i), "My NFT");
      const symbolInput = screen.getByPlaceholderText(/AFRL/i);
      await user.clear(symbolInput);
      await user.type(symbolInput, "MYNFT");
      await user.click(screen.getByRole("button", { name: /next/i }));
      // Should advance to step 2 — no error messages shown
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByText(/economics/i)).toBeInTheDocument();
    });
  });

  describe("Step 2 — royaltyReceiver address validation", () => {
    async function goToStep2(user: ReturnType<typeof userEvent.setup>) {
      render(<CollectionForm />);
      await user.click(screen.getByRole("button", { name: /next/i }));
      await user.type(screen.getByPlaceholderText(/african legends/i), "My NFT");
      const symbolInput = screen.getByPlaceholderText(/AFRL/i);
      await user.clear(symbolInput);
      await user.type(symbolInput, "MYNFT");
      await user.click(screen.getByRole("button", { name: /next/i }));
    }

    it("shows address error when royaltyReceiver is not a valid Stellar address", async () => {
      const user = userEvent.setup();
      await goToStep2(user);
      const receiverInput = screen.getByPlaceholderText(/defaults to creator/i);
      await user.clear(receiverInput);
      await user.type(receiverInput, "not-a-stellar-address");
      await user.click(screen.getByRole("button", { name: /next/i }));
      expect(
        await screen.findByText(/valid stellar address/i)
      ).toBeInTheDocument();
    });

    it("allows empty royaltyReceiver (defaults to creator)", async () => {
      const user = userEvent.setup();
      await goToStep2(user);
      const receiverInput = screen.getByPlaceholderText(/defaults to creator/i);
      await user.clear(receiverInput);
      await user.click(screen.getByRole("button", { name: /next/i }));
      // Should advance to Review step without error
      expect(screen.queryByText(/valid stellar address/i)).not.toBeInTheDocument();
      expect(screen.getByText(/review.*deploy/i)).toBeInTheDocument();
    });
  });
});
