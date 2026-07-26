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
import { ChevronLeft, ChevronRight, Search, SlidersHorizontal, ArrowUpDown } from "lucide-react";
import { FilterSidebar, filterReducer, SortOption } from "@/components/FilterSidebar";
import { fetchListings } from "@/lib/indexer";
import { getAllListings } from "@/lib/contract";
import { useFilterUrlSync } from "@/hooks/useFilterUrlSync";

const PAGE_SIZE = 12;

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
  const [error, setError] = useState<string | null>(null);

  // cursorStack[i] = X-Next-Cursor value returned after fetching page i.
  // currentCursorIdx = index of the page currently displayed (0 = first page).
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [currentCursorIdx, setCurrentCursorIdx] = useState(0);

  const { initialFilters, initialPage, syncToUrl } = useFilterUrlSync();
  const [filters, dispatch] = useReducer(filterReducer, initialFilters);
  const [showFilters, setShowFilters] = useState(false);

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

  const fetchPage = useCallback(async (cursorLedger?: number): Promise<string> => {
    setIsLoading(true);
    setError(null);
    try {
      const opts: Parameters<typeof fetchListings>[0] = {
        limit: PAGE_SIZE,
        cursor_direction: "desc",
      };
      if (cursorLedger != null) opts.cursor_ledger = cursorLedger;
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
        setError(e instanceof Error ? e.message : "Failed to load listings");
      }
      return "";
    } finally {
      setIsLoading(false);
    }
  }, [filters.status, filters.minPrice, filters.maxPrice, debouncedSearch,
      filters.collection, filters.artist, filters.sort]);

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
  }, [cursorStack, currentCursorIdx, fetchPage]);

  const goPrev = useCallback(async () => {
    if (currentCursorIdx === 0) return;
    const newIdx = currentCursorIdx - 1;
    const prevCursor = newIdx === 0 ? undefined : parseInt(cursorStack[newIdx - 1], 10);
    await fetchPage(Number.isFinite(prevCursor) ? prevCursor : undefined);
    setCurrentCursorIdx(newIdx);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [currentCursorIdx, cursorStack, fetchPage]);

  const hasNext = !!cursorStack[currentCursorIdx] && listings.length === PAGE_SIZE;
  const hasPrev = currentCursorIdx > 0;
  const currentPage = currentCursorIdx + 1;
  const totalPages = totalCount > 0 ? Math.ceil(totalCount / PAGE_SIZE) : 1;
  const activeCnt = listings.filter((l: Listing) => l.status === "Active").length;
  const soldCnt = listings.filter((l: Listing) => l.status === "Sold").length;

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
              placeholder="Search by title, artist, or description..."
              value={filters.search}
              onChange={(e) => dispatch({ type: "SET_SEARCH", payload: e.target.value })}
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
          {!isLoading && !error && totalCount > 0 && (
            <p className="mb-6 text-sm text-gray-500">
              Page <span className="font-semibold text-gray-700">{currentPage}</span>
              {totalPages > 1 && <> of <span className="font-semibold text-gray-700">{totalPages}</span></>}
              {" · "}<span className="font-semibold text-gray-700">{totalCount}</span>{" "}
              {totalCount === 1 ? "artwork" : "artworks"}
            </p>
          )}

          {error && (
            <div className="text-red-500 p-4 border border-red-200 bg-red-50 rounded-lg">{error}</div>
          )}

          {isLoading && (
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: PAGE_SIZE }).map((_, i) => <ListingCardSkeleton key={i} />)}
            </div>
          )}

          {!isLoading && !error && listings.length === 0 && (
            <div className="py-20 text-center">
              <h3 className="text-xl font-bold text-gray-900 mb-2">No artworks found</h3>
              <p className="text-gray-500">Try adjusting your filters or search criteria.</p>
              <button
                onClick={() => dispatch({ type: "CLEAR_ALL" })}
                className="mt-4 text-brand-600 font-medium hover:underline"
              >
                Clear all filters
              </button>
            </div>
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
