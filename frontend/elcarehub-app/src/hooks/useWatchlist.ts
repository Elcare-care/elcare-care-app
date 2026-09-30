"use client";

import { useState, useEffect, useCallback } from "react";
import {
  WatchableType,
  WatchedItem,
  getWatchlist,
  isWatching,
  addToWatchlist,
  removeFromWatchlist,
  clearWatchlist,
} from "@/lib/watchlist";

export function useWatchlist(publicKey: string | null) {
  const [items, setItems] = useState<WatchedItem[]>([]);

  const reload = useCallback(() => {
    setItems(getWatchlist(publicKey));
  }, [publicKey]);

  // Reload when the wallet changes — prevents one wallet seeing another's list
  useEffect(() => {
    reload();
  }, [reload]);

  const watch = useCallback(
    (type: WatchableType, id: string) => {
      addToWatchlist(publicKey, type, id);
      reload();
    },
    [publicKey, reload]
  );

  const unwatch = useCallback(
    (type: WatchableType, id: string) => {
      removeFromWatchlist(publicKey, type, id);
      reload();
    },
    [publicKey, reload]
  );

  const toggleWatch = useCallback(
    (type: WatchableType, id: string) => {
      if (isWatching(publicKey, type, id)) {
        unwatch(type, id);
      } else {
        watch(type, id);
      }
    },
    [publicKey, watch, unwatch]
  );

  const clear = useCallback(() => {
    clearWatchlist(publicKey);
    reload();
  }, [publicKey, reload]);

  return {
    items,
    watch,
    unwatch,
    toggleWatch,
    clear,
    isWatching: (type: WatchableType, id: string) =>
      isWatching(publicKey, type, id),
  };
}
