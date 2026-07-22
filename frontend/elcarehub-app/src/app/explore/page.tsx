// ─────────────────────────────────────────────────────────────
// app/explore/page.tsx — Browse / Explore All Listings
//
// Full catalogue page with search, filtering, sorting, and
// pagination for discovering marketplace listings at scale.
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useMemo, useCallback, useEffect, useRef, useReducer } from "react";
import { Listing, stroopsToXlm } from "@/lib/contract";
import { ListingCard } from "@/components/ListingCard";
import { ListingCardSkeleton } from "@/components/Skeletons";
import {
  ChevronLeft,
  ChevronRight,
  Search,
  SlidersHorizontal,
  ArrowUpDown
} from "lucide-react";
import { FilterSidebar, filterReducer, SortOption } from "@/components/FilterSidebar";
import { fetchMetadata, ArtworkMetadata } from "@/lib/ipfs";
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
  const [allListings, setAllListings] = useState<Listing[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // URL-synced filters
  const { initialFilters, initialPage, syncToUrl } = useFilterUrlSync();

  const [filters, dispatch] = useReducer(filterReducer, initialFilters);
  const [page, setPage] = useState(initialPage);
  const [showFilters, setShowFilters] = useState(false);

  // Debounce search so we don't fire on every keystroke
  const [debouncedSearch, setDebouncedSearch] = useState(initialFilters.search);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDebouncedSearch(filters.search), 350);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [filters.search]);

  // Debounced indexer fetch
  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const opts: Parameters<typeof fetchListings>[0] = { limit: 1000 };
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
        setAllListings(rows);
      } else {
        // Fallback to on-chain scan when indexer returns nothing
        const all = await getAllListings();
        setAllListings(all);
      }
    } catch {
      try {
        const all = await getAllListings();
        setAllListings(all);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Failed to load listings");
      }
    } finally {
      setIsLoading(false);
    }
  }, [filters.status, filters.minPrice, filters.maxPrice, debouncedSearch, filters.collection, filters.artist, filters.sort]);

  const debouncedLoadRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debouncedLoadRef.current) clearTimeout(debouncedLoadRef.current);
    debouncedLoadRef.current = setTimeout(load, 300);
    return () => {
      if (debouncedLoadRef.current) clearTimeout(debouncedLoadRef.current);
    };
  }, [load]);

  // Sync filters & page to URL
  useEffect(() => {
    syncToUrl(filters, page);
  }, [filters, page, syncToUrl]);

  // Reset to page 1 on filter changes
  useEffect(() => {
    setPage(1);
  }, [filters.status, filters.minPrice, filters.maxPrice, filters.search, filters.collection, filters.artist, filters.sort]);

  // Client-side sort fallback (if the indexer is down and we hit on-chain data)
  const filtered = useMemo(() => {
    const result = [...allListings];
    // Since we applied sorting at the indexer level, this is mostly a fallback.
    switch (filters.sort) {
      case "newest":
        result.sort((a, b) => b.created_at - a.created_at);
        break;
      case "oldest":
        result.sort((a, b) => a.created_at - b.created_at);
        break;
      case "price-low":
        result.sort((a, b) => Number(a.price - b.price));
        break;
      case "price-high":
        result.sort((a, b) => Number(b.price - a.price));
        break;
    }
    return result;
  }, [allListings, filters.sort]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginatedListings = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  const goToPage = useCallback(
    (p: number) => {
      setPage(Math.max(1, Math.min(p, totalPages)));
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [totalPages]
  );

  const activeCnt = allListings.filter((l) => l.status === "Active").length;
  const soldCnt = allListings.filter((l) => l.status === "Sold").length;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col" data-testid="explore-page">
      {/* Header Info */}
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
                { label: "Total Art", value: allListings.length },
                { label: "Active", value: activeCnt },
                { label: "Sold", value: soldCnt },
              ].map(({ label, value }) => (
                <div key={label} className="relative">
                  <span className="text-3xl font-display font-bold text-white block">
                    {value}
                  </span>
                  <span className="text-sm font-bold uppercase tracking-widest text-brand-500">
                    {label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Header Controls Bar */}
      <div className="sticky top-16 z-30 border-b border-gray-200 bg-white/95 backdrop-blur-sm shadow-sm">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center gap-4">
          <button
            onClick={() => setShowFilters(true)}
            className="flex items-center gap-2 rounded-xl border border-gray-200 px-4 py-3 text-sm font-semibold text-gray-600 hover:bg-gray-50 lg:hidden w-full sm:w-auto"
          >
            <SlidersHorizontal size={16} />
            Filters
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
        {/* Sidebar */}
        <FilterSidebar
          filters={filters}
          dispatch={dispatch}
          isOpen={showFilters}
          setIsOpen={setShowFilters}
          // Assuming recentArtists logic will be filled from indexer or fallback
          recentArtists={[]} 
        />

        {/* Content area */}
        <div className="flex-1">
          {!isLoading && !error && (
            <p className="mb-6 text-sm text-gray-500">
              Showing{" "}
              <span className="font-semibold text-gray-700">
                {filtered.length > 0 ? Math.min((page - 1) * PAGE_SIZE + 1, filtered.length) : 0}
                {" - "}
                {Math.min(page * PAGE_SIZE, filtered.length)}
              </span>{" "}
              of{" "}
              <span className="font-semibold text-gray-700">
                {filtered.length}
              </span>{" "}
              {filtered.length === 1 ? "artwork" : "artworks"}
            </p>
          )}

          {error && <div className="text-red-500 p-4 border border-red-200 bg-red-50 rounded-lg">{error}</div>}

          {isLoading && !error && (
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: PAGE_SIZE }).map((_, i) => (
                <ListingCardSkeleton key={i} />
              ))}
            </div>
          )}

          {!isLoading && !error && filtered.length === 0 && (
            <div className="py-20 text-center">
              <h3 className="text-xl font-bold text-gray-900 mb-2">No artworks found</h3>
              <p className="text-gray-500">Try adjusting your filters or search criteria.</p>
              <button onClick={() => dispatch({ type: "CLEAR_ALL" })} className="mt-4 text-brand-600 font-medium hover:underline">
                Clear all filters
              </button>
            </div>
          )}

          {!isLoading && !error && filtered.length > 0 && (
            <>
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {paginatedListings.map((listing: Listing) => (
                  <ListingCard
                    key={listing.listing_id}
                    listing={listing}
                    onPurchased={load}
                  />
                ))}
              </div>

              {totalPages > 1 && (
                <div className="mt-10 flex items-center justify-center gap-2">
                  <button
                    onClick={() => goToPage(page - 1)}
                    disabled={page <= 1}
                    className="flex items-center gap-1 rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    <ChevronLeft size={16} /> Prev
                  </button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1)
                    .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 1)
                    .reduce<(number | "...")[]>((acc, p, idx, arr) => {
                      if (idx > 0 && p - (arr[idx - 1] as number) > 1) acc.push("...");
                      acc.push(p);
                      return acc;
                    }, [])
                    .map((item, idx) =>
                      item === "..." ? (
                        <span key={`dots-${idx}`} className="px-1 text-gray-400">...</span>
                      ) : (
                        <button
                          key={item}
                          onClick={() => goToPage(item as number)}
                          className={`min-w-[36px] rounded-xl px-3 py-2 text-sm font-medium transition-all ${
                            page === item
                              ? "bg-brand-500 text-white shadow-md shadow-brand-500/20"
                              : "border border-gray-200 text-gray-600 hover:bg-gray-50"
                          }`}
                        >
                          {item}
                        </button>
                      )
                    )}
                  <button
                    onClick={() => goToPage(page + 1)}
                    disabled={page >= totalPages}
                    className="flex items-center gap-1 rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
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
