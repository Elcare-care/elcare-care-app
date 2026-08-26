"use client";

/**
 * components/WalletMenu.tsx — Connected-state wallet dropdown
 *
 * A11y improvements:
 *   - Copy button has explicit aria-label that changes on success
 *   - Full address exposed via sr-only text so AT users can read it
 *   - Balance container has role="status" + aria-live="polite" so balance
 *     updates are announced without interrupting current speech
 *   - Loading state announces "Fetching balance" to AT
 *   - Disconnect button has an explicit aria-label
 *   - All icon-only controls have aria-hidden on the icon and visible/sr text
 */

import { useState } from "react";
import { Copy, Check, LogOut, Wallet, Loader2 } from "lucide-react";

interface WalletMenuProps {
  address: string;
  balance: string | null;
  isLoadingBalance: boolean;
  onDisconnect: () => void;
  className?: string;
}

export function WalletMenu({
  address,
  balance,
  isLoadingBalance,
  onDisconnect,
  className = "",
}: WalletMenuProps) {
  const [copied, setCopied] = useState(false);

  const truncatedAddress = `${address.slice(0, 4)}...${address.slice(-4)}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(address).catch(() => {
      // Clipboard API may be unavailable in some browsers — fail silently
    });
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={`flex flex-col gap-2 p-4 bg-midnight-900/50 backdrop-blur-md border border-white/10 rounded-2xl shadow-xl ${className}`}
    >
      {/* Address & Copy */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <div
            className="p-2 rounded-lg bg-brand-500/20 text-brand-400"
            aria-hidden="true"
          >
            <Wallet size={16} aria-hidden="true" />
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-widest text-white/40 font-bold">
              Wallet Address
            </p>
            {/* Visible truncated address + sr-only full address */}
            <p
              className="text-sm font-mono text-white/90"
              aria-hidden="true"
            >
              {truncatedAddress}
            </p>
            <span className="sr-only">Full wallet address: {address}</span>
          </div>
        </div>

        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? "Address copied to clipboard" : "Copy wallet address to clipboard"}
          aria-pressed={copied}
          className="p-2 rounded-lg bg-white/5 text-white/60 hover:bg-white/10 hover:text-white transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-1 focus-visible:ring-offset-midnight-900"
        >
          {copied ? (
            <Check size={16} className="text-mint-400" aria-hidden="true" />
          ) : (
            <Copy size={16} aria-hidden="true" />
          )}
        </button>
      </div>

      {/* Balance — role="status" so updates are announced politely */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={
          isLoadingBalance
            ? "Fetching balance"
            : `Available balance: ${
                balance
                  ? parseFloat(balance).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 7,
                    })
                  : "0.00"
              } XLM`
        }
        className="mt-2 p-3 rounded-xl bg-white/5 border border-white/5"
      >
        <p className="text-[10px] uppercase tracking-widest text-white/40 font-bold mb-1">
          Available Balance
        </p>
        <div className="flex items-baseline gap-1.5">
          {isLoadingBalance ? (
            <div className="flex items-center gap-2 text-white/60">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              {/* sr-only text so screen readers say something meaningful */}
              <span className="text-sm font-medium italic" aria-hidden="true">
                Fetching…
              </span>
              <span className="sr-only">Fetching balance, please wait.</span>
            </div>
          ) : (
            <>
              <span
                className="text-xl font-display font-bold text-white"
                aria-hidden="true"
              >
                {balance
                  ? parseFloat(balance).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 7,
                    })
                  : "0.00"}
              </span>
              <span
                className="text-xs font-bold text-brand-400"
                aria-hidden="true"
              >
                XLM
              </span>
            </>
          )}
        </div>
      </div>

      {/* Disconnect */}
      <button
        type="button"
        onClick={onDisconnect}
        aria-label="Disconnect wallet and end session"
        className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-terracotta-500/10 py-2.5 text-sm font-bold text-terracotta-400 hover:bg-terracotta-500/20 border border-terracotta-500/20 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta-400 focus-visible:ring-offset-1 focus-visible:ring-offset-midnight-900"
      >
        <LogOut size={16} aria-hidden="true" />
        Disconnect Wallet
      </button>
    </div>
  );
}
