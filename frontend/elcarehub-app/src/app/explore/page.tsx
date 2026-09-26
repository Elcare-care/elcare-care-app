// ─────────────────────────────────────────────────────────────
// app/explore/page.tsx — Browse / Explore All Listings
//
// Full catalogue page with search, filtering, sorting, and
// cursor-based pagination for discovering marketplace listings at scale.
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useCallback, useEffect, useRef, useReducer } from "react";
import { Listing } from "@/lib/contract";
import { ListingCard } from "@/components/ListingCard";
import { ListingCardSkeleton } from "@/components/Skeletons";
import { ChevronLeft, ChevronRight, Search, SlidersHorizontal, ArrowUpDown, Info } from "lucide-react";
import { FilterSidebar, filterReducer, SortOption } from "@/components/FilterSidebar";
import { ActiveFilterChips } from "@/components/ActiveFilterChips";
import { fetchListings, getCollections, IndexerCollectionRow } from "@/lib/indexer";
import { getAllListings } from "@/lib/contract";
import { useFilterUrlSync } from "@/hooks/useFilterUrlSync";
import { ResourceState } from "@/components/PageStates";
import { categorizePageError, PageStateError } from "@/lib/pageState";

const PAGE_SIZE = 12;

// Must match FTS_MIN_LENGTH in indexer/src/api/routes.ts — search terms
// shorter than this use a slower ILIKE fallback instead of the tsvector/
// GIN-indexed full-text search path.
const FTS_MIN_LENGTH = 3;

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "newest", label: "Newest First" },
  { value: "oldest", label: "Oldest First" },
  { value: "price-low", label: "Price: Low to High" },
  { value: "price-high", label: "Price: High to Low" },
  { value: "recently-sold", label: "Recently Sold" },
];

export default function ExplorePage() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<PageStateError | null>(null);

  // cursorStack[i] = X-Next-Cursor value returned after fetching page i.
  // currentCursorIdx = index of the page currently displayed (0 = first page).
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [currentCursorIdx, setCurrentCursorIdx] = useState(0);

  const { initialFilters, initialPage, syncToUrl } = useFilterUrlSync();
  const [filters, dispatch] = useReducer(filterReducer, initialFilters);
  const [showFilters, setShowFilters] = useState(false);

  // Fetched once for chip labels (mapping a collection contract address back
  // to its display name) — FilterSidebar fetches its own copy independently
  // for its checkbox list, this is a lightweight, cached read.
  const [collections, setCollections] = useState<IndexerCollectionRow[]>([]);
  useEffect(() => {
    getCollections().then((res) => setCollections(res?.collections ?? [])).catch(() => {});
  }, []);

  // Debounce search input
  const [debouncedSearch, setDebouncedSearch] = useState(initialFilters.search);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDebouncedSearch(filters.search), 350);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [filters.search]);

  // Reset cursor stack on every filter change
  useEffect(() => {
    setCursorStack([]);
    setCurrentCursorIdx(0);
  }, [filters.status, filters.minPrice, filters.maxPrice, filters.search,
      filters.collection, filters.artist, filters.sort]);

  // "price-low"/"price-high" order by price, not updatedAtLedger, so the
  // ledger-based cursor the other sorts use would bound the wrong page
  // (the indexer rejects that combination outright — see the refine on
  // listingsQuerySchema). These two sorts fall back to offset pagination
  // instead; every other sort keeps the cursor stack below.
  const isOffsetSort = filters.sort === "price-low" || filters.sort === "price-high";

  const fetchPage = useCallback(async (pageArg?: number): Promise<string> => {
    setIsLoading(true);
    setError(null);
    try {
      const opts: Parameters<typeof fetchListings>[0] = {
        limit: PAGE_SIZE,
        cursor_direction: "desc",
      };
      if (isOffsetSort) {
        if (pageArg != null) opts.offset = pageArg;
      } else if (pageArg != null) {
        opts.cursor_ledger = pageArg;
      }
      if (filters.status !== "All") opts.status = filters.status;
      if (filters.minPrice) opts.minPrice = filters.minPrice;
      if (filters.maxPrice) opts.maxPrice = filters.maxPrice;
      if (debouncedSearch.trim()) opts.search = debouncedSearch.trim();
      if (filters.collection.length > 0) opts.collection = filters.collection;
      if (filters.artist) opts.artist = filters.artist;
      if (filters.sort && filters.sort !== "newest") opts.sort = filters.sort;

      const res = await fetchListings(opts);
      const rows = Array.isArray(res.listings) ? (res.listings as Listing[]) : [];

      if (rows.length > 0) {
        setListings(rows);
        setTotalCount(res.total ?? rows.length);
        return res.nextCursor ?? "";
      }

      // Fallback to on-chain scan
      const all = await getAllListings();
      setListings(all.slice(0, PAGE_SIZE));
      setTotalCount(all.length);
      return "";
    } catch {
      try {
        const all = await getAllListings();
        setListings(all.slice(0, PAGE_SIZE));
        setTotalCount(all.length);
      } catch (e: unknown) {
        // Both the indexer and the on-chain fallback failed — this is a real
        // outage, not "no listings," so it must never render as an empty state.
        setError(categorizePageError(e, { resourceLabel: "listings" }));
      }
      return "";
    } finally {
      setIsLoading(false);
    }
  }, [filters.status, filters.minPrice, filters.maxPrice, debouncedSearch,
      filters.collection, filters.artist, filters.sort, isOffsetSort]);

  // Load first page whenever filters change (debounced)
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    loadTimerRef.current = setTimeout(async () => {
      const next = await fetchPage(undefined);
      setCursorStack(next ? [next] : []);
      setCurrentCursorIdx(0);
    }, 300);
    return () => { if (loadTimerRef.current) clearTimeout(loadTimerRef.current); };
  }, [fetchPage]);

  // Sync URL
  useEffect(() => {
    syncToUrl(filters, currentCursorIdx + 1);
  }, [filters, currentCursorIdx, syncToUrl]);

  const goNext = useCallback(async () => {
    if (isOffsetSort) {
      const newIdx = currentCursorIdx + 1;
      await fetchPage(newIdx * PAGE_SIZE);
      setCurrentCursorIdx(newIdx);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const nextCursor = cursorStack[currentCursorIdx];
    if (!nextCursor) return;
    const cursorLedger = parseInt(nextCursor, 10);
    if (!Number.isFinite(cursorLedger)) return;
    const newNext = await fetchPage(cursorLedger);
    setCurrentCursorIdx((idx: number) => {
      const newIdx = idx + 1;
      setCursorStack((stack: string[]) => {
        const copy = [...stack];
        copy[newIdx] = newNext;
        return copy;
      });
      return newIdx;
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [cursorStack, currentCursorIdx, fetchPage, isOffsetSort]);

  const goPrev = useCallback(async () => {
    if (currentCursorIdx === 0) return;
    const newIdx = currentCursorIdx - 1;
    if (isOffsetSort) {
      await fetchPage(newIdx * PAGE_SIZE);
      setCurrentCursorIdx(newIdx);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const prevCursor = newIdx === 0 ? undefined : parseInt(cursorStack[newIdx - 1], 10);
    await fetchPage(Number.isFinite(prevCursor) ? prevCursor : undefined);
    setCurrentCursorIdx(newIdx);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [currentCursorIdx, cursorStack, fetchPage, isOffsetSort]);

  const hasNext = isOffsetSort
    ? listings.length === PAGE_SIZE && (currentCursorIdx + 1) * PAGE_SIZE < totalCount
    : !!cursorStack[currentCursorIdx] && listings.length === PAGE_SIZE;
  const hasPrev = currentCursorIdx > 0;
  const currentPage = currentCursorIdx + 1;
  const totalPages = totalCount > 0 ? Math.ceil(totalCount / PAGE_SIZE) : 1;
  const activeCnt = listings.filter((l: Listing) => l.status === "Active").length;
  const soldCnt = listings.filter((l: Listing) => l.status === "Sold").length;

  // A non-empty search term shorter than the FTS threshold degrades to a
  // slower ILIKE scan server-side (see indexer/src/api/routes.ts) — surface
  // that as an inline hint rather than letting the slow request happen
  // silently.
  const trimmedSearch = filters.search.trim();
  const isSlowSearchTerm = trimmedSearch.length > 0 && trimmedSearch.length < FTS_MIN_LENGTH;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col" data-testid="explore-page">
      {/* Header */}
      <div className="bg-midnight-900 pt-32 pb-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-8">
            <div className="space-y-4">
              <h1 className="text-5xl font-display font-bold text-white tracking-tight">
                Explore Artworks
              </h1>
              <p className="max-w-xl text-xl text-white/60 font-inter leading-relaxed">
                Discover and collect unique African art on the blockchain
              </p>
            </div>
            <div className="flex flex-wrap gap-8 md:gap-12">
              {[
                { label: "Total Art", value: totalCount },
                { label: "Active", value: activeCnt },
                { label: "Sold", value: soldCnt },
              ].map(({ label, value }) => (
                <div key={label} className="relative">
                  <span className="text-3xl font-display font-bold text-white block">{value}</span>
                  <span className="text-sm font-bold uppercase tracking-widest text-brand-500">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Controls Bar */}
      <div className="sticky top-16 z-30 border-b border-gray-200 bg-white/95 backdrop-blur-sm shadow-sm">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center gap-4">
          <button
            onClick={() => setShowFilters(true)}
            className="flex items-center gap-2 rounded-xl border border-gray-200 px-4 py-3 text-sm font-semibold text-gray-600 hover:bg-gray-50 lg:hidden w-full sm:w-auto"
          >
            <SlidersHorizontal size={16} /> Filters
          </button>

          <div className="relative flex-1 w-full max-w-xl">
            <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              id="explore-search-input"
              placeholder="Search by title, artist, or description..."
              value={filters.search}
              onChange={(e) => dispatch({ type: "SET_SEARCH", payload: e.target.value })}
              aria-describedby={isSlowSearchTerm ? "explore-search-cost-hint" : undefined}
              className="w-full rounded-2xl border border-gray-200 bg-gray-50 py-3 pl-12 pr-4 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-4 focus:ring-brand-500/10 transition-all shadow-sm"
            />
          </div>

          <div className="relative w-full sm:w-auto">
            <ArrowUpDown size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <select
              value={filters.sort}
              onChange={(e) => dispatch({ type: "SET_SORT", payload: e.target.value as SortOption })}
              className="w-full appearance-none rounded-xl border border-gray-200 bg-gray-50 py-3 pl-12 pr-10 text-sm font-semibold text-gray-700 focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/10 cursor-pointer shadow-sm transition-all"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Query-cost hint: a very short search term skips the indexed
            full-text path and falls back to a slower ILIKE scan (see
            FTS_MIN_LENGTH in indexer/src/api/routes.ts). This is an inline,
            non-blocking hint — the request still goes through — so the user
            understands why results might take longer or rank differently. */}
        {isSlowSearchTerm && (
          <div className="mx-auto max-w-7xl px-4 sm:px-6 pb-3">
            <p
              id="explore-search-cost-hint"
              role="status"
              className="flex items-center gap-1.5 text-xs text-amber-700"
            >
              <Info size={12} aria-hidden="true" />
              Search terms under {FTS_MIN_LENGTH} characters use a slower fallback search — try a longer term for faster, more relevant results.
            </p>
          </div>
        )}
      </div>

      <div className="mx-auto flex w-full max-w-7xl flex-1 gap-8 px-4 sm:px-6 py-8">
        <FilterSidebar
          filters={filters}
          dispatch={dispatch}
          isOpen={showFilters}
          setIsOpen={setShowFilters}
          recentArtists={[]}
        />

        <div className="flex-1">
          <ActiveFilterChips filters={filters} dispatch={dispatch} collections={collections} className="mb-4" />

          {!isLoading && !error && totalCount > 0 && (
            <p className="mb-6 text-sm text-gray-500">
              Page <span className="font-semibold text-gray-700">{currentPage}</span>
              {totalPages > 1 && <> of <span className="font-semibold text-gray-700">{totalPages}</span></>}
              {" · "}<span className="font-semibold text-gray-700">{totalCount}</span>{" "}
              {totalCount === 1 ? "artwork" : "artworks"}
            </p>
          )}

          {error && (
            // Retrying re-runs fetchPage, which closes over the current filter
            // state — a retry never drops the user's search/filter selections.
            <ResourceState isLoading={false} error={error} onRetry={() => fetchPage(undefined)} />
          )}

          {isLoading && (
            <div role="status" aria-live="polite" className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              <span className="sr-only">Loading artworks…</span>
              {Array.from({ length: PAGE_SIZE }).map((_, i) => <ListingCardSkeleton key={i} />)}
            </div>
          )}

          {!isLoading && !error && listings.length === 0 && (
            <ResourceState
              isLoading={false}
              error={null}
              isEmpty
              empty={{
                title: "No artworks found",
                description: "Try adjusting your filters or search criteria.",
                action: { label: "Clear all filters", onClick: () => dispatch({ type: "CLEAR_ALL" }) },
              }}
            />
          )}

          {!isLoading && !error && listings.length > 0 && (
            <>
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {listings.map((listing: Listing) => (
                  <ListingCard
                    key={listing.listing_id}
                    listing={listing}
                    onPurchased={() => fetchPage(undefined)}
                  />
                ))}
              </div>

              {(hasPrev || hasNext) && (
                <div className="mt-10 flex items-center justify-center gap-4">
                  <button
                    onClick={goPrev}
                    disabled={!hasPrev || isLoading}
                    aria-label="Previous page"
                    className="flex items-center gap-1 rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    <ChevronLeft size={16} /> Previous
                  </button>
                  <span className="text-sm text-gray-500">
                    Page {currentPage}{totalPages > 1 ? ` of ${totalPages}` : ""}
                  </span>
                  <button
                    onClick={goNext}
                    disabled={!hasNext || isLoading}
                    aria-label="Next page"
                    className="flex items-center gap-1 rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    Next <ChevronRight size={16} />
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
