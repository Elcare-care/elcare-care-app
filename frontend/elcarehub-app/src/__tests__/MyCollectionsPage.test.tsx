import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MyCollectionsPage from "@/app/launchpad/my-collections/page";
import { useCreatorCollections } from "@/hooks/useLaunchpad";
import { useWalletContext } from "@/context/WalletContext";

// Mock dependencies
jest.mock("@/hooks/useLaunchpad");
jest.mock("@/context/WalletContext");
jest.mock("@/components/Navbar", () => {
  return function DummyNavbar() {
    return <div data-testid="navbar">Navbar</div>;
  };
});
jest.mock("next/link", () => {
  return function DummyLink({ children, href }: { children: React.ReactNode; href: string }) {
    return <a href={href}>{children}</a>;
  };
});

const mockUseCreatorCollections = useCreatorCollections as jest.MockedFunction<
  typeof useCreatorCollections
>;
const mockUseWalletContext = useWalletContext as jest.MockedFunction<typeof useWalletContext>;

describe("MyCollectionsPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const mockAddress = "GABC123";
  const mockCollections = [
    {
      address: "CCOL001",
      kind: "Normal721",
      supply: 100,
    },
    {
      address: "CCOL002",
      kind: "Normal1155",
      supply: 1000,
    },
    {
      address: "CCOL003",
      kind: "LazyMint721",
      supply: 500,
    },
  ];

  describe("wallet connection gating", () => {
    it("should render wallet connection prompt when not connected", async () => {
      mockUseWalletContext.mockReturnValue({
        publicKey: null,
        isConnected: false,
        connect: jest.fn(),
        disconnect: jest.fn(),
      } as any);

      mockUseCreatorCollections.mockReturnValue({
        collections: [],
        isLoading: false,
        error: null,
        refresh: jest.fn(),
      } as any);

      render(<MyCollectionsPage />);

      await waitFor(() => {
        expect(screen.getByText("My Collections")).toBeInTheDocument();
        expect(screen.getByText(/Connect your wallet/i)).toBeInTheDocument();
      });
    });

    it("should render collections page when wallet is connected", async () => {
      mockUseWalletContext.mockReturnValue({
        publicKey: mockAddress,
        isConnected: true,
      } as any);

      mockUseCreatorCollections.mockReturnValue({
        collections: mockCollections,
        isLoading: false,
        error: null,
        refresh: jest.fn(),
      } as any);

      render(<MyCollectionsPage />);

      await waitFor(() => {
        expect(screen.getByText("Your Created Collections")).toBeInTheDocument();
      });
    });
  });

  describe("collections list view", () => {
    beforeEach(() => {
      mockUseWalletContext.mockReturnValue({
        publicKey: mockAddress,
        isConnected: true,
      } as any);
    });

    it("should display all collections in a grid", async () => {
      mockUseCreatorCollections.mockReturnValue({
        collections: mockCollections,
        isLoading: false,
        error: null,
        refresh: jest.fn(),
      } as any);

      render(<MyCollectionsPage />);

      await waitFor(() => {
        expect(screen.getByText("3")).toBeInTheDocument(); // Total Collections stat
        expect(screen.getByText("Normal721")).toBeInTheDocument();
        expect(screen.getByText("Normal1155")).toBeInTheDocument();
        expect(screen.getByText("LazyMint721")).toBeInTheDocument();
      });
    });

    it("should display collection kind badge", async () => {
      mockUseCreatorCollections.mockReturnValue({
        collections: mockCollections,
        isLoading: false,
        error: null,
        refresh: jest.fn(),
      } as any);

      render(<MyCollectionsPage />);

      await waitFor(() => {
        const badges = screen.getAllByText(/Normal721|Normal1155|LazyMint721/);
        expect(badges.length).toBeGreaterThanOrEqual(3);
      });
    });

    it("should display collection stats", async () => {
      mockUseCreatorCollections.mockReturnValue({
        collections: mockCollections,
        isLoading: false,
        error: null,
        refresh: jest.fn(),
      } as any);

      render(<MyCollectionsPage />);

      await waitFor(() => {
        expect(screen.getByText("1")).toBeInTheDocument(); // ERC-721 count
        expect(screen.getByText("2")).toBeInTheDocument(); // Combined count
      });
    });

    it("should provide view details link for each collection", async () => {
      mockUseCreatorCollections.mockReturnValue({
        collections: mockCollections,
        isLoading: false,
        error: null,
        refresh: jest.fn(),
      } as any);

      render(<MyCollectionsPage />);

      const viewDetailsLinks = await screen.findAllByText("View Details");
      expect(viewDetailsLinks.length).toBe(mockCollections.length);
    });

    it("should truncate and display collection address", async () => {
      mockUseCreatorCollections.mockReturnValue({
        collections: mockCollections,
        isLoading: false,
        error: null,
        refresh: jest.fn(),
      } as any);

      render(<MyCollectionsPage />);

      await waitFor(() => {
        // Addresses are truncated: CCOL001 -> CCOL0...001
        expect(screen.getByText(/CCOL0.*001/)).toBeInTheDocument();
      });
    });
  });

  describe("empty state", () => {
    beforeEach(() => {
      mockUseWalletContext.mockReturnValue({
        publicKey: mockAddress,
        isConnected: true,
      } as any);
    });

    it("should render empty state when no collections exist", async () => {
      mockUseCreatorCollections.mockReturnValue({
        collections: [],
        isLoading: false,
        error: null,
        refresh: jest.fn(),
      } as any);

      render(<MyCollectionsPage />);

      await waitFor(() => {
        expect(screen.getByText("No Collections Yet")).toBeInTheDocument();
        expect(
          screen.getByText(
            /You haven't created any collections yet.*Start by creating your first NFT collection/i
          )
        ).toBeInTheDocument();
      });
    });

    it("should show create button in empty state", async () => {
      mockUseCreatorCollections.mockReturnValue({
        collections: [],
        isLoading: false,
        error: null,
        refresh: jest.fn(),
      } as any);

      render(<MyCollectionsPage />);

      await waitFor(() => {
        const createButtons = screen.getAllByText(/Create.*Collection/i);
        expect(createButtons.length).toBeGreaterThan(0);
      });
    });
  });

  describe("filtering and search", () => {
    beforeEach(() => {
      mockUseWalletContext.mockReturnValue({
        publicKey: mockAddress,
        isConnected: true,
      } as any);

      mockUseCreatorCollections.mockReturnValue({
        collections: mockCollections,
        isLoading: false,
        error: null,
        refresh: jest.fn(),
      } as any);
    });

    it("should filter collections by search term", async () => {
      render(<MyCollectionsPage />);

      await waitFor(() => {
        expect(screen.getByText("Normal721")).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText(/Search by collection address/i);
      await userEvent.type(searchInput, "CCOL001");

      await waitFor(() => {
        expect(screen.getByText("Normal721")).toBeInTheDocument();
        expect(screen.queryByText("Normal1155")).not.toBeInTheDocument();
      });
    });

    it("should filter collections by kind", async () => {
      render(<MyCollectionsPage />);

      await waitFor(() => {
        expect(screen.getByText("Normal721")).toBeInTheDocument();
      });

      const kindFilter = screen.getByDisplayValue("All Types");
      await userEvent.selectOptions(kindFilter, "Normal721");

      await waitFor(() => {
        expect(screen.getByText("Normal721")).toBeInTheDocument();
        expect(screen.queryByText("Normal1155")).not.toBeInTheDocument();
      });
    });

    it("should show no matching collections message when filter returns empty", async () => {
      render(<MyCollectionsPage />);

      const searchInput = screen.getByPlaceholderText(/Search by collection address/i);
      await userEvent.type(searchInput, "NONEXISTENT");

      await waitFor(() => {
        expect(screen.getByText("No Matching Collections")).toBeInTheDocument();
      });
    });
  });

  describe("loading and error states", () => {
    beforeEach(() => {
      mockUseWalletContext.mockReturnValue({
        publicKey: mockAddress,
        isConnected: true,
      } as any);
    });

    it("should show loading spinner while fetching collections", async () => {
      mockUseCreatorCollections.mockReturnValue({
        collections: [],
        isLoading: true,
        error: null,
        refresh: jest.fn(),
      } as any);

      render(<MyCollectionsPage />);

      await waitFor(() => {
        expect(screen.getByText(/Loading your collections/i)).toBeInTheDocument();
      });
    });

    it("should display error message when fetch fails", async () => {
      const errorMessage = "Failed to load collections";
      mockUseCreatorCollections.mockReturnValue({
        collections: [],
        isLoading: false,
        error: errorMessage,
        refresh: jest.fn(),
      } as any);

      render(<MyCollectionsPage />);

      await waitFor(() => {
        expect(screen.getByText(errorMessage)).toBeInTheDocument();
        expect(screen.getByText("Try Again")).toBeInTheDocument();
      });
    });

    it("should call refresh when try again is clicked", async () => {
      const mockRefresh = jest.fn();
      mockUseCreatorCollections.mockReturnValue({
        collections: [],
        isLoading: false,
        error: "Failed to load collections",
        refresh: mockRefresh,
      } as any);

      render(<MyCollectionsPage />);

      const tryAgainButton = await screen.findByText("Try Again");
      await userEvent.click(tryAgainButton);

      expect(mockRefresh).toHaveBeenCalled();
    });
  });

  describe("header and navigation", () => {
    beforeEach(() => {
      mockUseWalletContext.mockReturnValue({
        publicKey: mockAddress,
        isConnected: true,
      } as any);

      mockUseCreatorCollections.mockReturnValue({
        collections: mockCollections,
        isLoading: false,
        error: null,
        refresh: jest.fn(),
      } as any);
    });

    it("should render create new collection button in header", async () => {
      render(<MyCollectionsPage />);

      const createButtons = await screen.findAllByText(/Create New/);
      expect(createButtons.length).toBeGreaterThan(0);
    });

    it("should link create button to launchpad create page", async () => {
      render(<MyCollectionsPage />);

      const createButton = screen.getAllByText(/Create New/)[0].closest("a");
      expect(createButton).toHaveAttribute("href", "/launchpad/create");
    });
  });
});
