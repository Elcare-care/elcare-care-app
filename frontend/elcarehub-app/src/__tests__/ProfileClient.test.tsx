import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProfileClient from "@/app/profile/[address]/ProfileClient";
import { useWalletContext } from "@/context/WalletContext";
import { useMarketplace } from "@/hooks/useMarketplace";
import { useUserActivity } from "@/hooks/useUserActivity";
import { useCreatorCollections } from "@/hooks/useLaunchpad";

// Mock dependencies
jest.mock("@/context/WalletContext");
jest.mock("@/hooks/useMarketplace");
jest.mock("@/hooks/useUserActivity");
jest.mock("@/hooks/useLaunchpad");
jest.mock("@/components/WalletGuard", () => {
  return function DummyWalletGuard({ children }: { children: React.ReactNode }) {
    return <div>{children}</div>;
  };
});
jest.mock("@/components/ListingCard", () => {
  return function DummyListingCard({ listing }: { listing: any }) {
    return <div data-testid="listing-card">{listing.listing_id}</div>;
  };
});

const mockUseWalletContext = useWalletContext as jest.MockedFunction<typeof useWalletContext>;
const mockUseMarketplace = useMarketplace as jest.MockedFunction<typeof useMarketplace>;
const mockUseUserActivity = useUserActivity as jest.MockedFunction<typeof useUserActivity>;
const mockUseCreatorCollections = useCreatorCollections as jest.MockedFunction<
  typeof useCreatorCollections
>;

describe("ProfileClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const mockAddress = "GABC123";
  const mockListings = [
    { listing_id: "1", artist: "GABC123", owner: "GXYZ789", status: "Active", price: 1000000 },
    { listing_id: "2", artist: "GABC123", owner: "GXYZ789", status: "Sold", price: 2000000 },
  ];
  const mockCollections = [
    { address: "CCOL001", kind: "Normal721", supply: 100 },
    { address: "CCOL002", kind: "LazyMint1155", supply: 1000 },
  ];
  const mockRoyaltyStats = {
    totalEarned: "5000000",
    payoutCount: 3,
    lastPayout: "2026-06-20T00:00:00Z",
  };
  const mockActivities = [
    {
      type: "LISTED" as const,
      price: "1000000",
      timestamp: new Date().toISOString(),
    },
    {
      type: "SALE" as const,
      price: "2000000",
      timestamp: new Date().toISOString(),
    },
  ];

  describe("populated profile view", () => {
    beforeEach(() => {
      mockUseWalletContext.mockReturnValue({
        publicKey: mockAddress,
        isConnected: true,
        connect: jest.fn(),
        disconnect: jest.fn(),
      } as any);

      mockUseMarketplace.mockReturnValue({
        listings: mockListings,
        isLoading: false,
        error: null,
      } as any);

      mockUseUserActivity.mockReturnValue({
        activities: mockActivities,
        royaltyStats: mockRoyaltyStats,
        isLoading: false,
      } as any);

      mockUseCreatorCollections.mockReturnValue({
        collections: mockCollections,
        isLoading: false,
      } as any);
    });

    it("should render artist profile header with stats", async () => {
      render(<ProfileClient address={mockAddress} />);

      await waitFor(() => {
        expect(screen.getByText(/African/)).toBeInTheDocument();
        expect(screen.getByText("2")).toBeInTheDocument(); // Created count
        expect(screen.getByText("2")).toBeInTheDocument(); // Collections count
      });
    });

    it("should render portfolio tab with active listings", async () => {
      render(<ProfileClient address={mockAddress} />);

      await waitFor(() => {
        const listingsTab = screen.getByRole("button", { name: /Listings/i });
        expect(listingsTab).toBeInTheDocument();
      });

      const listingCards = screen.getAllByTestId("listing-card");
      expect(listingCards.length).toBeGreaterThan(0);
    });

    it("should render collections tab with collection cards", async () => {
      render(<ProfileClient address={mockAddress} />);

      const collectionsTab = await screen.findByRole("button", { name: /Collections/i });
      await userEvent.click(collectionsTab);

      await waitFor(() => {
        expect(screen.getByText("Normal721")).toBeInTheDocument();
        expect(screen.getByText("LazyMint1155")).toBeInTheDocument();
      });
    });

    it("should render earnings tab with royalty stats", async () => {
      render(<ProfileClient address={mockAddress} />);

      const earningsTab = await screen.findByRole("button", { name: /Earnings/i });
      await userEvent.click(earningsTab);

      await waitFor(() => {
        expect(screen.getByText("Total Royalties Earned")).toBeInTheDocument();
        expect(screen.getByText(/5000000/)).toBeInTheDocument();
        expect(screen.getByText("3")).toBeInTheDocument(); // payout count
      });
    });

    it("should render activity tab with transaction history", async () => {
      render(<ProfileClient address={mockAddress} />);

      const activityTab = await screen.findByRole("button", { name: /Activity/i });
      await userEvent.click(activityTab);

      await waitFor(() => {
        expect(screen.getByText("LISTED")).toBeInTheDocument();
        expect(screen.getByText("SALE")).toBeInTheDocument();
      });
    });

    it("should allow tab switching", async () => {
      render(<ProfileClient address={mockAddress} />);

      const soldTab = await screen.findByRole("button", { name: /Sold/i });
      await userEvent.click(soldTab);

      await waitFor(() => {
        expect(soldTab).toHaveClass("bg-brand-500");
      });
    });
  });

  describe("empty profile states", () => {
    beforeEach(() => {
      mockUseWalletContext.mockReturnValue({
        publicKey: mockAddress,
        isConnected: true,
      } as any);

      mockUseMarketplace.mockReturnValue({
        listings: [],
        isLoading: false,
      } as any);

      mockUseUserActivity.mockReturnValue({
        activities: [],
        royaltyStats: null,
        isLoading: false,
      } as any);

      mockUseCreatorCollections.mockReturnValue({
        collections: [],
        isLoading: false,
      } as any);
    });

    it("should render empty state for listings", async () => {
      render(<ProfileClient address={mockAddress} />);

      await waitFor(() => {
        expect(screen.getByText("No active listings")).toBeInTheDocument();
      });
    });

    it("should render empty state for collections", async () => {
      render(<ProfileClient address={mockAddress} />);

      const collectionsTab = await screen.findByRole("button", { name: /Collections/i });
      await userEvent.click(collectionsTab);

      await waitFor(() => {
        expect(screen.getByText("No collections")).toBeInTheDocument();
      });
    });

    it("should render empty state for earnings with no royalty payouts", async () => {
      render(<ProfileClient address={mockAddress} />);

      const earningsTab = await screen.findByRole("button", { name: /Earnings/i });
      await userEvent.click(earningsTab);

      await waitFor(() => {
        expect(screen.getByText("No royalty payouts yet")).toBeInTheDocument();
      });
    });

    it("should render empty state for activity", async () => {
      render(<ProfileClient address={mockAddress} />);

      const activityTab = await screen.findByRole("button", { name: /Activity/i });
      await userEvent.click(activityTab);

      await waitFor(() => {
        expect(screen.getByText("No activity yet")).toBeInTheDocument();
      });
    });
  });

  describe("loading states", () => {
    it("should show loading spinner while fetching data", async () => {
      mockUseWalletContext.mockReturnValue({
        publicKey: mockAddress,
        isConnected: true,
      } as any);

      mockUseMarketplace.mockReturnValue({
        listings: [],
        isLoading: true,
      } as any);

      mockUseUserActivity.mockReturnValue({
        activities: [],
        isLoading: true,
      } as any);

      mockUseCreatorCollections.mockReturnValue({
        collections: [],
        isLoading: true,
      } as any);

      render(<ProfileClient address={mockAddress} />);

      await waitFor(() => {
        expect(screen.getByText(/Loading gallery/)).toBeInTheDocument();
      });
    });
  });

  describe("visitor profile view (non-owner)", () => {
    it("should hide purchased tab when viewing other profiles", async () => {
      mockUseWalletContext.mockReturnValue({
        publicKey: "GOTHER456",
        isConnected: true,
      } as any);

      mockUseMarketplace.mockReturnValue({
        listings: mockListings,
        isLoading: false,
      } as any);

      mockUseUserActivity.mockReturnValue({
        activities: mockActivities,
        royaltyStats: mockRoyaltyStats,
        isLoading: false,
      } as any);

      mockUseCreatorCollections.mockReturnValue({
        collections: mockCollections,
        isLoading: false,
      } as any);

      render(<ProfileClient address={mockAddress} />);

      const purchasedTab = screen.queryByRole("button", { name: /Purchased/i });
      expect(purchasedTab).not.toBeInTheDocument();
    });
  });
});
