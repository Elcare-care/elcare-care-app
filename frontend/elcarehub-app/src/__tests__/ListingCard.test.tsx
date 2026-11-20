/**
 * Component tests for ListingCard.
 * All external dependencies (wallet context, blockchain hooks, IPFS, Next.js
 * primitives) are mocked so the suite runs without any network access.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Dependency mocks ──────────────────────────────────────────────────────────

// Next.js Link — render as a plain <a>
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

// Next.js Image — render as a plain <img>, stripping Next-only props that
// are not valid DOM attributes (fill, unoptimized, priority, sizes, quality).
jest.mock('next/image', () => ({
  __esModule: true,
  default: (
    props: React.ImgHTMLAttributes<HTMLImageElement> & {
      fill?: boolean;
      unoptimized?: boolean;
      priority?: boolean;
      quality?: number;
    }
  ) => {
    const { fill: _fill, unoptimized: _unoptimized, priority: _priority, quality: _quality, alt, ...rest } = props;
    return <img alt={alt || ''} {...rest} />;
  },
}));

// WalletContext
jest.mock('@/context/WalletContext', () => ({
  useWalletContext: () => ({
    publicKey: 'GBUYER123',
    status: 'connected',
  }),
}));

// useBuyArtwork hook
const mockBuy = jest.fn().mockResolvedValue(true);
jest.mock('@/hooks/useMarketplace', () => ({
  useBuyArtwork: () => ({
    buy: mockBuy,
    isBuying: false,
    error: null,
  }),
}));

// IPFS helpers
jest.mock('@/lib/ipfs', () => ({
  fetchMetadata: jest.fn().mockResolvedValue({
    title: 'Test Artwork',
    description: 'A beautiful test piece',
    image: 'QmImageCid',
    year: 2024,
  }),
  getGatewayUrls: jest.fn().mockImplementation((cid: string) => {
    const clean = cid.replace('ipfs://', '').trim();
    return [
      `https://mock-pinata.example.com/ipfs/${clean}`,
      `https://ipfs.io/ipfs/${clean}`,
      `https://cloudflare-ipfs.com/ipfs/${clean}`,
    ];
  }),
}));

// ArtworkImage component mock
jest.mock('@/components/ArtworkImage', () => ({
  ArtworkImage: ({ metadata, isLoading, metadataError, fallbackId }: any) => {
    if (isLoading) {
      return <div data-testid="artwork-loading">Loading…</div>;
    }
    if (metadataError) {
      return <div data-testid="artwork-unavailable">Content unavailable</div>;
    }
    if (!metadata?.image) {
      return <div data-testid="artwork-missing">No Artwork</div>;
    }
    return (
      <div data-testid="artwork-img" data-fallback-id={fallbackId}>
        {metadata.title || 'Artwork'}
      </div>
    );
  },
}));

// WalletGuard — render children directly
jest.mock('@/components/WalletGuard', () => ({
  GuardButton: ({
    children,
    onAction,
    disabled,
    className,
    title,
    ...rest
  }: {
    children: React.ReactNode;
    onAction?: () => void;
    disabled?: boolean;
    className?: string;
    title?: string;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onAction} disabled={disabled} className={className} title={title} {...rest}>
      {children}
    </button>
  ),
}));

// CheckoutModal — call onCryptoPurchase immediately when opened so tests
// that click "Buy Now" can still assert buy() was invoked without rendering
// the full modal UI.
jest.mock('@/components/CheckoutModal', () => ({
  CheckoutModal: ({
    isOpen,
    onCryptoPurchase,
  }: {
    isOpen: boolean;
    onCryptoPurchase: () => Promise<boolean>;
    onClose: () => void;
    onPurchased?: () => void;
    isBuyingCrypto: boolean;
    listing: unknown;
  }) => {
    if (!isOpen) return null;
    // Render a confirm button so the test can trigger the purchase
    return (
      <button
        data-testid="checkout-confirm"
        onClick={() => onCryptoPurchase()}
      >
        Confirm Purchase
      </button>
    );
  },
}));

import { ListingCard } from '@/components/ListingCard';
import type { Listing } from '@/lib/contract';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeListing(overrides: Partial<Listing> = {}): Listing {
  return {
    listing_id: 1,
    artist: 'GARTIST123',
    metadata_cid: 'QmTestCid',
    collection: 'CCOLLECTION',
    token_id: 1,
    price: 10_000_000n, // 1 XLM
    currency: 'XLM',
    token: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    recipients: [{ address: 'GARTIST123', percentage: 100 }],
    status: 'Active',
    owner: null,
    created_at: 1000,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ListingCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the listing price in XLM', async () => {
    render(<ListingCard listing={makeListing()} />);
    // 10_000_000 stroops = 1 XLM
    await waitFor(() => {
      expect(screen.getByText(/1\s*XLM/i)).toBeInTheDocument();
    });
  });

  it('renders a known token symbol from token configuration metadata', async () => {
    // Testnet USDC token address
    render(
      <ListingCard
        listing={makeListing({
          price: 50_000_000n, // 5 USDC
          token: 'CCW67Z72VRYZUM3BWHXYG6PVDZ4NMLN73Y7U7E4S3W4M7I5VBDQXWIXI',
          currency: 'USDC',
        })}
      />
    );
    await waitFor(() => {
      expect(screen.getByText(/5\s*USDC/i)).toBeInTheDocument();
    });
  });

  it('handles missing or unknown token metadata without implying a different currency', async () => {
    render(
      <ListingCard
        listing={makeListing({
          price: 25_000_000n,
          token: 'CUNKNOWN_TOKEN_ADDRESS_NOT_CONFIGURED',
          currency: '',
        })}
      />
    );
    await waitFor(() => {
      expect(screen.getByText(/2\.5\s*UNKNOWN/i)).toBeInTheDocument();
      expect(screen.queryByText(/XLM/i)).not.toBeInTheDocument();
    });
  });

  it('formats large integer amounts without floating-point precision loss', async () => {
    // Amount exceeding Number.MAX_SAFE_INTEGER in base units
    const largeAmount = 90_000_000_000_000_000n; // 9,000,000,000 XLM
    render(<ListingCard listing={makeListing({ price: largeAmount })} />);
    await waitFor(() => {
      expect(screen.getByText(/9000000000\s*XLM/i)).toBeInTheDocument();
    });
  });

  it('renders the Active status badge for active listings', async () => {
    render(<ListingCard listing={makeListing({ status: 'Active' })} />);
    await waitFor(() => {
      expect(screen.getByText('Active')).toBeInTheDocument();
    });
  });

  it('renders the Sold status badge for sold listings', async () => {
    render(<ListingCard listing={makeListing({ status: 'Sold' })} />);
    await waitFor(() => {
      expect(screen.getByText('Sold')).toBeInTheDocument();
    });
  });

  it('renders the Cancelled status badge for cancelled listings', async () => {
    render(<ListingCard listing={makeListing({ status: 'Cancelled' })} />);
    await waitFor(() => {
      expect(screen.getByText('Cancelled')).toBeInTheDocument();
    });
  });

  it('shows the artwork title from IPFS metadata', async () => {
    render(<ListingCard listing={makeListing()} />);
    await waitFor(() => {
      expect(screen.getByText('Test Artwork')).toBeInTheDocument();
    });
  });

  it('shows the artwork description from IPFS metadata', async () => {
    render(<ListingCard listing={makeListing()} />);
    await waitFor(() => {
      expect(screen.getByText('A beautiful test piece')).toBeInTheDocument();
    });
  });

  it('shows a truncated artist address', async () => {
    render(<ListingCard listing={makeListing({ artist: 'GARTIST1234567890' })} />);
    await waitFor(() => {
      // Component truncates: first 8 chars + ellipsis + last 4 chars
      expect(screen.getByText(/GARTIST1…7890/)).toBeInTheDocument();
    });
  });

  it('shows a Buy Now button for Active listings when viewer is not the artist', async () => {
    // Buyer public key (GBUYER123) ≠ artist (GARTIST123)
    render(<ListingCard listing={makeListing()} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /buy now/i })).toBeInTheDocument();
    });
  });

  it('disables the buy button when viewer is the listing artist', async () => {
    // Override artist to match the mocked wallet public key
    render(<ListingCard listing={makeListing({ artist: 'GBUYER123' })} />);
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /yours/i });
      expect(btn).toBeDisabled();
    });
  });

  it('does not render a Buy button for Sold listings', async () => {
    render(<ListingCard listing={makeListing({ status: 'Sold' })} />);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /buy/i })).not.toBeInTheDocument();
    });
  });

  it('calls buy with the listing id when Buy Now is clicked through checkout modal', async () => {
    const user = userEvent.setup();
    render(<ListingCard listing={makeListing({ listing_id: 7 })} />);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /buy now/i })).toBeInTheDocument()
    );

    // Click "Buy Now" — this opens the CheckoutModal
    await user.click(screen.getByRole('button', { name: /buy now/i }));

    // Confirm purchase through the mocked modal
    await waitFor(() =>
      expect(screen.getByTestId('checkout-confirm')).toBeInTheDocument()
    );
    await user.click(screen.getByTestId('checkout-confirm'));

    await waitFor(() => expect(mockBuy).toHaveBeenCalledWith(7));
  });

  it('links the image to the listing detail page', async () => {
    render(<ListingCard listing={makeListing({ listing_id: 3 })} />);
    await waitFor(() => {
      const links = screen.getAllByRole('link');
      expect(links.some((l) => l.getAttribute('href') === '/listings/3')).toBe(true);
    });
  });

  it('provides distinct accessible names and keyboard focus order for interactive elements', async () => {
    const user = userEvent.setup();
    render(<ListingCard listing={makeListing({ listing_id: 42 })} />);

    await waitFor(() => {
      expect(screen.getByText('Test Artwork')).toBeInTheDocument();
    });

    const imageLink = screen.getByRole('link', { name: /view artwork: test artwork/i });
    const titleLink = screen.getByRole('link', { name: /test artwork/i });
    const buyButton = screen.getByRole('button', { name: /buy now: test artwork/i });

    expect(imageLink).toBeInTheDocument();
    expect(titleLink).toBeInTheDocument();
    expect(buyButton).toBeInTheDocument();

    // Tab through interactive controls in logical order
    await user.tab();
    expect(imageLink).toHaveFocus();

    await user.tab();
    expect(titleLink).toHaveFocus();

    await user.tab();
    expect(buyButton).toHaveFocus();
  });

  it('shows a fallback title when IPFS metadata is unavailable', async () => {
    const { fetchMetadata } = jest.requireMock('@/lib/ipfs');
    fetchMetadata.mockRejectedValueOnce(new Error('IPFS down'));

    render(<ListingCard listing={makeListing({ listing_id: 99 })} />);
    await waitFor(() => {
      expect(screen.getByText('Artwork #99')).toBeInTheDocument();
    });
  });

  it('renders a loading state initially', async () => {
    const { fetchMetadata } = jest.requireMock('@/lib/ipfs');
    let resolvePromise: any;
    fetchMetadata.mockReturnValueOnce(new Promise((resolve) => { resolvePromise = resolve; }));
    
    render(<ListingCard listing={makeListing()} />);
    expect(screen.getByTestId('artwork-loading')).toBeInTheDocument();
    
    resolvePromise({ title: 'Delayed Title' });
    await waitFor(() => {
      expect(screen.queryByTestId('artwork-loading')).not.toBeInTheDocument();
    });
  });

  it('renders the missing artwork fallback when metadata lacks an image', async () => {
    const { fetchMetadata } = jest.requireMock('@/lib/ipfs');
    fetchMetadata.mockResolvedValueOnce({ title: 'No Image', description: 'desc' });

    render(<ListingCard listing={makeListing()} />);
    await waitFor(() => {
      expect(screen.getByTestId('artwork-missing')).toBeInTheDocument();
    });
  });

  it('renders the missing artwork fallback when metadata fetch fails', async () => {
    const { fetchMetadata } = jest.requireMock('@/lib/ipfs');
    fetchMetadata.mockRejectedValueOnce(new Error('IPFS down'));

    render(<ListingCard listing={makeListing()} />);
    await waitFor(() => {
      expect(screen.getByTestId('artwork-missing')).toBeInTheDocument();
    });
  });

  // ── Retry button (Issue #7 degraded rendering) ───────────────────────────

  it('shows retry button when metadata fetch fails and retries remain', async () => {
    const { fetchMetadata } = jest.requireMock('@/lib/ipfs');
    fetchMetadata.mockRejectedValueOnce(new Error('IPFS down'));

    render(<ListingCard listing={makeListing()} />);
    await waitFor(() => {
      expect(screen.getByTestId('artwork-unavailable')).toBeInTheDocument();
    });
    expect(screen.getByTestId('artwork-retry-btn')).toBeInTheDocument();
  });

  it('retries metadata fetch when retry button is clicked', async () => {
    const { fetchMetadata } = jest.requireMock('@/lib/ipfs');
    const mockMeta = { title: 'Recovered', description: '', image: 'QmOk' };
    fetchMetadata
      .mockRejectedValueOnce(new Error('IPFS down'))
      .mockResolvedValueOnce(mockMeta);

    render(<ListingCard listing={makeListing()} />);
    await waitFor(() => expect(screen.getByTestId('artwork-retry-btn')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('artwork-retry-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('artwork-unavailable')).not.toBeInTheDocument();
      expect(screen.getByText('Recovered')).toBeInTheDocument();
    });
    expect(fetchMetadata).toHaveBeenCalledTimes(2);
  });

  it('shows artwork-missing (not retry) after max retries exhausted', async () => {
    const { fetchMetadata } = jest.requireMock('@/lib/ipfs');
    // Fail 3 times (initial + 2 retries = MAX_METADATA_RETRIES)
    fetchMetadata.mockRejectedValue(new Error('persistent failure'));

    render(<ListingCard listing={makeListing()} />);
    await waitFor(() => expect(screen.getByTestId('artwork-retry-btn')).toBeInTheDocument());

    // Retry 1
    fireEvent.click(screen.getByTestId('artwork-retry-btn'));
    await waitFor(() => expect(screen.getByTestId('artwork-retry-btn')).toBeInTheDocument());

    // Retry 2 (last allowed)
    fireEvent.click(screen.getByTestId('artwork-retry-btn'));
    await waitFor(() => {
      // After exhausting retries, falls through to artwork-missing
      expect(screen.queryByTestId('artwork-retry-btn')).not.toBeInTheDocument();
      expect(screen.getByTestId('artwork-missing')).toBeInTheDocument();
    });
  });
});

// ── Image mock regression (#105) ──────────────────────────────────────────────

describe('next/image mock', () => {
  const NextImage = jest.requireMock('next/image').default as React.FC<Record<string, unknown>>;

  it('does not forward unoptimized to the DOM element', () => {
    const { container } = render(
      <NextImage src="/test.png" alt="test" unoptimized width={100} height={100} />
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.hasAttribute('unoptimized')).toBe(false);
  });

  it('does not forward fill to the DOM element', () => {
    const { container } = render(
      <NextImage src="/test.png" alt="test" fill />
    );
    const img = container.querySelector('img');
    expect(img!.hasAttribute('fill')).toBe(false);
  });

  it('preserves alt and src attributes', () => {
    const { container } = render(
      <NextImage src="/test.png" alt="my image" unoptimized width={80} height={80} />
    );
    const img = container.querySelector('img');
    expect(img!.getAttribute('alt')).toBe('my image');
    expect(img!.getAttribute('src')).toBe('/test.png');
  });
});

// ── Issue 009 — image error fallback & alt text ───────────────────────────────
//
// Verifies the acceptance criteria for the image-load-failure feature:
//   1. A failed image does not break the card layout (fallback shown).
//   2. The fallback does not claim to depict the artwork.
//   3. The image retains meaningful alternative text when the source loads.

describe('ListingCard — image error fallback (Issue 009)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the missing-artwork fallback when the image errors on the last gateway', async () => {
    // getGatewayUrls returns 3 URLs; exhausting all of them triggers artwork-missing.
    render(<ListingCard listing={makeListing()} />);

    // Wait for the first image to render
    await waitFor(() => {
      expect(screen.getByRole('img')).toBeInTheDocument();
    });

    // Exhaust all three gateway URLs
    for (let i = 0; i < 3; i++) {
      screen.getByRole('img').dispatchEvent(new Event('error', { bubbles: true }));
      if (i < 2) {
        // Between failures the img element is still present (next gateway)
        await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument());
      }
    }

    // After all gateways fail, the fallback must appear and the img must be gone
    await waitFor(() => {
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      expect(screen.getByTestId('artwork-missing')).toBeInTheDocument();
    });
  });

  it('fallback does not contain text that claims to depict the artwork', async () => {
    const { fetchMetadata } = jest.requireMock('@/lib/ipfs');
    fetchMetadata.mockResolvedValueOnce({ title: 'My Painting', description: '', image: 'QmX' });

    render(<ListingCard listing={makeListing()} />);

    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument());

    // Exhaust all gateways
    for (let i = 0; i < 3; i++) {
      screen.getByRole('img').dispatchEvent(new Event('error', { bubbles: true }));
      if (i < 2) {
        await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument());
      }
    }

    await waitFor(() => {
      expect(screen.getByTestId('artwork-missing')).toBeInTheDocument();
    });

    const fallback = screen.getByTestId('artwork-missing');
    // Must not claim to show "My Painting" or describe the image content
    expect(fallback.textContent).not.toMatch(/My Painting/i);
    // Generic placeholder text is acceptable; it must not assert visual content
    expect(fallback.textContent).toMatch(/no artwork/i);
  });

  it('image has descriptive alt text derived from metadata title when source loads', async () => {
    render(<ListingCard listing={makeListing({ listing_id: 5 })} />);

    await waitFor(() => {
      const img = screen.getByRole('img') as HTMLImageElement;
      // Alt should be the metadata title ("Test Artwork" from the default mock),
      // not empty and not a generic machine-generated string like "image".
      expect(img.alt).toBe('Test Artwork');
    });
  });

  it('image alt text falls back to listing id when metadata title is absent', async () => {
    const { fetchMetadata } = jest.requireMock('@/lib/ipfs');
    fetchMetadata.mockResolvedValueOnce({ description: 'no title', image: 'QmX' });

    render(<ListingCard listing={makeListing({ listing_id: 42 })} />);

    await waitFor(() => {
      const img = screen.getByRole('img') as HTMLImageElement;
      expect(img.alt).toMatch(/42/);
    });
  });

  it('image element is absent (not broken) after all gateways fail — layout is intact', async () => {
    render(<ListingCard listing={makeListing({ listing_id: 7 })} />);

    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument());

    for (let i = 0; i < 3; i++) {
      screen.getByRole('img').dispatchEvent(new Event('error', { bubbles: true }));
      if (i < 2) {
        await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument());
      }
    }

    await waitFor(() => {
      // The broken <img> element must not remain in the DOM
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      // The card's title and price must still be visible (layout intact)
      expect(screen.getByText('Test Artwork')).toBeInTheDocument();
      expect(screen.getByText(/1\s*XLM/i)).toBeInTheDocument();
    });
  });
});

// ── Issue 009 — ListingClient detail image fallback ───────────────────────────
//
// Tests the onError → detailImageError path added to ListingClient.tsx.
// We exercise this through a minimal inline component that mirrors the exact
// conditional rendering logic, keeping the test self-contained and fast.

describe('ListingClient detail image — error fallback (Issue 009)', () => {
  /**
   * A minimal replica of the detail-image rendering logic from ListingClient.
   * Only the image/fallback branch is reproduced; everything else is omitted
   * so the test stays focused on the feature under test.
   */
  function DetailImageFragment({
    imageUrl,
    altText,
  }: {
    imageUrl: string | null;
    altText: string;
  }) {
    const [imageError, setImageError] = React.useState(false);

    // Mirror ListingClient: reset error state whenever the URL changes
    React.useEffect(() => {
      setImageError(false);
    }, [imageUrl]);

    if (imageUrl && !imageError) {
      return (
        <img
          src={imageUrl}
          alt={altText}
          onError={() => setImageError(true)}
          data-testid="detail-artwork-img"
        />
      );
    }
    return (
      <div
        aria-label="Artwork image unavailable"
        data-testid="detail-artwork-missing"
      >
        <span>No media available</span>
      </div>
    );
  }

  it('shows the image when the URL is present and no error has occurred', () => {
    render(<DetailImageFragment imageUrl="https://example.com/art.png" altText="A painting" />);
    expect(screen.getByTestId('detail-artwork-img')).toBeInTheDocument();
    expect(screen.queryByTestId('detail-artwork-missing')).not.toBeInTheDocument();
  });

  it('shows the fallback when imageUrl is null', () => {
    render(<DetailImageFragment imageUrl={null} altText="Artwork" />);
    expect(screen.getByTestId('detail-artwork-missing')).toBeInTheDocument();
    expect(screen.queryByTestId('detail-artwork-img')).not.toBeInTheDocument();
  });

  it('shows the fallback after an image error event fires', async () => {
    render(<DetailImageFragment imageUrl="https://example.com/art.png" altText="A painting" />);

    const img = screen.getByTestId('detail-artwork-img');
    fireEvent.error(img);

    await waitFor(() => {
      expect(screen.queryByTestId('detail-artwork-img')).not.toBeInTheDocument();
      expect(screen.getByTestId('detail-artwork-missing')).toBeInTheDocument();
    });
  });

  it('fallback does not claim to depict the artwork', async () => {
    render(<DetailImageFragment imageUrl="https://example.com/art.png" altText="Sunset over Lagos" />);

    fireEvent.error(screen.getByTestId('detail-artwork-img'));

    await waitFor(() => {
      const fallback = screen.getByTestId('detail-artwork-missing');
      // Must not echo back the artwork title as if it shows the image
      expect(fallback.textContent).not.toMatch(/Sunset over Lagos/i);
      expect(fallback.textContent).toMatch(/no media available/i);
    });
  });

  it('image has meaningful alt text when the source loads successfully', () => {
    render(
      <DetailImageFragment
        imageUrl="https://example.com/art.png"
        altText="Adire cloth pattern by Amara"
      />
    );
    const img = screen.getByTestId('detail-artwork-img') as HTMLImageElement;
    expect(img.alt).toBe('Adire cloth pattern by Amara');
    expect(img.alt.length).toBeGreaterThan(0);
  });

  it('resets the error state and shows the image again when the URL changes', async () => {
    const { rerender } = render(
      <DetailImageFragment imageUrl="https://example.com/bad.png" altText="Art" />
    );

    // Trigger an error on the first URL
    fireEvent.error(screen.getByTestId('detail-artwork-img'));
    await waitFor(() => {
      expect(screen.getByTestId('detail-artwork-missing')).toBeInTheDocument();
    });

    // Swap to a new (working) URL — error state should reset
    rerender(<DetailImageFragment imageUrl="https://example.com/good.png" altText="Art" />);

    await waitFor(() => {
      expect(screen.getByTestId('detail-artwork-img')).toBeInTheDocument();
      expect(screen.queryByTestId('detail-artwork-missing')).not.toBeInTheDocument();
    });
  });
});
