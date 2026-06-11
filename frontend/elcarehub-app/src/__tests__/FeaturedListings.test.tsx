/* eslint-disable @next/next/no-img-element */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock("next/image", () => ({
  __esModule: true,
  default: (
    props: React.ImgHTMLAttributes<HTMLImageElement> & {
      fill?: boolean;
      unoptimized?: boolean;
      priority?: boolean;
      quality?: number;
    }
  ) => {
    const {
      fill: _fill,
      unoptimized: _unoptimized,
      priority: _priority,
      quality: _quality,
      alt,
      ...rest
    } = props;
    return <img alt={alt || ""} {...rest} />;
  },
}));

const mockUseMarketplace = jest.fn();
jest.mock("@/hooks/useMarketplace", () => ({
  useMarketplace: () => mockUseMarketplace(),
}));

const mockFetchMetadata = jest.fn();
jest.mock("@/lib/ipfs", () => ({
  fetchMetadata: (...args: unknown[]) => mockFetchMetadata(...args),
  cidToGatewayUrl: (cid: string) => `https://ipfs.io/ipfs/${cid}`,
}));

import { FeaturedListings } from "@/components/FeaturedListings";
import type { Listing } from "@/lib/contract";

function makeListing(overrides: Partial<Listing> = {}): Listing {
  return {
    listing_id: 1,
    artist: "GARTIST123",
    metadata_cid: "QmTestCid",
    collection: "CCOLLECTION",
    token_id: 1,
    price: 10_000_000n,
    currency: "XLM",
    token: "CTOKEN",
    recipients: [{ address: "GARTIST123", percentage: 100 }],
    status: "Active",
    owner: null,
    created_at: 1000,
    ...overrides,
  };
}

describe("FeaturedListings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchMetadata.mockResolvedValue({
      title: "Live Artwork",
      artist: "Featured Artist",
      image: "QmImageCid",
    });
  });

  it("shows a clear empty state instead of synthetic artwork cards", () => {
    mockUseMarketplace.mockReturnValue({
      listings: [],
      isLoading: false,
      error: null,
      refresh: jest.fn(),
    });

    render(<FeaturedListings />);

    expect(screen.getByText("No live featured listings yet")).toBeInTheDocument();
    expect(screen.queryByText("Ndebele Geometry")).not.toBeInTheDocument();
    expect(screen.queryByText("Maasai Beadwork Essence")).not.toBeInTheDocument();
  });

  it("keeps navigation disabled when fewer than three live listings are available", async () => {
    mockUseMarketplace.mockReturnValue({
      listings: [
        makeListing({ listing_id: 1, metadata_cid: "QmOne" }),
        makeListing({ listing_id: 2, metadata_cid: "QmTwo", price: 20_000_000n }),
      ],
      isLoading: false,
      error: null,
      refresh: jest.fn(),
    });

    mockFetchMetadata
      .mockResolvedValueOnce({
        title: "Sankofa I",
        artist: "Artist One",
        image: "QmImageOne",
      })
      .mockResolvedValueOnce({
        title: "Sankofa II",
        artist: "Artist Two",
        image: "QmImageTwo",
      });

    render(<FeaturedListings />);

    await waitFor(() => {
      expect(screen.getAllByText("Sankofa I").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Sankofa II").length).toBeGreaterThan(0);
    });

    expect(screen.getByLabelText("Previous featured artworks")).toBeDisabled();
    expect(screen.getByLabelText("Next featured artworks")).toBeDisabled();

    const listingLinks = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("href")?.startsWith("/listings/"));
    const uniqueListingLinks = new Set(
      listingLinks.map((link) => link.getAttribute("href"))
    );
    expect(uniqueListingLinks).toEqual(new Set(["/listings/1", "/listings/2"]));
  });
});
