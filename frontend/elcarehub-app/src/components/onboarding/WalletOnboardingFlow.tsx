"use client";

/**
 * components/onboarding/WalletOnboardingFlow.tsx
 *
 * First-time user onboarding flow that teaches wallet concepts and guides
 * the user through connecting their first wallet.
 *
 * Steps:
 *   1. What is a wallet?     — concept explainer
 *   2. Choose your wallet    — picker with capability comparison
 *   3. Install (if needed)   — extension install guidance
 *   4. Connect               — in-flow ConnectWalletModal trigger
 *   5. Success               — confirmation + "start exploring" CTA
 *
 * Persists completion state to localStorage so returning users skip it.
 * Can be re-triggered at any time via the `openOnboarding` context helper.
 */

import React, {
  createContext, useContext, useEffect, useRef, useState, ReactNode,
} from "react";
import {
  Wallet, Mail, ArrowRight, ArrowLeft, CheckCircle2,
  ShieldCheck, Zap, Globe, Key, ExternalLink, X,
} from "lucide-react";
import { useWalletContext } from "@/context/WalletContext";
import { ConnectWalletModal } from "@/components/ConnectWalletModal";
import posthog from "posthog-js";

// ── Storage key ───────────────────────────────────────────────────────────────

const STORAGE_KEY = "elcarehub_onboarding_v1";

// ── Step definitions ──────────────────────────────────────────────────────────

interface Step {
  id: string;
  title: string;
  subtitle?: string;
}

const STEPS: Step[] = [
  { id: "what-is-wallet",  title: "What is a Wallet?",      subtitle: "Step 1 of 4" },
  { id: "choose-wallet",   title: "Choose Your Wallet",     subtitle: "Step 2 of 4" },
  { id: "network",         title: "Network & Fees",         subtitle: "Step 3 of 4" },
  { id: "connect",         title: "Connect & Start",        subtitle: "Step 4 of 4" },
];

// ── Context ───────────────────────────────────────────────────────────────────

interface OnboardingContextValue {
  isOpen: boolean;
  openOnboarding: () => void;
  closeOnboarding: () => void;
  hasCompleted: boolean;
}

const OnboardingContext = createContext<OnboardingContextValue | undefined>(undefined);

export function useOnboarding() {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error("useOnboarding must be used inside <WalletOnboardingProvider>");
  return ctx;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function WalletOnboardingProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen]           = useState(false);
  const [hasCompleted, setHasCompleted] = useState(false);
  const [mounted, setMounted]         = useState(false);

  useEffect(() => {
    setMounted(true);
    const done = typeof window !== "undefined" && localStorage.getItem(STORAGE_KEY) === "done";
    setHasCompleted(done);
    if (!done) setIsOpen(true);
  }, []);

  const openOnboarding = () => { setIsOpen(true); };
  const closeOnboarding = () => {
    setIsOpen(false);
    setHasCompleted(true);
    try { localStorage.setItem(STORAGE_KEY, "done"); } catch { /* ignore */ }
  };

  if (!mounted) return <>{children}</>;

  return (
    <OnboardingContext.Provider value={{ isOpen, openOnboarding, closeOnboarding, hasCompleted }}>
      {children}
      {isOpen && <WalletOnboardingModal onClose={closeOnboarding} />}
    </OnboardingContext.Provider>
  );
}

// ── Step content components ───────────────────────────────────────────────────

function StepWhatIsWallet() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3">
        {[
          {
            icon: <Key size={20} className="text-brand-600" aria-hidden="true" />,
            heading: "Your digital identity",
            body: "A crypto wallet proves ownership of your digital assets. It never stores your NFTs — the blockchain does. Your wallet holds the key that proves they're yours.",
          },
          {
            icon: <ShieldCheck size={20} className="text-mint-600" aria-hidden="true" />,
            heading: "You stay in control",
            body: "ELCARE-HUB can never move your assets or sign anything without your explicit approval. Every transaction requires you to confirm it in your wallet first.",
          },
          {
            icon: <Globe size={20} className="text-purple-600" aria-hidden="true" />,
            heading: "Works everywhere on Stellar",
            body: "The same wallet works across every Stellar app. Connecting here doesn't lock you into ELCARE-HUB.",
          },
        ].map(({ icon, heading, body }) => (
          <div key={heading} className="flex gap-3 rounded-2xl border border-gray-100 bg-gray-50 p-4">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-white shadow-sm">
              {icon}
            </div>
            <div>
              <p className="text-sm font-bold text-midnight-900">{heading}</p>
              <p className="mt-0.5 text-xs text-gray-500 leading-relaxed">{body}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="rounded-2xl bg-amber-50 border border-amber-200 p-3 flex gap-2 items-start">
        <Zap size={15} className="text-amber-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
        <p className="text-xs text-amber-800 leading-relaxed">
          <span className="font-bold">Protect your seed phrase.</span> It's the master key to your wallet. Never share it — not even with ELCARE-HUB. If you lose it, no one can recover your assets.
        </p>
      </div>
    </div>
  );
}

function StepChooseWallet({ freighterInstalled, lobstrInstalled }: {
  freighterInstalled: boolean;
  lobstrInstalled: boolean;
}) {
  const options = [
    {
      name: "Freighter",
      tagline: "Best for beginners",
      description: "Official browser extension by Stellar Development Foundation. Simple, secure, and purpose-built for Stellar apps.",
      href: "https://www.freighter.app/",
      installed: freighterInstalled,
      icon: <Wallet size={22} className="text-brand-600" aria-hidden="true" />,
      bg: "bg-brand-50 border-brand-200",
      badge: "Recommended",
      badgeBg: "bg-brand-100 text-brand-700",
    },
    {
      name: "Lobstr",
      tagline: "Wallet + Exchange",
      description: "Popular Stellar wallet with built-in exchange features. Great if you also want to trade directly from your wallet.",
      href: "https://lobstr.co/uni/lobstr-signer-extension",
      installed: lobstrInstalled,
      icon: (
        <svg width="22" height="22" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <rect width="512" height="512" rx="100" fill="#0B1E3E" />
          <path d="M256 96C167.6 96 96 167.6 96 256s71.6 160 160 160 160-71.6 160-160S344.4 96 256 96zm0 280c-66.3 0-120-53.7-120-120s53.7-120 120-120 120 53.7 120 120-53.7 120-120 120z" fill="#FBBF24" />
          <circle cx="256" cy="256" r="50" fill="#FBBF24" />
        </svg>
      ),
      bg: "bg-amber-50 border-amber-200",
      badge: null,
      badgeBg: "",
    },
    {
      name: "Magic Wallet",
      tagline: "No extension needed",
      description: "Sign in with your email address or a passkey. No browser extension required — ideal if you're new to crypto.",
      href: null,
      installed: true, // always available
      icon: <Mail size={22} className="text-purple-600" aria-hidden="true" />,
      bg: "bg-purple-50 border-purple-200",
      badge: "No extension",
      badgeBg: "bg-purple-100 text-purple-700",
    },
  ];

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-500">
        All three wallets work on ELCARE-HUB. Pick the one that suits you.
      </p>
      {options.map(opt => (
        <div key={opt.name}
          className={`rounded-2xl border p-4 flex items-start gap-3 ${opt.bg}`}>
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-white shadow-sm">
            {opt.icon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-bold text-midnight-900 text-sm">{opt.name}</p>
              {opt.badge && (
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${opt.badgeBg}`}>
                  {opt.badge}
                </span>
              )}
              {opt.installed && opt.name !== "Magic Wallet" && (
                <span className="rounded-full bg-mint-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-mint-700">
                  Detected
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-0.5">{opt.tagline}</p>
            <p className="text-xs text-gray-400 mt-1 leading-relaxed">{opt.description}</p>
          </div>
          {opt.href && !opt.installed && (
            <a href={opt.href} target="_blank" rel="noopener noreferrer"
              className="flex-shrink-0 flex items-center gap-1 text-xs font-bold text-brand-500 hover:underline mt-0.5">
              Install <ExternalLink size={11} aria-hidden="true" />
            </a>
          )}
        </div>
      ))}
    </div>
  );
}

function StepNetwork() {
  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {[
          {
            q: "What network should I use?",
            a: "ELCARE-HUB runs on the Stellar network. Make sure your wallet is set to Stellar Mainnet (or Testnet if you're testing). The app will warn you if your wallet is on the wrong network.",
          },
          {
            q: "What are transaction fees?",
            a: "Stellar transactions cost a tiny fee (a fraction of a cent in XLM). These fees go to the Stellar network validators, not to ELCARE-HUB. Always keep a small XLM balance to cover fees.",
          },
          {
            q: "What happens when I approve a transaction?",
            a: "Your wallet will show you exactly what you're signing — the amount, the recipient, and the action. Read it carefully before clicking Approve. You can always decline.",
          },
        ].map(({ q, a }) => (
          <div key={q} className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
            <p className="text-sm font-bold text-midnight-900">{q}</p>
            <p className="mt-1.5 text-xs text-gray-500 leading-relaxed">{a}</p>
          </div>
        ))}
      </div>
      <div className="rounded-2xl bg-brand-50 border border-brand-200 p-3 flex gap-2 items-start">
        <ShieldCheck size={15} className="text-brand-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
        <p className="text-xs text-brand-800 leading-relaxed">
          ELCARE-HUB will always tell you exactly what a transaction does before you sign it.
          If anything looks unexpected, decline and contact support.
        </p>
      </div>
    </div>
  );
}

function StepConnect({ onOpenConnectModal }: { onOpenConnectModal: () => void }) {
  const { isConnected, publicKey, walletType } = useWalletContext();

  if (isConnected) {
    return (
      <div className="text-center space-y-4 py-4">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-mint-100 text-mint-600">
          <CheckCircle2 size={32} aria-hidden="true" />
        </div>
        <div>
          <p className="font-display font-bold text-midnight-900 text-xl">You're connected!</p>
          <p className="mt-1.5 text-sm text-gray-500">
            {walletType ? walletType.charAt(0).toUpperCase() + walletType.slice(1) : "Wallet"} is connected to ELCARE-HUB.
          </p>
          {publicKey && (
            <p className="mt-2 font-mono text-[10px] text-gray-400 break-all px-4">{publicKey}</p>
          )}
        </div>
        <div className="rounded-2xl bg-mint-50 border border-mint-200 p-3 text-xs text-mint-800 text-left flex gap-2 items-start">
          <CheckCircle2 size={14} className="text-mint-600 mt-0.5 flex-shrink-0" aria-hidden="true" />
          You can now browse listings, place bids, make offers, and list your own artwork.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        You're ready to connect. Click the button below to choose your wallet and
        complete the setup.
      </p>
      <button type="button" onClick={onOpenConnectModal}
        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-500 py-4 text-base font-bold text-white shadow-lg shadow-brand-500/20 hover:bg-brand-600 transition-all">
        <Wallet size={20} aria-hidden="true" />
        Connect My Wallet
      </button>
      <p className="text-center text-xs text-gray-400">
        Takes about 30 seconds. Your assets stay in your wallet at all times.
      </p>
    </div>
  );
}

// ── Modal shell ───────────────────────────────────────────────────────────────

interface WalletOnboardingModalProps {
  onClose: () => void;
}

function WalletOnboardingModal({ onClose }: WalletOnboardingModalProps) {
  const { isConnected, freighter, lobstr } = useWalletContext();
  const [step, setStep]               = useState(0);
  const [showConnect, setShowConnect] = useState(false);
  const modalRef                      = useRef<HTMLDivElement>(null);

  // Focus trap
  useEffect(() => {
    modalRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Track step
  useEffect(() => {
    posthog.capture("onboarding_step_viewed", { step: STEPS[step]?.id });
  }, [step]);

  // Auto-advance to success when connected on the last step
  useEffect(() => {
    if (isConnected && step === STEPS.length - 1) {
      posthog.capture("onboarding_completed");
    }
  }, [isConnected, step]);

  const isLastStep = step === STEPS.length - 1;
  const canFinish  = isLastStep && isConnected;

  const handleNext = () => {
    if (canFinish) { onClose(); return; }
    if (step < STEPS.length - 1) setStep(s => s + 1);
  };

  const handleBack = () => { if (step > 0) setStep(s => s - 1); };

  const currentStep = STEPS[step];

  return (
    <>
      <ConnectWalletModal isOpen={showConnect} onClose={() => setShowConnect(false)} />

      <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
        {/* Backdrop */}
        <div className="absolute inset-0 bg-midnight-950/80 backdrop-blur-md"
          onClick={onClose} aria-hidden="true" />

        {/* Card */}
        <div ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true"
          aria-label="Wallet setup guide"
          className="relative w-full max-w-lg overflow-hidden rounded-3xl bg-white shadow-2xl outline-none">

          <div className="tribal-strip h-2" aria-hidden="true" />

          {/* Progress bar */}
          <div className="h-1 bg-gray-100" role="progressbar"
            aria-valuenow={step + 1} aria-valuemin={1} aria-valuemax={STEPS.length}>
            <div className="h-full bg-brand-500 transition-all duration-500"
              style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
          </div>

          {/* Header */}
          <div className="flex items-start justify-between p-6 pb-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
                {currentStep.subtitle}
              </p>
              <h2 className="mt-1 font-display text-2xl font-bold text-midnight-900">
                {currentStep.title}
              </h2>
            </div>
            <button type="button" onClick={onClose} aria-label="Skip onboarding"
              className="rounded-full p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors">
              <X size={18} aria-hidden="true" />
            </button>
          </div>

          {/* Body */}
          <div className="px-6 pb-4 max-h-[55vh] overflow-y-auto">
            {step === 0 && <StepWhatIsWallet />}
            {step === 1 && (
              <StepChooseWallet
                freighterInstalled={freighter.isInstalled}
                lobstrInstalled={lobstr.isInstalled}
              />
            )}
            {step === 2 && <StepNetwork />}
            {step === 3 && <StepConnect onOpenConnectModal={() => setShowConnect(true)} />}
          </div>

          {/* Footer nav */}
          <div className="flex items-center justify-between border-t border-gray-100 p-6 pt-4">
            <button type="button" onClick={handleBack} disabled={step === 0}
              className="flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-midnight-900 disabled:opacity-40 transition-colors">
              <ArrowLeft size={16} aria-hidden="true" /> Back
            </button>

            {/* Step dots */}
            <div className="flex gap-1.5" aria-hidden="true">
              {STEPS.map((_, i) => (
                <div key={i}
                  className={`h-2 rounded-full transition-all ${i === step ? "w-5 bg-brand-500" : i < step ? "w-2 bg-brand-300" : "w-2 bg-gray-200"}`} />
              ))}
            </div>

            <button type="button" onClick={handleNext}
              className="flex items-center gap-1.5 rounded-xl bg-brand-500 px-5 py-2.5 text-sm font-bold text-white hover:bg-brand-600 transition-all">
              {canFinish ? "Start Exploring" : isLastStep && !isConnected ? "Skip for now" : "Next"}
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
