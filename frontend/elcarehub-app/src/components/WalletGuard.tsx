// ─────────────────────────────────────────────────────────────────────────────
// components/WalletGuard.tsx — Gated access wrapper
//
// Changes (network-mismatch + a11y pass):
//   - WalletGuard default fallback now uses role="region" + aria-label
//   - Wrong-network state renders WrongNetworkBanner (with guided steps)
//     instead of a bare text line
//   - aria-live="polite" region announces network status to AT users
//   - GuardButton has aria-label derived from actionName, aria-disabled,
//     and aria-busy during any active tx lifecycle
//   - Focus is returned to the trigger element after the modal closes
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useWalletContext } from "@/context/WalletContext";
import { ConnectWalletModal } from "./ConnectWalletModal";
import { WrongNetworkBanner } from "./WalletErrorDisplay";
import { networkStatusLabel } from "@/lib/networkStatus";
import { useState, useRef, ReactNode, useCallback } from "react";
import { Wallet } from "lucide-react";

// ── WalletGuard ───────────────────────────────────────────────────────────────

interface WalletGuardProps {
  children: ReactNode;
  fallback?: ReactNode;
  actionName?: string;
  hideContentWhenDisconnected?: boolean;
}

export function WalletGuard({
  children,
  fallback,
  actionName = "To perform this action",
  hideContentWhenDisconnected = false,
}: WalletGuardProps) {
  const {
    isConnected,
    isWrongNetwork,
    networkStatus,
    walletType,
    networkPassphrase,
    refresh,
    clearStaleDraft,
  } = useWalletContext();

  const [isModalOpen, setIsModalOpen]         = useState(false);
  const [isCheckingNetwork, setIsCheckingNetwork] = useState(false);
  // Ref to the "Connect Wallet" button so focus returns after modal closes
  const connectBtnRef = useRef<HTMLButtonElement>(null);

  const openModal  = useCallback(() => setIsModalOpen(true),  []);
  const closeModal = useCallback(() => {
    setIsModalOpen(false);
    // Return focus to the button that opened the modal
    connectBtnRef.current?.focus();
  }, []);

  const handleSwitchNetwork = useCallback(async () => {
    setIsCheckingNetwork(true);
    await refresh();
    setIsCheckingNetwork(false);
  }, [refresh]);

  const handleReadyToResimulate = useCallback(() => {
    clearStaleDraft();
  }, [clearStaleDraft]);

  // ── Connected + correct network → render children ─────────────────────────
  if (isConnected && !isWrongNetwork) {
    return (
      <>
        {children}
        <ConnectWalletModal isOpen={isModalOpen} onClose={closeModal} />
      </>
    );
  }

  // ── Wrong-network state ────────────────────────────────────────────────────
  if (isConnected && isWrongNetwork) {
    return (
      <>
        {/* Live region so screen readers announce the network problem */}
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {networkStatusLabel(networkStatus)}
        </div>

        <div
          role="region"
          aria-label="Wallet network error"
          className="space-y-3"
        >
          <WrongNetworkBanner
            provider={walletType ?? "unknown"}
            expectedPassphrase={undefined}
            detectedPassphrase={networkPassphrase}
            onSwitchNetwork={handleSwitchNetwork}
            onReadyToResimulate={handleReadyToResimulate}
            isCheckingNetwork={isCheckingNetwork}
          />
        </div>

        <ConnectWalletModal isOpen={isModalOpen} onClose={closeModal} />
      </>
    );
  }

  // ── Disconnected state ─────────────────────────────────────────────────────

  const handleProtectedAction = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openModal();
  };

  const defaultFallback = (
    <div
      role="region"
      aria-label="Wallet connection required"
      className="mt-24 border-none bg-brand-50/20 p-8 text-center transition-all hover:bg-brand-50/40"
    >
      {/* sr-only status keeps AT users informed */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {networkStatusLabel(networkStatus)}
      </div>

      <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-100 text-brand-600 scale-110">
        <Wallet size={32} aria-hidden="true" />
      </div>
      <h3 className="font-display font-bold text-midnight-900 text-xl">
        Wallet Connection Required
      </h3>
      <p className="mt-2 text-sm text-gray-500 max-w-xs mx-auto">
        {actionName}, you must connect your wallet on the correct network.
      </p>
      <p className="mt-1 text-xs text-gray-400 max-w-xs mx-auto">
        Public data like listings, auctions, and collections are still visible
        without a wallet.
      </p>
      <button
        ref={connectBtnRef}
        type="button"
        onClick={openModal}
        aria-label="Connect your wallet to continue"
        className="mt-6 inline-flex items-center gap-2 rounded-xl bg-brand-500 px-8 py-3.5 text-base font-bold text-white shadow-xl shadow-brand-500/30 hover:bg-brand-600 transition-all hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2"
      >
        <Wallet size={20} aria-hidden="true" />
        Connect Wallet
      </button>
    </div>
  );

  return (
    <>
      <div
        onClickCapture={handleProtectedAction}
        className={hideContentWhenDisconnected ? "hidden" : "contents"}
      >
        {fallback || (hideContentWhenDisconnected ? null : defaultFallback)}
      </div>
      <ConnectWalletModal isOpen={isModalOpen} onClose={closeModal} />
    </>
  );
}

// ── GuardButton ───────────────────────────────────────────────────────────────

/**
 * A button that opens the ConnectWalletModal when the wallet is not connected
 * or is on the wrong network, and fires onAction otherwise.
 *
 * A11y improvements:
 *   - aria-label includes the actionName so screen readers give context
 *   - aria-disabled set when wallet is not ready (not just HTML `disabled`)
 *   - aria-busy set while a tx is active (passed via `isLoading` prop)
 *   - Focus returns to this button after the modal closes
 */
interface GuardButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  actionName?: string;
  onAction?: (e: React.MouseEvent) => void;
  /** Set true while a transaction is in-flight to announce busy state to AT */
  isLoading?: boolean;
}

export function GuardButton({
  children,
  actionName,
  onAction,
  className,
  isLoading = false,
  disabled,
  ...props
}: GuardButtonProps) {
  const { isConnected, isWrongNetwork, networkStatus } = useWalletContext();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const walletReady = isConnected && !isWrongNetwork;

  const closeModal = useCallback(() => {
    setIsModalOpen(false);
    buttonRef.current?.focus();
  }, []);

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!walletReady) {
      e.preventDefault();
      e.stopPropagation();
      setIsModalOpen(true);
      return;
    }
    onAction?.(e);
  };

  // Build an aria-label that announces wallet state when the button cannot act
  const baseLabel = actionName
    ? `${actionName}: `
    : "";
  const statusSuffix = !walletReady
    ? ` — ${networkStatusLabel(networkStatus)}`
    : "";
  const ariaLabel = props["aria-label"]
    ?? (baseLabel || statusSuffix
      ? `${baseLabel}${typeof children === "string" ? children : ""}${statusSuffix}`.trim()
      : undefined);

  return (
    <>
      <button
        {...props}
        ref={buttonRef}
        onClick={handleClick}
        disabled={disabled || isLoading}
        aria-disabled={disabled || isLoading || !walletReady || undefined}
        aria-busy={isLoading || undefined}
        aria-label={ariaLabel}
        className={className}
      >
        {children}
      </button>
      <ConnectWalletModal isOpen={isModalOpen} onClose={closeModal} />
    </>
  );
}
