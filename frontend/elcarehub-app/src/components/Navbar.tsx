// ─────────────────────────────────────────────────────────────
// components/Navbar.tsx — Primary navigation
//
// Implements: active link highlighting, signed-in/signed-out
// states, keyboard and screen-reader accessibility, mobile menu
// with focus-trap, and aria-current for the active route.
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWalletContext } from "@/context/WalletContext";
import {
  Wallet,
  Store,
  LayoutDashboard,
  Menu,
  X,
  AlertTriangle,
  ShieldCheck,
  Tag,
  Inbox,
  Compass,
  User,
  Gavel,
  Settings,
  HelpCircle,
  Rocket,
  ChevronDown,
  Activity,
} from "lucide-react";
import { ConnectWalletModal } from "./ConnectWalletModal";
import { WalletMenu } from "./WalletMenu";
import { NotificationCenter } from "./NotificationCenter";

// ── Nav item definitions ──────────────────────────────────────

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  /** If true, only render when wallet is connected */
  requiresAuth?: boolean;
  /** Match sub-paths too (e.g. /listings/123 matches /explore) */
  matchPrefix?: string;
}

const PUBLIC_NAV: NavItem[] = [
  { href: "/", label: "Marketplace", icon: <Store size={15} />, matchPrefix: "/" },
  { href: "/explore", label: "Discover", icon: <Compass size={15} />, matchPrefix: "/explore" },
  { href: "/auctions", label: "Auctions", icon: <Gavel size={15} />, matchPrefix: "/auctions" },
  { href: "/launchpad", label: "Launchpad", icon: <Rocket size={15} />, matchPrefix: "/launchpad" },
  { href: "/activity", label: "Activity", icon: <Activity size={15} />, matchPrefix: "/activity" },
];

const AUTH_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: <LayoutDashboard size={15} />, requiresAuth: true, matchPrefix: "/dashboard" },
  { href: "/profile", label: "My Collection", icon: <User size={15} />, requiresAuth: true, matchPrefix: "/profile" },
  { href: "/offers", label: "Offers", icon: <Tag size={15} />, requiresAuth: true, matchPrefix: "/offers" },
  { href: "/offers/incoming", label: "Inbox", icon: <Inbox size={15} />, requiresAuth: true, matchPrefix: "/offers/incoming" },
];

// ── Helper: is a given path "active"? ────────────────────────

function useIsActive(item: NavItem) {
  const pathname = usePathname();
  if (item.href === "/") {
    return pathname === "/";
  }
  const prefix = item.matchPrefix ?? item.href;
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

// ── Single desktop link ───────────────────────────────────────

function DesktopNavLink({ item }: { item: NavItem }) {
  const active = useIsActive(item);
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-1.5 text-sm font-medium transition-colors duration-200 ${
        active
          ? "text-brand-400 font-semibold"
          : "text-white/65 hover:text-white"
      }`}
    >
      <span aria-hidden="true">{item.icon}</span>
      {item.label}
      {active && (
        <span className="sr-only">(current page)</span>
      )}
    </Link>
  );
}

// ── Single mobile link ────────────────────────────────────────

function MobileNavLink({
  item,
  onClick,
}: {
  item: NavItem;
  onClick: () => void;
}) {
  const active = useIsActive(item);
  return (
    <Link
      href={item.href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-base font-medium transition-colors ${
        active
          ? "bg-brand-500/15 text-brand-300"
          : "text-white/75 hover:bg-white/5 hover:text-white"
      }`}
    >
      <span
        aria-hidden="true"
        className={active ? "text-brand-400" : "text-white/40"}
      >
        {item.icon}
      </span>
      {item.label}
    </Link>
  );
}

// ── Navbar ────────────────────────────────────────────────────

export function Navbar() {
  const {
    publicKey,
    isConnected,
    isConnecting,
    disconnect,
    isWrongNetwork,
    balance,
    isLoadingBalance,
  } = useWalletContext();

  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [showWalletMenu, setShowWalletMenu] = useState(false);

  const walletMenuRef = useRef<HTMLDivElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);

  const shortKey = publicKey
    ? `${publicKey.slice(0, 4)}…${publicKey.slice(-4)}`
    : null;

  // Transparent → solid on scroll
  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 60);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // Close wallet dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        walletMenuRef.current &&
        !walletMenuRef.current.contains(e.target as Node)
      ) {
        setShowWalletMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Close mobile menu on Escape; restore focus to hamburger
  const closeMobile = useCallback(() => {
    setMobileOpen(false);
    hamburgerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMobile();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [mobileOpen, closeMobile]);

  // Prevent body scroll when mobile menu is open
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [mobileOpen]);

  const visibleAuthNav = isConnected ? AUTH_NAV : [];
  const allDesktopItems = [...PUBLIC_NAV, ...visibleAuthNav];

  return (
    <>
      <nav
        role="navigation"
        aria-label="Primary navigation"
        className={`fixed top-0 left-0 right-0 z-50 transition-all duration-500 ${
          scrolled
            ? "bg-midnight-800/95 backdrop-blur-xl border-b border-brand-500/10 shadow-lg shadow-midnight-950/40"
            : "bg-transparent"
        }`}
      >
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 sm:px-6 py-4">

          {/* Logo */}
          <Link
            href="/"
            aria-label="ElcareHub home"
            className="flex items-center gap-2.5 group shrink-0"
          >
            <span
              aria-hidden="true"
              className="flex items-center justify-center w-10 h-10 rounded-xl bg-brand-500 shadow-lg shadow-brand-500/30 group-hover:shadow-brand-500/50 transition-all duration-300 group-hover:scale-105"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="9" y="2" width="6" height="20" rx="2" fill="white"/>
                <rect x="2" y="9" width="20" height="6" rx="2" fill="white"/>
                <circle cx="12" cy="12" r="2.5" fill="#E27D60"/>
              </svg>
            </span>
            <span className="text-xl font-display font-bold text-white tracking-tight">
              Elcare<span className="text-brand-400">Hub</span>
            </span>
          </Link>

          {/* Desktop nav links */}
          <div
            role="menubar"
            aria-label="Main menu"
            className="hidden md:flex items-center gap-6 text-sm"
          >
            {allDesktopItems.map((item) => (
              <DesktopNavLink key={item.href} item={item} />
            ))}
          </div>

          {/* Desktop wallet area */}
          <div className="hidden md:flex items-center gap-3">
            {isConnected ? (
              <>
                {isWrongNetwork ? (
                  <button
                    onClick={() => setIsModalOpen(true)}
                    aria-label="Wrong network — click to reconnect"
                    className="flex items-center gap-2 rounded-full bg-terracotta-500/20 border border-terracotta-500/30 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-terracotta-400 hover:bg-terracotta-500/30 transition-all"
                  >
                    <AlertTriangle size={12} aria-hidden="true" />
                    Wrong Network
                  </button>
                ) : (
                  <span className="flex items-center gap-2 rounded-full bg-mint-500/10 border border-mint-500/20 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-mint-400">
                    <ShieldCheck size={12} aria-hidden="true" />
                    Connected
                  </span>
                )}

                {/* Wallet menu trigger */}
                <div className="relative" ref={walletMenuRef}>
                  <button
                    data-testid="wallet-connected"
                    onClick={() => setShowWalletMenu((v) => !v)}
                    aria-haspopup="true"
                    aria-expanded={showWalletMenu}
                    aria-label={`Wallet ${shortKey} — click to open wallet menu`}
                    className="flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    <div className="flex flex-col items-end">
                      <span className="text-[10px] font-bold text-white/40 uppercase tracking-tighter">Wallet</span>
                      <span className="text-xs font-mono text-white/90 leading-none">{shortKey}</span>
                    </div>
                    <div className="h-6 w-px bg-white/10 mx-1" />
                    <ChevronDown
                      size={14}
                      aria-hidden="true"
                      className={`text-white/40 transition-transform duration-300 ${showWalletMenu ? "rotate-180" : ""}`}
                    />
                  </button>

                  {showWalletMenu && (
                    <div
                      role="menu"
                      aria-label="Wallet options"
                      className="absolute top-full right-0 mt-3 w-64 animate-in fade-in slide-in-from-top-2 duration-200"
                    >
                      <WalletMenu
                        address={publicKey!}
                        balance={balance}
                        isLoadingBalance={isLoadingBalance}
                        onDisconnect={() => {
                          disconnect();
                          setShowWalletMenu(false);
                        }}
                      />
                    </div>
                  )}
                </div>
              </>
            ) : (
              <button
                onClick={() => setIsModalOpen(true)}
                disabled={isConnecting}
                className="flex items-center gap-2.5 rounded-xl bg-gradient-to-r from-brand-500 to-terracotta-500 px-6 py-2.5 text-sm font-bold text-white shadow-lg shadow-brand-500/25 hover:shadow-brand-500/40 hover:-translate-y-0.5 active:translate-y-0 transition-all duration-300 disabled:opacity-60"
              >
                <Wallet size={16} aria-hidden="true" />
                {isConnecting ? "Connecting…" : "Connect Wallet"}
              </button>
            )}

            {/* Always-visible utility links */}
            <Link
              href="/settings"
              aria-label="Settings"
              className="flex items-center justify-center w-8 h-8 rounded-lg text-white/40 hover:text-white/80 hover:bg-white/5 transition-colors"
            >
              <Settings size={16} aria-hidden="true" />
              <span className="sr-only">Settings</span>
            </Link>
            <Link
              href="/help"
              aria-label="Help"
              className="flex items-center justify-center w-8 h-8 rounded-lg text-white/40 hover:text-white/80 hover:bg-white/5 transition-colors"
            >
              <HelpCircle size={16} aria-hidden="true" />
              <span className="sr-only">Help</span>
            </Link>
          </div>

          {/* Mobile hamburger */}
          <button
            ref={hamburgerRef}
            onClick={() => setMobileOpen((v) => !v)}
            aria-expanded={mobileOpen}
            aria-controls="mobile-menu"
            aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
            className="md:hidden flex items-center justify-center w-10 h-10 rounded-xl bg-white/5 text-white/70 hover:bg-white/10 border border-white/10 transition-all"
          >
            {mobileOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
          </button>
        </div>

        {/* Mobile drawer */}
        <div
          id="mobile-menu"
          ref={mobileMenuRef}
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          aria-hidden={!mobileOpen}
          className={`md:hidden overflow-hidden transition-all duration-300 ${
            mobileOpen ? "max-h-[calc(100vh-5rem)] opacity-100" : "max-h-0 opacity-0 pointer-events-none"
          }`}
        >
          <div className="bg-midnight-950/98 backdrop-blur-xl border-t border-white/5 px-4 py-6 overflow-y-auto max-h-[calc(100vh-5rem)]">

            {/* Public links */}
            <div className="space-y-1 mb-6">
              <p className="px-3 mb-2 text-[10px] uppercase tracking-widest font-bold text-white/25">
                Discover
              </p>
              {PUBLIC_NAV.map((item) => (
                <MobileNavLink key={item.href} item={item} onClick={closeMobile} />
              ))}
            </div>

            {/* Auth-gated links */}
            {isConnected && (
              <div className="space-y-1 mb-6">
                <p className="px-3 mb-2 text-[10px] uppercase tracking-widest font-bold text-white/25">
                  My Account
                </p>
                {AUTH_NAV.map((item) => (
                  <MobileNavLink key={item.href} item={item} onClick={closeMobile} />
                ))}
              </div>
            )}

            {/* Settings / Help */}
            <div className="space-y-1 mb-6">
              <p className="px-3 mb-2 text-[10px] uppercase tracking-widest font-bold text-white/25">
                More
              </p>
              {[
                { href: "/settings", label: "Settings", icon: <Settings size={15} /> },
                { href: "/help", label: "Help & FAQ", icon: <HelpCircle size={15} /> },
              ].map((item) => (
                <MobileNavLink
                  key={item.href}
                  item={item as NavItem}
                  onClick={closeMobile}
                />
              ))}
            </div>

            {/* Wallet section */}
            <div className="pt-4 border-t border-white/5">
              {isConnected ? (
                <>
                  {isWrongNetwork && (
                    <div className="flex items-center gap-2 rounded-xl bg-terracotta-500/10 border border-terracotta-500/20 px-3 py-2 mb-4 text-xs font-semibold text-terracotta-400">
                      <AlertTriangle size={14} aria-hidden="true" />
                      Wrong network — please reconnect
                    </div>
                  )}
                  <WalletMenu
                    address={publicKey!}
                    balance={balance}
                    isLoadingBalance={isLoadingBalance}
                    onDisconnect={() => {
                      disconnect();
                      closeMobile();
                    }}
                  />
                </>
              ) : (
                <div>
                  <p className="px-3 mb-3 text-[10px] uppercase tracking-widest font-bold text-white/25">
                    Wallet
                  </p>
                  <p className="px-3 mb-4 text-xs text-white/40">
                    Connect your wallet to access your dashboard, manage listings, and place bids.
                  </p>
                  <button
                    onClick={() => {
                      setIsModalOpen(true);
                      closeMobile();
                    }}
                    disabled={isConnecting}
                    className="w-full flex items-center justify-center gap-2.5 rounded-xl bg-brand-500 py-4 text-base font-bold text-white shadow-xl shadow-brand-500/20 disabled:opacity-60"
                  >
                    <Wallet size={20} aria-hidden="true" />
                    {isConnecting ? "Connecting…" : "Connect Wallet"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </nav>

      <ConnectWalletModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
      />
    </>
  );
}
