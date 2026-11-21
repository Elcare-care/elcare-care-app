// ─────────────────────────────────────────────────────────────
// components/Skeletons.tsx — Reusable skeleton loading components
//
// Issue 1033: each skeleton preserves the exact final grid geometry so
// the page does not reflow when real data arrives. The shimmer cells use
// aria-hidden="true" and are wrapped in a container with
// role="status" + aria-label at the call site (see ListingCardGridSkeleton
// and AuctionCardGridSkeleton below) so screen-reader users get one
// consistent "loading" announcement per page rather than N per card.
// ─────────────────────────────────────────────────────────────

// ── Single card skeletons ─────────────────────────────────────────────────────

export function ListingCardSkeleton() {
  return (
    // aria-hidden: individual cards are not announced; the grid wrapper
    // exposes a single role="status" announcement (see ListingCardGridSkeleton).
    <div
      aria-hidden="true"
      className="flex flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm animate-pulse"
    >
      {/* Image placeholder — aspect-square matches the real ListingCard */}
      <div className="aspect-square bg-gray-100" />

      {/* Info placeholder — mirrors ListingCard info section heights */}
      <div className="flex flex-1 flex-col p-4 space-y-3">
        {/* Title */}
        <div className="h-4 w-3/4 rounded bg-gray-100" />
        {/* Artist address */}
        <div className="h-3 w-1/2 rounded bg-gray-100" />
        {/* Description line */}
        <div className="mt-3 space-y-1">
          <div className="h-3 w-2/3 rounded bg-gray-100" />
        </div>
        {/* Price + Buy button row */}
        <div className="mt-4 flex items-center justify-between">
          <div className="h-6 w-24 rounded bg-gray-100" />
          <div className="h-9 w-24 rounded-lg bg-gray-100" />
        </div>
      </div>
    </div>
  );
}

export function AuctionCardSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden animate-pulse"
    >
      {/* Image placeholder — aspect-square matches real AuctionCard */}
      <div className="aspect-square bg-gray-100" />

      {/* Info placeholder */}
      <div className="p-4 space-y-3">
        {/* Title */}
        <div className="h-4 w-3/4 rounded bg-gray-100" />
        {/* Bid + time row */}
        <div className="flex items-center justify-between">
          <div className="h-4 w-28 rounded bg-gray-100" />
          <div className="h-3 w-20 rounded bg-gray-100" />
        </div>
        {/* Reserve price */}
        <div className="h-3 w-32 rounded bg-gray-100" />
      </div>
    </div>
  );
}

export function FeaturedListingSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="relative aspect-[4/5] overflow-hidden rounded-2xl animate-pulse bg-gray-100"
    />
  );
}

// ── Grid wrappers ─────────────────────────────────────────────────────────────
//
// Render a full page-worth of card skeletons inside a correctly-sized grid so
// the page layout does not shift when the real grid mounts. The wrapper holds
// the single role="status" / aria-live announcement; individual cards are
// aria-hidden to avoid screen readers announcing each one.

interface GridSkeletonProps {
  /** Number of skeleton cards to show. Defaults to the standard page size. */
  count?: number;
  /** Optional extra class names for the grid container. */
  className?: string;
  /** Accessible loading label. Defaults to "Loading…". */
  label?: string;
}

/**
 * ListingCardGridSkeleton
 *
 * Matches the grid used in ExplorePage: 1 column on mobile, 2 on sm,
 * 3 on lg — exactly matching `grid gap-6 sm:grid-cols-2 lg:grid-cols-3`.
 */
export function ListingCardGridSkeleton({
  count = 12,
  className = "",
  label = "Loading artworks…",
}: GridSkeletonProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className={`grid gap-6 sm:grid-cols-2 lg:grid-cols-3 ${className}`}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }).map((_, i) => (
        <ListingCardSkeleton key={i} />
      ))}
    </div>
  );
}

/**
 * AuctionCardGridSkeleton
 *
 * Matches the grid used in AuctionsPage: 1 column on mobile, 2 on sm,
 * 3 on lg, 4 on xl — exactly matching
 * `grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4`.
 */
export function AuctionCardGridSkeleton({
  count = 8,
  className = "",
  label = "Loading auctions…",
}: GridSkeletonProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className={`grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 ${className}`}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }).map((_, i) => (
        <AuctionCardSkeleton key={i} />
      ))}
    </div>
  );
}
