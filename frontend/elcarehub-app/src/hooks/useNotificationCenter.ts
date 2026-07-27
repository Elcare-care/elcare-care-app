"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useWalletContext } from "@/context/WalletContext";
import { config } from "@/lib/config";
import { subscribeToMarketplaceEvents, MarketplaceSSEEvent } from "@/lib/indexer";
import {
  AppNotification,
  NotificationCategory,
  NotificationPreferences,
  getWatchlist,
  getNotificationPreferences,
  setNotificationPreferences,
  getReadNotificationIds,
  markNotificationRead,
  markAllNotificationsRead,
  sseEventToNotification,
} from "@/lib/watchlist";

const STALE_MS = 60_000; // mark notifications stale after 60 s

export function useNotificationCenter() {
  const { publicKey } = useWalletContext();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [prefs, setPrefs] = useState<NotificationPreferences>(
    getNotificationPreferences(publicKey)
  );
  const [sseConnected, setSseConnected] = useState(false);
  const lastEventIdRef = useRef<string | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());

  // Reload prefs and clear notification list on wallet switch
  useEffect(() => {
    setPrefs(getNotificationPreferences(publicKey));
    setNotifications([]);
    seenIdsRef.current = new Set();
  }, [publicKey]);

  // Mark stale periodically
  useEffect(() => {
    const timer = setInterval(() => {
      setNotifications((prev) =>
        prev.map((n) =>
          !n.isStale && Date.now() - n.receivedAt > STALE_MS
            ? { ...n, isStale: true }
            : n
        )
      );
    }, 10_000);
    return () => clearInterval(timer);
  }, []);

  // SSE subscription scoped to the current wallet
  useEffect(() => {
    const sub = subscribeToMarketplaceEvents(config.indexerUrl, {
      onOpen: () => setSseConnected(true),
      onClose: () => setSseConnected(false),
      lastEventId: lastEventIdRef.current ?? undefined,
      debounceMs: 300,
      onEvent: (event: MarketplaceSSEEvent) => {
        const watchlist = getWatchlist(publicKey);
        const currentPrefs = getNotificationPreferences(publicKey);
        const readIds = getReadNotificationIds(publicKey);

        const notif = sseEventToNotification(
          event,
          watchlist,
          currentPrefs,
          readIds
        );
        if (!notif) return;

        // Deduplicate: skip if we have already received this notification
        if (seenIdsRef.current.has(notif.id)) return;
        seenIdsRef.current.add(notif.id);

        setNotifications((prev) => [notif, ...prev].slice(0, 100));
      },
    });

    lastEventIdRef.current = sub.getLastEventId();

    return () => {
      lastEventIdRef.current = sub.getLastEventId();
      sub.close();
    };
  }, [publicKey]);

  const markRead = useCallback(
    (notifId: string) => {
      markNotificationRead(publicKey, notifId);
      setNotifications((prev) =>
        prev.map((n) => (n.id === notifId ? { ...n, isRead: true } : n))
      );
    },
    [publicKey]
  );

  const markAllRead = useCallback(() => {
    const ids = notifications.map((n) => n.id);
    markAllNotificationsRead(publicKey, ids);
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
  }, [publicKey, notifications]);

  const updatePref = useCallback(
    (category: NotificationCategory, enabled: boolean) => {
      const next = { ...prefs, [category]: enabled };
      setNotificationPreferences(publicKey, next);
      setPrefs(next);
    },
    [publicKey, prefs]
  );

  const unreadCount = notifications.filter((n) => !n.isRead).length;

  return {
    notifications,
    unreadCount,
    prefs,
    sseConnected,
    markRead,
    markAllRead,
    updatePref,
  };
}
