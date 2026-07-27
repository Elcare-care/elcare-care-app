"use client";

import { useRef, useState, useEffect } from "react";
import Link from "next/link";
import {
  Bell,
  BellOff,
  CheckCheck,
  X,
  Gavel,
  Tag,
  ShoppingCart,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import { useNotificationCenter } from "@/hooks/useNotificationCenter";
import { AppNotification, NotificationCategory } from "@/lib/watchlist";
import { formatRelativeTime } from "@/lib/format";

const CATEGORY_ICON: Record<NotificationCategory, React.ReactNode> = {
  AUCTION_ENDING: <Gavel size={14} className="text-terracotta-400" />,
  OFFER_CHANGE: <Tag size={14} className="text-brand-400" />,
  LISTING_CHANGE: <ShoppingCart size={14} className="text-mint-400" />,
  TX_CONFIRMED: <RefreshCw size={14} className="text-green-400" />,
};

const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  AUCTION_ENDING: "Auction Ending",
  OFFER_CHANGE: "Offer Changes",
  LISTING_CHANGE: "Listing Changes",
  TX_CONFIRMED: "Transaction Confirmed",
};

function NotificationRow({
  notif,
  onRead,
}: {
  notif: AppNotification;
  onRead: (id: string) => void;
}) {
  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 border-b border-white/5 hover:bg-white/5 transition-colors ${
        notif.isRead ? "opacity-60" : ""
      }`}
      data-testid={`notification-${notif.id}`}
    >
      <div className="mt-0.5 shrink-0">{CATEGORY_ICON[notif.category]}</div>
      <div className="flex-1 min-w-0">
        <Link
          href={notif.href}
          onClick={() => onRead(notif.id)}
          className="text-sm font-semibold text-white hover:text-brand-400 transition-colors leading-snug"
        >
          {notif.title}
        </Link>
        <p className="text-xs text-gray-400 mt-0.5 leading-snug">{notif.body}</p>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[10px] text-gray-500">
            {formatRelativeTime(notif.receivedAt)}
          </span>
          {notif.isStale && (
            <span className="flex items-center gap-1 text-[10px] text-amber-400">
              <AlertTriangle size={9} />
              May be outdated
            </span>
          )}
        </div>
      </div>
      {!notif.isRead && (
        <button
          type="button"
          onClick={() => onRead(notif.id)}
          className="mt-0.5 shrink-0 p-1 rounded-lg hover:bg-white/10 transition-colors"
          aria-label="Mark as read"
        >
          <X size={12} className="text-gray-400" />
        </button>
      )}
    </div>
  );
}

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const {
    notifications,
    unreadCount,
    prefs,
    sseConnected,
    markRead,
    markAllRead,
    updatePref,
  } = useNotificationCenter();

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  return (
    <div className="relative" ref={panelRef}>
      {/* Bell button */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative flex items-center justify-center w-9 h-9 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
        aria-label={
          unreadCount > 0
            ? `${unreadCount} unread notifications`
            : "Notifications"
        }
        data-testid="notification-bell"
      >
        <Bell size={16} className="text-white/70" />
        {unreadCount > 0 && (
          <span
            className="absolute -top-1 -right-1 flex items-center justify-center w-4 h-4 rounded-full bg-terracotta-500 text-[9px] font-bold text-white"
            aria-hidden="true"
            data-testid="notification-badge"
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          className="absolute right-0 top-full mt-3 w-80 rounded-2xl border border-white/10 bg-midnight-900 shadow-2xl shadow-midnight-950/50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200"
          data-testid="notification-panel"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
            <div className="flex items-center gap-2">
              <Bell size={14} className="text-brand-400" />
              <span className="text-sm font-bold text-white">Notifications</span>
              {sseConnected ? (
                <span className="w-1.5 h-1.5 rounded-full bg-mint-400" title="Live" />
              ) : (
                <span className="w-1.5 h-1.5 rounded-full bg-gray-500" title="Offline" />
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowPrefs((v) => !v)}
                className="text-[11px] text-gray-400 hover:text-white transition-colors"
                data-testid="notification-prefs-toggle"
              >
                {showPrefs ? "Hide settings" : "Settings"}
              </button>
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  className="flex items-center gap-1 text-[11px] text-brand-400 hover:text-brand-300 transition-colors"
                  data-testid="mark-all-read-btn"
                >
                  <CheckCheck size={11} />
                  All read
                </button>
              )}
            </div>
          </div>

          {/* Category preferences */}
          {showPrefs && (
            <div className="px-4 py-3 border-b border-white/10 space-y-2 bg-midnight-950/50">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">
                Opt-in notifications
              </p>
              {(Object.keys(CATEGORY_LABELS) as NotificationCategory[]).map(
                (cat) => (
                  <div key={cat} className="flex items-center justify-between">
                    <span className="text-xs text-gray-300">
                      {CATEGORY_LABELS[cat]}
                    </span>
                    <button
                      type="button"
                      onClick={() => updatePref(cat, !prefs[cat])}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                        prefs[cat] ? "bg-brand-500" : "bg-gray-600"
                      }`}
                      data-testid={`pref-toggle-${cat}`}
                      aria-pressed={prefs[cat]}
                      aria-label={`${prefs[cat] ? "Disable" : "Enable"} ${CATEGORY_LABELS[cat]}`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                          prefs[cat] ? "translate-x-4.5" : "translate-x-0.5"
                        }`}
                      />
                    </button>
                  </div>
                )
              )}
              <p className="text-[10px] text-gray-500 pt-1 leading-snug">
                Notifications are generated locally from live events for items
                you watch. No data is sent to a server.
              </p>
            </div>
          )}

          {/* Notification list */}
          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                <BellOff size={28} className="text-gray-600" />
                <p className="text-sm font-medium text-gray-500">No notifications yet.</p>
                <p className="text-xs text-gray-600 max-w-[200px]">
                  Watch a listing, auction, or artist to get live updates here.
                </p>
              </div>
            ) : (
              notifications.map((n) => (
                <NotificationRow key={n.id} notif={n} onRead={markRead} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
