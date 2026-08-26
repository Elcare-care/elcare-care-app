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
  Layers,
  ArrowUpDown,
  Zap,
  Activity,
} from "lucide-react";
import { useNotificationCenter } from "@/hooks/useNotificationCenter";
import {
  AppNotification,
  NotificationCategory,
  NotificationPriority,
  CATEGORY_LABELS,
  CATEGORY_PRIORITY,
} from "@/lib/watchlist";
import { formatRelativeTime } from "@/lib/format";

// ── Category icons ────────────────────────────────────────────────────────────

const CATEGORY_ICON: Record<NotificationCategory, React.ReactNode> = {
  AUCTION_ENDING:        <Gavel       size={13} className="text-terracotta-400" />,
  AUCTION_FINALIZED:     <Gavel       size={13} className="text-terracotta-400" />,
  OFFER_CHANGE:          <Tag         size={13} className="text-brand-400" />,
  OFFER_ACCEPTED:        <Tag         size={13} className="text-green-400" />,
  OFFER_WITHDRAWN:       <Tag         size={13} className="text-gray-400" />,
  LISTING_CHANGE:        <ShoppingCart size={13} className="text-mint-400" />,
  LISTING_SOLD:          <ShoppingCart size={13} className="text-green-400" />,
  LISTING_PRICE_UPDATED: <ArrowUpDown size={13} className="text-amber-400" />,
  TX_CONFIRMED:          <RefreshCw   size={13} className="text-green-400" />,
  COLLECTION_DEPLOYED:   <Layers      size={13} className="text-purple-400" />,
  BID_PLACED:            <Activity    size={13} className="text-brand-400" />,
};

// ── Priority accent ───────────────────────────────────────────────────────────

const PRIORITY_DOT: Record<NotificationPriority, string> = {
  HIGH:   "bg-red-400",
  MEDIUM: "bg-amber-400",
  LOW:    "bg-gray-500",
};

const PRIORITY_BORDER: Record<NotificationPriority, string> = {
  HIGH:   "border-l-2 border-l-red-500/60",
  MEDIUM: "border-l-2 border-l-amber-500/40",
  LOW:    "",
};

// ── NotificationRow ───────────────────────────────────────────────────────────

function NotificationRow({
  notif,
  onRead,
}: {
  notif: AppNotification;
  onRead: (id: string) => void;
}) {
  const priority = CATEGORY_PRIORITY[notif.category] ?? "LOW";

  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 border-b border-white/5 hover:bg-white/5 transition-colors ${
        notif.isRead ? "opacity-55" : ""
      } ${PRIORITY_BORDER[priority]}`}
      data-testid={`notification-${notif.id}`}
    >
      {/* Priority dot + category icon */}
      <div className="mt-0.5 shrink-0 relative">
        {CATEGORY_ICON[notif.category]}
        {!notif.isRead && priority === "HIGH" && (
          <span
            className={`absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ${PRIORITY_DOT[priority]}`}
            aria-hidden="true"
          />
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-w-0">
        <Link
          href={notif.href}
          onClick={() => onRead(notif.id)}
          className="text-sm font-semibold text-white hover:text-brand-400 transition-colors leading-snug"
        >
          {notif.title}
        </Link>
        <p className="text-xs text-gray-400 mt-0.5 leading-snug">{notif.body}</p>

        {/* Amount chip (bids / offers / sales) */}
        {notif.amount && (
          <span className="inline-block mt-1 text-[10px] font-mono bg-white/5 text-white/70 px-1.5 py-0.5 rounded">
            {notif.amount}
          </span>
        )}

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
          {/* HIGH-priority inline action */}
          {!notif.isRead && priority === "HIGH" && (
            <Link
              href={notif.href}
              onClick={() => onRead(notif.id)}
              className="text-[10px] text-brand-400 hover:text-brand-300 transition-colors font-medium"
            >
              View →
            </Link>
          )}
        </div>
      </div>

      {/* Mark read button */}
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

// ── Priority section header ───────────────────────────────────────────────────

function PrioritySection({
  priority,
  items,
  onRead,
}: {
  priority: NotificationPriority;
  items: AppNotification[];
  onRead: (id: string) => void;
}) {
  if (items.length === 0) return null;
  const labels: Record<NotificationPriority, string> = {
    HIGH:   "Important",
    MEDIUM: "Updates",
    LOW:    "Info",
  };
  const iconCls: Record<NotificationPriority, string> = {
    HIGH:   "text-red-400",
    MEDIUM: "text-amber-400",
    LOW:    "text-gray-500",
  };
  return (
    <>
      <div className="flex items-center gap-1.5 px-4 pt-2.5 pb-1">
        <Zap size={10} className={iconCls[priority]} />
        <span className="text-[9px] font-bold text-gray-500 uppercase tracking-widest">
          {labels[priority]}
        </span>
      </div>
      {items.map((n) => (
        <NotificationRow key={n.id} notif={n} onRead={onRead} />
      ))}
    </>
  );
}

// ── Preference groups for the settings panel ──────────────────────────────────

const PREF_GROUPS: { label: string; categories: NotificationCategory[] }[] = [
  {
    label: "Auctions",
    categories: ["AUCTION_ENDING", "AUCTION_FINALIZED", "BID_PLACED"],
  },
  {
    label: "Offers",
    categories: ["OFFER_ACCEPTED", "OFFER_WITHDRAWN", "OFFER_CHANGE"],
  },
  {
    label: "Listings",
    categories: ["LISTING_SOLD", "LISTING_CHANGE", "LISTING_PRICE_UPDATED"],
  },
  {
    label: "Other",
    categories: ["TX_CONFIRMED", "COLLECTION_DEPLOYED"],
  },
];

// ── NotificationCenter ────────────────────────────────────────────────────────

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

  // Partition unread by priority, read after
  const unread = notifications.filter((n) => !n.isRead);
  const read   = notifications.filter((n) =>  n.isRead);
  const highUnread   = unread.filter((n) => CATEGORY_PRIORITY[n.category] === "HIGH");
  const mediumUnread = unread.filter((n) => CATEGORY_PRIORITY[n.category] === "MEDIUM");
  const lowUnread    = unread.filter((n) => CATEGORY_PRIORITY[n.category] === "LOW");

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
            className={`absolute -top-1 -right-1 flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-bold text-white ${
              highUnread.length > 0 ? "bg-red-500 animate-pulse" : "bg-terracotta-500"
            }`}
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
          className="absolute right-0 top-full mt-3 w-84 rounded-2xl border border-white/10 bg-midnight-900 shadow-2xl shadow-midnight-950/50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200"
          style={{ width: "22rem" }}
          data-testid="notification-panel"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
            <div className="flex items-center gap-2">
              <Bell size={14} className="text-brand-400" />
              <span className="text-sm font-bold text-white">Notifications</span>
              {/* SSE live indicator */}
              {sseConnected ? (
                <span className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-mint-400 animate-pulse" />
                  <span className="text-[10px] text-mint-400">Live</span>
                </span>
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
            <div className="px-4 py-3 border-b border-white/10 space-y-3 bg-midnight-950/60 max-h-64 overflow-y-auto">
              {PREF_GROUPS.map((group) => (
                <div key={group.label}>
                  <p className="text-[9px] font-bold text-gray-500 uppercase tracking-wider mb-1.5">
                    {group.label}
                  </p>
                  <div className="space-y-1.5">
                    {group.categories.map((cat) => (
                      <div key={cat} className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="shrink-0">{CATEGORY_ICON[cat]}</span>
                          <span className="text-xs text-gray-300 truncate">
                            {CATEGORY_LABELS[cat]}
                          </span>
                          {CATEGORY_PRIORITY[cat] === "HIGH" && (
                            <span className="shrink-0 text-[9px] bg-red-500/20 text-red-400 px-1 rounded">
                              high
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => updatePref(cat, !prefs[cat])}
                          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                            prefs[cat] ? "bg-brand-500" : "bg-gray-600"
                          }`}
                          data-testid={`pref-toggle-${cat}`}
                          aria-pressed={prefs[cat]}
                          aria-label={`${prefs[cat] ? "Disable" : "Enable"} ${CATEGORY_LABELS[cat]}`}
                        >
                          <span
                            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                              prefs[cat] ? "translate-x-[1.125rem]" : "translate-x-0.5"
                            }`}
                          />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <p className="text-[10px] text-gray-600 pt-1 leading-snug">
                Notifications are generated locally from live events for items
                you watch. No data leaves your browser.
              </p>
            </div>
          )}

          {/* Notification list */}
          <div className="max-h-[22rem] overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                <BellOff size={28} className="text-gray-600" />
                <p className="text-sm font-medium text-gray-500">No notifications yet.</p>
                <p className="text-xs text-gray-600 max-w-[210px]">
                  Watch a listing, auction, or artist to get live updates here.
                </p>
              </div>
            ) : (
              <>
                {/* Unread — partitioned by priority */}
                <PrioritySection priority="HIGH"   items={highUnread}   onRead={markRead} />
                <PrioritySection priority="MEDIUM" items={mediumUnread} onRead={markRead} />
                <PrioritySection priority="LOW"    items={lowUnread}    onRead={markRead} />
                {/* Read — shown dimmed below unread */}
                {read.length > 0 && unread.length > 0 && (
                  <div className="px-4 pt-2.5 pb-1">
                    <span className="text-[9px] font-bold text-gray-600 uppercase tracking-widest">
                      Earlier
                    </span>
                  </div>
                )}
                {read.slice(0, 10).map((n) => (
                  <NotificationRow key={n.id} notif={n} onRead={markRead} />
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
