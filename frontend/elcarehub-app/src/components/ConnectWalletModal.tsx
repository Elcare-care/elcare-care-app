// components/ConnectWalletModal.tsx — Wallet chooser: Freighter · Lobstr · Magic
//
// A11y + network-mismatch pass:
//   - useModalA11y already provides focus trap + Escape key
//   - Focus returns to the trigger element on close (caller's responsibility;
//     WalletGuard and GuardButton pass a ref-based onClose for this)
//   - WalletRow button has aria-label, aria-busy, aria-describedby wired to
//     its error panel
//   - WRONG_NETWORK surfaces NetworkSwitchPanel inline inside the row with a
//     post-switch re-simulate step
//   - StatusAnnouncer covers all live-region announcements (connect, error,
//     account-change) — one region per dialog
//   - Connected state announces the public key to screen readers via sr-only
"use client";

import { useEffect, useState, useCallback, useId } from "react";
import { useWalletContext } from "@/context/WalletContext";
import {
  X, Wallet, ExternalLink, ShieldCheck,
  ArrowRight, Loader2, CheckCircle2, Mail,
} from "lucide-react";
import { config } from "@/lib/config";
import { MagicWalletModal } from "./MagicWalletModal";
import { useModalA11y } from "@/hooks/useModalA11y";
import { StatusAnnouncer } from "@/components/a11y/StatusAnnouncer";
import { WalletErrorDisplay } from "@/components/WalletErrorDisplay";
import { normalizeWalletError } from "@/lib/wallet-adapter";
import type { WalletAdapterError } from "@/lib/wallet-adapter";
import type { WalletProviderName } from "@/lib/networkStatus";
import posthog from "posthog-js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ConnectWalletModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type Choosing = "idle" | "freighter" | "lobstr" | "magic";

interface ProviderErrors {
  freighter: WalletAdapterError | null;
  lobstr:    WalletAdapterError | null;
  magic:     WalletAdapterError | null;
}

// ── Lobstr SVG ────────────────────────────────────────────────────────────────

function LobstrLogo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="512" height="512" rx="100" fill="#0B1E3E" />
      <path d="M256 96C167.6 96 96 167.6 96 256s71.6 160 160 160
               160-71.6 160-160S344.4 96 256 96zm0 280
               c-66.3 0-120-53.7-120-120s53.7-120 120-120
               120 53.7 120 120-53.7 120-120 120z" fill="#FBBF24" />
      <circle cx="256" cy="256" r="50" fill="#FBBF24" />
    </svg>
  );
}

// ── WalletRow ─────────────────────────────────────────────────────────────────
//
// Three visual modes:
//   not-installed  → install link (not a submit button)
//   connecting     → spinner + "Check your wallet…" hint
//   ready / error  → connect button + optional error panel

interface WalletRowProps {
  name:           string;
  tagline:        string;
  icon:           React.ReactNode;
  isInstalled:    boolean;
  isConnecting:   boolean;
  disabled:       boolean;
  installHref:    string;
  installHint:    string;
  error:          WalletAdapterError | null;
  accent:         "brand" | "amber";
  provider:       WalletProviderName;
  onConnect:      () => void;
  onRetry:        () => void;
  onSwitchNetwork: () => void;
  onReadyToResimulate?: () => void;
  isCheckingNetwork?: boolean;
  "data-testid"?: string;
}

function WalletRow({
  name, tagline, icon,
  isInstalled, isConnecting, disabled,
  installHref, installHint,
  error, accent, provider,
  onConnect, onRetry, onSwitchNetwork, onReadyToResimulate,
  isCheckingNetwork,
  "data-testid": tid,
}: WalletRowProps) {
  // Each row gets a stable id for aria-describedby linking
  const errorPanelId = useId();

  const border  = accent === "brand"
    ? "hover:border-brand-300 hover:bg-brand-50/30"
    : "hover:border-amber-300 hover:bg-amber-50/30";
  const iconHov = accent === "brand"
    ? "group-hover:bg-brand-500 group-hover:text-white"
    : "group-hover:bg-[#0B1E3E]";
  const arrHov  = accent === "brand"
    ? "group-hover:text-brand-500"
    : "group-hover:text-amber-500";
  const iconBg  = accent === "brand"
    ? "bg-brand-100 text-brand-600"
    : "bg-[#0B1E3E]/10 text-[#0B1E3E]";

  if (!isInstalled) {
    return (
      <div data-testid={tid}
        className="rounded-2xl border-2 border-gray-100 p-4 flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gray-100 text-gray-400 flex-shrink-0"
          aria-hidden="true">
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-midnight-900">{name}</p>
          <p className="text-xs text-gray-500">Extension not detected</p>
          <p className="text-[11px] text-gray-400 mt-0.5 leading-tight">{installHint}</p>
        </div>
        <a href={installHref} target="_blank" rel="noopener noreferrer"
          className="shrink-0 flex items-center gap-1 text-xs font-bold text-brand-500 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-1 rounded"
          aria-label={`Install ${name} wallet extension (opens in new tab)`}>
          Install <ExternalLink size={12} aria-hidden="true" />
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onConnect}
        disabled={disabled}
        data-testid={tid}
        aria-label={
          isConnecting
            ? `Connecting to ${name}…`
            : error
            ? `${name}: ${error.message} — click to retry`
            : `Connect with ${name}`
        }
        aria-busy={isConnecting || undefined}
        aria-describedby={error ? errorPanelId : undefined}
        className={`group relative flex w-full items-center gap-4 rounded-2xl border-2 p-4 text-left transition-all duration-300 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2
          ${error ? "border-red-200 bg-red-50/20" : `border-gray-100 ${border}`}`}
      >
        <div className={`flex h-12 w-12 items-center justify-center rounded-xl flex-shrink-0 transition-colors ${iconBg} ${iconHov}`}
          aria-hidden="true">
          {isConnecting
            ? <Loader2 size={24} className="animate-spin" aria-hidden="true" />
            : icon}
        </div>
        <div>
          <p className="font-bold text-midnight-900">{name}</p>
          <p className="text-xs text-gray-500">{tagline}</p>
          {isConnecting && (
            <p className="text-xs text-gray-400 mt-0.5" aria-live="polite">
              Check your wallet for an approval prompt…
            </p>
          )}
        </div>
        <ArrowRight size={18} aria-hidden="true"
          className={`absolute right-4 text-gray-300 ${arrHov} group-hover:translate-x-1 transition-all`} />
      </button>

      {error && (
        <div id={errorPanelId}>
          <WalletErrorDisplay
            error={error}
            provider={provider}
            onRetry={
              ["USER_REJECTED","SIGN_FAILED","UNKNOWN","ACCOUNT_UNAVAILABLE"].includes(error.kind)
                ? onRetry
                : undefined
            }
            onSwitchNetwork={error.kind === "WRONG_NETWORK" ? onSwitchNetwork : undefined}
            onReadyToResimulate={onReadyToResimulate}
            isCheckingNetwork={isCheckingNetwork}
            onDismiss={onRetry}
            autoFocusPrimary
          />
        </div>
      )}
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

export function ConnectWalletModal({ isOpen, onClose }: ConnectWalletModalProps) {
  const { dialogRef, titleId } = useModalA11y(isOpen, onClose);
  const {
    isConnected, publicKey, refresh,
    freighter, lobstr, magic,
    connectFreighter, connectLobstr,
    clearAllWalletErrors, clearStaleDraft,
    walletType,
    networkPassphrase,
  } = useWalletContext();

  const [choosing, setChoosing]   = useState<Choosing>("idle");
  const [showMagic, setShowMagic] = useState(false);
  const [errors, setErrors]       = useState<ProviderErrors>({
    freighter: null, lobstr: null, magic: null,
  });
  const [isCheckingNetwork, setIsCheckingNetwork] = useState(false);

  // Reset on open
  useEffect(() => {
    if (isOpen) {
      setChoosing("idle");
      setErrors({ freighter: null, lobstr: null, magic: null });
      setIsCheckingNetwork(false);
    }
  }, [isOpen]);

  // Auto-close on success with sr announcement delay
  useEffect(() => {
    if (isConnected && choosing !== "idle") {
      posthog.capture("wallet_connected", { provider: choosing, surface: "connect_modal" });
      const t = setTimeout(onClose, 800);
      return () => clearTimeout(t);
    }
  }, [isConnected, choosing, onClose]);

  if (!isOpen) return null;

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleFreighter = async () => {
    setChoosing("freighter");
    setErrors(p => ({ ...p, freighter: null }));
    try {
      await connectFreighter();
    } catch (raw) {
      const err = normalizeWalletError(raw, config.networkPassphrase);
      setErrors(p => ({ ...p, freighter: err }));
      posthog.capture("wallet_connection_error", { provider: "freighter", error_kind: err.kind });
    }
  };

  const handleLobstr = async () => {
    setChoosing("lobstr");
    setErrors(p => ({ ...p, lobstr: null }));
    try {
      await connectLobstr();
    } catch (raw) {
      const err = normalizeWalletError(raw, config.networkPassphrase);
      setErrors(p => ({ ...p, lobstr: err }));
      posthog.capture("wallet_connection_error", { provider: "lobstr", error_kind: err.kind });
    }
  };

  const handleMagic = () => {
    setChoosing("magic");
    setErrors(p => ({ ...p, magic: null }));
    setShowMagic(true);
  };

  const handleClose = () => {
    clearAllWalletErrors();
    onClose();
  };

  const handleSwitchNetwork = useCallback(async () => {
    setIsCheckingNetwork(true);
    await refresh();
    setIsCheckingNetwork(false);
  }, [refresh]);

  const handleReadyToResimulate = useCallback(() => {
    clearStaleDraft();
    onClose();
  }, [clearStaleDraft, onClose]);

  // ── Derived ────────────────────────────────────────────────────────────────

  const freighterConnecting = choosing === "freighter" && freighter.isConnecting;
  const lobstrConnecting    = choosing === "lobstr"    && lobstr.isConnecting;
  const anyConnecting       = freighterConnecting || lobstrConnecting || magic.isConnecting;

  const freighterErr: WalletAdapterError | null =
    errors.freighter ??
    (freighter.isWrongNetwork
      ? {
          kind: "WRONG_NETWORK",
          message: `Freighter is on the wrong network. Switch to "${config.networkPassphrase}".`,
          expected: config.networkPassphrase,
          detected: freighter.networkPassphrase,
        }
      : null);

  const lobstrErr: WalletAdapterError | null =
    errors.lobstr ??
    (lobstr.isWrongNetwork
      ? {
          kind: "WRONG_NETWORK",
          message: `Lobstr is on the wrong network. Switch to "${config.networkPassphrase}".`,
          expected: config.networkPassphrase,
          detected: lobstr.networkPassphrase,
        }
      : null);

  const magicErr: WalletAdapterError | null =
    errors.magic ?? (magic.error ? normalizeWalletError(magic.error) : null);

  const activeErr =
    choosing === "freighter" ? freighterErr :
    choosing === "lobstr"    ? lobstrErr    :
    choosing === "magic"     ? magicErr     : null;

  // Live region message — assertive for errors, polite for progress/success
  const liveMsg =
    isConnected        ? `Wallet connected. Address: ${publicKey ?? ""}` :
    activeErr          ? activeErr.message :
    anyConnecting      ? "Connecting to wallet…" : "";
  const livePoliteness =
    activeErr && !anyConnecting ? "assertive" : "polite";

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <MagicWalletModal
        isOpen={showMagic}
        onClose={() => {
          setShowMagic(false);
          if (!magic.isConnected) setChoosing("idle");
        }}
      />

      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6">
        {/* Backdrop — click closes, but focus trap prevents accidental close via Tab */}
        <div
          className="absolute inset-0 bg-midnight-950/80 backdrop-blur-md animate-fade-in"
          onClick={handleClose}
          aria-hidden="true"
        />

        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          data-testid="connect-wallet-modal"
          tabIndex={-1}
          className="relative w-full max-w-md overflow-hidden rounded-3xl bg-white shadow-2xl shadow-black/50 animate-scale-in outline-none"
        >
          {/* Single StatusAnnouncer covers all live announcements for this dialog */}
          <StatusAnnouncer message={liveMsg} politeness={livePoliteness} />

          <div className="tribal-strip h-2" aria-hidden="true" />

          {/* Header */}
          <div className="flex items-center justify-between p-6 pb-0">
            <h2
              id={titleId}
              className="font-display text-2xl font-bold text-midnight-900"
            >
              Connect <span className="text-brand-500">Wallet</span>
            </h2>
            <button
              type="button"
              onClick={handleClose}
              aria-label="Close wallet connection dialog"
              className="rounded-full p-2 text-gray-700 hover:bg-gray-100 hover:text-midnight-900 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-1"
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>

          <div className="p-6 pt-4 max-h-[82vh] overflow-y-auto space-y-3">

            {/* Connected state */}
            {isConnected ? (
              <div
                role="status"
                aria-live="polite"
                className="rounded-2xl border-2 border-mint-100 bg-mint-50/30 p-8 text-center animate-fade-in"
              >
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-mint-100 text-mint-600">
                  <CheckCircle2 size={32} aria-hidden="true" />
                </div>
                <h3 className="font-display font-bold text-midnight-900 text-xl">
                  Connected!
                </h3>
                <p className="mt-2 text-sm text-mint-800">
                  Your wallet is connected to ELCARE-HUB.
                </p>
                {/* sr-only so AT reads the full key without visual noise */}
                <p className="sr-only">Wallet address: {publicKey}</p>
                <p
                  className="mt-3 font-mono text-[10px] text-mint-700/60 break-all px-4"
                  aria-hidden="true"
                >
                  {publicKey}
                </p>
              </div>
            ) : (
              <>
                <p className="text-sm text-gray-500 font-medium">
                  Choose how you want to connect to ELCARE-HUB.
                </p>

                {/* Freighter */}
                <WalletRow
                  name="Freighter"
                  tagline="Official Stellar Wallet"
                  icon={<Wallet size={24} aria-hidden="true" />}
                  isInstalled={freighter.isInstalled}
                  isConnecting={freighterConnecting}
                  disabled={anyConnecting}
                  installHref="https://www.freighter.app/"
                  installHint="Free browser extension by Stellar Development Foundation."
                  error={freighterErr}
                  accent="brand"
                  provider="freighter"
                  onConnect={handleFreighter}
                  onRetry={() => {
                    setErrors(p => ({ ...p, freighter: null }));
                    handleFreighter();
                  }}
                  onSwitchNetwork={handleSwitchNetwork}
                  onReadyToResimulate={handleReadyToResimulate}
                  isCheckingNetwork={isCheckingNetwork}
                  data-testid="wallet-option-freighter"
                />

                {/* Lobstr */}
                <WalletRow
                  name="Lobstr"
                  tagline="Popular Stellar Wallet & Exchange"
                  icon={<LobstrLogo size={24} />}
                  isInstalled={lobstr.isInstalled}
                  isConnecting={lobstrConnecting}
                  disabled={anyConnecting}
                  installHref="https://lobstr.co/uni/lobstr-signer-extension"
                  installHint="Browser extension by the Lobstr team."
                  error={lobstrErr}
                  accent="amber"
                  provider="lobstr"
                  onConnect={handleLobstr}
                  onRetry={() => {
                    setErrors(p => ({ ...p, lobstr: null }));
                    handleLobstr();
                  }}
                  onSwitchNetwork={handleSwitchNetwork}
                  onReadyToResimulate={handleReadyToResimulate}
                  isCheckingNetwork={isCheckingNetwork}
                  data-testid="wallet-option-lobstr"
                />

                {/* Magic */}
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={handleMagic}
                    disabled={anyConnecting}
                    data-testid="wallet-option-magic"
                    aria-label="Connect with Magic Wallet using email or passkey"
                    aria-busy={magic.isConnecting || undefined}
                    className="group relative flex w-full items-center gap-4 rounded-2xl border-2 border-gray-100 p-4 text-left hover:border-purple-300 hover:bg-purple-50/30 transition-all duration-300 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 focus-visible:ring-offset-2"
                  >
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-purple-100 text-purple-600 group-hover:bg-purple-500 group-hover:text-white transition-colors flex-shrink-0"
                      aria-hidden="true">
                      <Mail size={24} aria-hidden="true" />
                    </div>
                    <div>
                      <p className="font-bold text-midnight-900">Magic Wallet</p>
                      <p className="text-xs text-gray-500">
                        Email or Passkey — no extension needed
                      </p>
                    </div>
                    <ArrowRight size={18} aria-hidden="true"
                      className="absolute right-4 text-gray-300 group-hover:text-purple-500 group-hover:translate-x-1 transition-all" />
                  </button>

                  {choosing === "magic" && magicErr && (
                    <WalletErrorDisplay
                      error={magicErr}
                      provider="magic"
                      onRetry={() => {
                        setErrors(p => ({ ...p, magic: null }));
                        setShowMagic(true);
                      }}
                      onDismiss={() => setErrors(p => ({ ...p, magic: null }))}
                    />
                  )}
                </div>

                {/* Divider */}
                <div className="relative py-1">
                  <div className="absolute inset-0 flex items-center" aria-hidden="true">
                    <div className="w-full border-t border-gray-100" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase tracking-widest text-gray-300">
                    <span className="bg-white px-2">Secure</span>
                  </div>
                </div>

                {/* Security note */}
                <div className="rounded-2xl bg-gray-50 p-4 flex items-start gap-3">
                  <ShieldCheck size={18} className="text-mint-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
                  <p className="text-xs text-gray-600 leading-relaxed">
                    ELCARE-HUB never has access to your private keys and cannot
                    sign transactions without your explicit permission.
                  </p>
                </div>
              </>
            )}
          </div>

          {/* Footer */}
          <div className="bg-gray-50 p-4 text-center">
            <p className="text-[10px] text-gray-400 uppercase tracking-widest font-semibold flex items-center justify-center gap-2">
              Authenticated by Stellar Consensus{" "}
              <ShieldCheck size={10} aria-hidden="true" />
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
