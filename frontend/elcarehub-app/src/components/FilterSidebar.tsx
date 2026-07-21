"use client";

import React, { useEffect, useState } from "react";
import { X, Check } from "lucide-react";
import { getCollections, IndexerCollectionRow } from "@/lib/indexer";

export type StatusFilter = "All" | "Active" | "Sold" | "Expired";
export type SortOption = "newest" | "oldest" | "price-low" | "price-high" | "recently-sold";

export interface Filters {
  search: string;
  status: StatusFilter;
  collection: string[];
  minPrice: string;
  maxPrice: string;
  artist: string;
  sort: SortOption;
}

export type FilterAction =
  | { type: "SET_SEARCH"; payload: string }
  | { type: "SET_STATUS"; payload: StatusFilter }
  | { type: "TOGGLE_COLLECTION"; payload: string }
  | { type: "SET_MIN_PRICE"; payload: string }
  | { type: "SET_MAX_PRICE"; payload: string }
  | { type: "SET_ARTIST"; payload: string }
  | { type: "SET_SORT"; payload: SortOption }
  | { type: "CLEAR_ALL" }
  | { type: "SET_ALL"; payload: Filters };

export function filterReducer(state: Filters, action: FilterAction): Filters {
  switch (action.type) {
    case "SET_SEARCH":
      return { ...state, search: action.payload };
    case "SET_STATUS":
      return { ...state, status: action.payload };
    case "TOGGLE_COLLECTION": {
      const exists = state.collection.includes(action.payload);
      return {
        ...state,
        collection: exists
          ? state.collection.filter((c) => c !== action.payload)
          : [...state.collection, action.payload],
      };
    }
    case "SET_MIN_PRICE":
      return { ...state, minPrice: action.payload };
    case "SET_MAX_PRICE":
      return { ...state, maxPrice: action.payload };
    case "SET_ARTIST":
      return { ...state, artist: action.payload };
    case "SET_SORT":
      return { ...state, sort: action.payload };
    case "CLEAR_ALL":
      return {
        search: "",
        status: "All",
        collection: [],
        minPrice: "",
        maxPrice: "",
        artist: "",
        sort: "newest",
      };
    case "SET_ALL":
      return action.payload;
    default:
      return state;
  }
}

interface FilterSidebarProps {
  filters: Filters;
  dispatch: React.Dispatch<FilterAction>;
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  recentArtists?: string[];
}

export function FilterSidebar({ filters, dispatch, isOpen, setIsOpen, recentArtists = [] }: FilterSidebarProps) {
  const [collections, setCollections] = useState<IndexerCollectionRow[]>([]);

  useEffect(() => {
    const fetchColls = async () => {
      try {
        const res = await getCollections();
        if (res && res.collections) {
          setCollections(res.collections);
        }
      } catch (e) {
        console.warn("Failed to fetch collections", e);
      }
    };
    fetchColls();
  }, []);

  const statuses: StatusFilter[] = ["All", "Active", "Sold", "Expired"];

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`fixed inset-y-0 left-0 z-50 w-80 transform bg-white shadow-xl transition-transform duration-300 ease-in-out lg:static lg:block lg:translate-x-0 ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-full flex-col overflow-y-auto">
          {/* Header */}
          <div className="flex items-center justify-between border-b px-6 py-4">
            <h2 className="text-lg font-semibold text-gray-900">Filters</h2>
            <button
              onClick={() => setIsOpen(false)}
              className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 lg:hidden"
            >
              <X size={20} />
            </button>
          </div>

          <div className="flex-1 space-y-8 p-6">
            {/* Status Filter */}
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-gray-900">Status</h3>
              <div className="space-y-2">
                {statuses.map((status) => (
                  <label key={status} className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name="status"
                      value={status}
                      checked={filters.status === status}
                      onChange={() => dispatch({ type: "SET_STATUS", payload: status })}
                      className="h-4 w-4 border-gray-300 text-brand-600 focus:ring-brand-500"
                    />
                    <span className="text-sm text-gray-700">{status}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Price Range */}
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-gray-900">Price Range (XLM)</h3>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  placeholder="Min"
                  value={filters.minPrice}
                  onChange={(e) => dispatch({ type: "SET_MIN_PRICE", payload: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
                <span className="text-gray-500">-</span>
                <input
                  type="number"
                  placeholder="Max"
                  value={filters.maxPrice}
                  onChange={(e) => dispatch({ type: "SET_MAX_PRICE", payload: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </div>
            </div>

            {/* Collection Filter */}
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-gray-900">Collections</h3>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {collections.length > 0 ? (
                  collections.map((coll) => (
                    <label key={coll.contractAddress} className="flex items-center gap-3 cursor-pointer">
                      <div
                        className={`flex h-4 w-4 items-center justify-center rounded border ${
                          filters.collection.includes(coll.contractAddress)
                            ? "border-brand-500 bg-brand-500 text-white"
                            : "border-gray-300 bg-white"
                        }`}
                        onClick={(e) => {
                          e.preventDefault();
                          dispatch({ type: "TOGGLE_COLLECTION", payload: coll.contractAddress });
                        }}
                      >
                        {filters.collection.includes(coll.contractAddress) && <Check size={12} />}
                      </div>
                      <span className="text-sm text-gray-700">{coll.name || "Unnamed"}</span>
                      {/* NFT Count badge mock since indexer doesn't explicitly type it */}
                      <span className="ml-auto rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                        {(coll as any).nftCount || 0}
                      </span>
                    </label>
                  ))
                ) : (
                  <p className="text-sm text-gray-500">Loading collections...</p>
                )}
              </div>
            </div>

            {/* Artist Search */}
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-gray-900">Artist Address</h3>
              <input
                type="text"
                placeholder="Search by artist address"
                value={filters.artist}
                onChange={(e) => dispatch({ type: "SET_ARTIST", payload: e.target.value })}
                list="recent-artists"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
              <datalist id="recent-artists">
                {recentArtists.map((address) => (
                  <option key={address} value={address} />
                ))}
              </datalist>
            </div>
          </div>

          {/* Footer */}
          <div className="border-t p-4">
            <button
              onClick={() => dispatch({ type: "CLEAR_ALL" })}
              className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Clear All Filters
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
