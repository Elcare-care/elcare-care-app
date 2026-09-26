// ─────────────────────────────────────────────────────────────
// components/ActiveFilterChips.tsx
//
// One removable chip per active filter on the explore/search page.
// Wired directly into the same `filterReducer` + `Filters` state that
// FilterSidebar and useFilterUrlSync already read/write — this is not a
// parallel state system, it dispatches the exact same actions the
// sidebar controls use, so removing a chip keeps the URL and sidebar
// in sync for free.
// ─────────────────────────────────────────────────────────────

"use client";

import { X } from "lucide-react";
import type { Dispatch } from "react";
import type { Filters, FilterAction, SortOption } from "./FilterSidebar";
import type { IndexerCollectionRow } from "@/lib/indexer";

/** Human-readable labels — kept in sync with SORT_OPTIONS in app/explore/page.tsx. */
const SORT_LABELS: Record<SortOption, string> = {
  newest: "Newest First",
  oldest: "Oldest First",
  "price-low": "Price: Low to High",
  "price-high": "Price: High to Low",
  "recently-sold": "Recently Sold",
};

interface Chip {
  key: string;
  label: string;
  onRemove: () => void;
}

interface ActiveFilterChipsProps {
  filters: Filters;
  dispatch: Dispatch<FilterAction>;
  /** Used to resolve a collection contract address to a human-readable name. */
  collections?: IndexerCollectionRow[];
  className?: string;
}

export function ActiveFilterChips({ filters, dispatch, collections = [], className = "" }: ActiveFilterChipsProps) {
  const collectionName = (address: string) =>
    collections.find((c) => c.contractAddress === address)?.name || `${address.slice(0, 6)}…${address.slice(-4)}`;

  const chips: Chip[] = [];

  if (filters.search.trim()) {
    chips.push({
      key: "search",
      label: `Search: "${filters.search.trim()}"`,
      onRemove: () => dispatch({ type: "SET_SEARCH", payload: "" }),
    });
  }

  if (filters.status !== "All") {
    chips.push({
      key: "status",
      label: `Status: ${filters.status}`,
      onRemove: () => dispatch({ type: "SET_STATUS", payload: "All" }),
    });
  }

  for (const address of filters.collection) {
    chips.push({
      key: `collection:${address}`,
      label: `Collection: ${collectionName(address)}`,
      onRemove: () => dispatch({ type: "TOGGLE_COLLECTION", payload: address }),
    });
  }

  if (filters.minPrice || filters.maxPrice) {
    const min = filters.minPrice || "0";
    const max = filters.maxPrice || "∞";
    chips.push({
      key: "price",
      label: `Price: ${min} – ${max} XLM`,
      onRemove: () => {
        dispatch({ type: "SET_MIN_PRICE", payload: "" });
        dispatch({ type: "SET_MAX_PRICE", payload: "" });
      },
    });
  }

  if (filters.artist) {
    chips.push({
      key: "artist",
      label: `Artist: ${filters.artist.slice(0, 8)}…${filters.artist.slice(-4)}`,
      onRemove: () => dispatch({ type: "SET_ARTIST", payload: "" }),
    });
  }

  if (filters.sort !== "newest") {
    chips.push({
      key: "sort",
      label: `Sort: ${SORT_LABELS[filters.sort]}`,
      onRemove: () => dispatch({ type: "SET_SORT", payload: "newest" }),
    });
  }

  if (chips.length === 0) return null;

  return (
    <div
      className={`flex flex-wrap items-center gap-2 ${className}`}
      role="group"
      aria-label="Active filters"
    >
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 py-1 pl-3 pr-1.5 text-xs font-medium text-brand-700"
        >
          {chip.label}
          <button
            type="button"
            onClick={chip.onRemove}
            aria-label={`Remove filter: ${chip.label}`}
            className="flex h-4 w-4 items-center justify-center rounded-full text-brand-500 hover:bg-brand-200 hover:text-brand-800 transition-colors"
          >
            <X size={11} aria-hidden="true" />
          </button>
        </span>
      ))}
      {chips.length > 1 && (
        <button
          type="button"
          onClick={() => dispatch({ type: "CLEAR_ALL" })}
          className="text-xs font-semibold text-gray-500 underline-offset-2 hover:text-gray-700 hover:underline"
        >
          Clear all
        </button>
      )}
    </div>
  );
}
