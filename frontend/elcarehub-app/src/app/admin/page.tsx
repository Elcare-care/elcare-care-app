// ─────────────────────────────────────────────────────────────
// app/admin/page.tsx — Administrative Dashboard & Moderation Panel
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useCallback, useEffect } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { useWallet } from "@/hooks/useWallet";
import { useAdminStats, useModeration, useTokenManagement, useAdminCheck, useAdminTransfer, usePauseControls, useAuctionConfig, useListingOversight, useModerationQueue, PAUSABLE_FUNCTIONS, type PausableFunction } from "@/hooks/useAdmin";
import { MODERATION_POLICY_URL } from "@/lib/moderation";
import { useAdminSession } from "@/hooks/useAdminSession";
import { useIndexerFreshness } from "@/hooks/useIndexerFreshness";
import { AdminConfirmationModal } from "@/components/AdminConfirmationModal";
import { StaleBanner } from "@/components/StaleBanner";
import {
    Users,
    Palette,
    ShieldAlert,
    ShieldCheck,
    Search,
    Plus,
    Trash2,
    BarChart3,
    Wallet,
    Settings,
    Lock,
    Loader2,
    CheckCircle2,
    AlertCircle,
    KeyRound,
    History,
    ArrowRightLeft,
    Clock,
    X,
    ChevronRight,
    ChevronLeft,
    AlertTriangle,
    ShieldOff,
    ToggleLeft,
    ToggleRight,
    Zap,
    List,
    Flag,
    Scale,
    ExternalLink,
} from "lucide-react";
import { stroopsToXlm } from "@/lib/contract";

// ── Admin key rotation helpers (Issue #202) ───────────────────────────────────

/** True for a well-formed Stellar ed25519 public key (G...). */
function isValidStellarAddress(addr: string): boolean {
    try {
        return StrKey.isValidEd25519PublicKey(addr.trim());
    } catch {
        return false;
    }
}

/** Render seconds-remaining as "6d 23h 12m 04s"; "Expired" once elapsed. */
function formatCountdown(secondsRemaining: number): string {
    if (secondsRemaining <= 0) return "Expired";
    const d = Math.floor(secondsRemaining / 86400);
    const h = Math.floor((secondsRemaining % 86400) / 3600);
    const m = Math.floor((secondsRemaining % 3600) / 60);
    const s = Math.floor(secondsRemaining % 60);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d}d ${pad(h)}h ${pad(m)}m ${pad(s)}s`;
}

export default function AdminPage() {
    const { publicKey } = useWallet();
    const { isAdmin, isLoading: isCheckingAdmin } = useAdminCheck(publicKey);
    const { stats, isLoading: isLoadingStats, refresh: refreshStats } = useAdminStats();
    const { revoke, reinstate, checkStatus, isProcessing: isModerating } = useModeration(publicKey);
    const {
        whitelistedTokens,
        whitelist,
        unwhitelist,
        isLoading: isLoadingTokens,
        isProcessing: isManagingTokens,
        error: tokenError,
        refresh: refreshTokens,
        getTokenHistory
    } = useTokenManagement(publicKey);

    const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
    const [selectedTokenHistory, setSelectedTokenHistory] = useState<TokenHistory | null>(null);

    const { isAuthenticated, authenticate, logout, sessionExpiresIn } = useAdminSession(publicKey);

    // Admin key rotation (Issue #202)
    const {
        pending: pendingAdmin,
        isProcessing: isRotating,
        error: rotationError,
        propose: proposeNewAdmin,
        accept: acceptAdminTransfer,
        cancel: cancelAdminTransfer,
    } = useAdminTransfer(publicKey);

    // Granular circuit-breaker (Issue #205)
    const {
        state: pauseState,
        isLoading: isPauseLoading,
        isProcessing: isPauseProcessing,
        error: pauseError,
        refresh: refreshPause,
        toggleGlobal: toggleGlobalPause,
        toggleCollection: toggleCollectionPause,
        toggleFunction: toggleFunctionPause,
    } = usePauseControls(publicKey);

    // Auction configuration
    const {
        config: auctionConfig,
        isLoading: isAuctionConfigLoading,
        isProcessing: isAuctionConfigProcessing,
        error: auctionConfigError,
        refresh: refreshAuctionConfig,
        setMinBid,
        setExtensionWindow,
        setExtensionTrigger,
    } = useAuctionConfig(publicKey);

    // Listing oversight with search + pagination
    const {
        listings: oversightListings,
        totalCount: oversightTotal,
        page: oversightPage,
        totalPages: oversightTotalPages,
        setPage: setOversightPage,
        filter: oversightFilter,
        setFilter: setOversightFilter,
        isLoading: isOversightLoading,
        error: oversightError,
        refresh: refreshOversight,
    } = useListingOversight(isAdmin ? publicKey : null);

    // Content moderation triage queue (Issue #542)
    const {
        cases: moderationCases,
        total: moderationTotal,
        stateFilter: moderationStateFilter,
        setStateFilter: setModerationStateFilter,
        selectedCase: selectedModerationCase,
        openCase: openModerationCase,
        closeCase: closeModerationCase,
        decide: decideModeration,
        resolveAppeal: resolveModerationAppeal,
        isLoading: isModerationLoading,
        isProcessing: isModerationProcessing,
        error: moderationError,
        refresh: refreshModeration,
    } = useModerationQueue(isAdmin ? publicKey : null);
    const [moderationReason, setModerationReason] = useState("");

    // Issue #522 — indexer freshness/health for the admin dashboard. Admin
    // views drive moderation and oversight decisions off indexed data, so a
    // lagging/unavailable indexer (or an active reorg) must be visible here
    // too, not just on public-facing pages.
    const refreshAdminData = useCallback(async () => {
        await Promise.all([
            refreshStats(),
            refreshTokens(),
            refreshOversight(),
            refreshModeration(),
        ]);
    }, [refreshStats, refreshTokens, refreshOversight, refreshModeration]);
    const freshness = useIndexerFreshness({
        resourceType: "default",
        onRefresh: refreshAdminData,
    });
    useEffect(() => {
        if (stats) freshness.markUpdated();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stats]);

    // Collection rows for circuit-breaker (loaded from indexer on mount)
    const [collectionPauseRows, setCollectionPauseRows] = useState<
        { address: string; paused: boolean }[]
    >([]);
    useEffect(() => {
        const fetchCols = async () => {
            try {
                const base = process.env.NEXT_PUBLIC_INDEXER_URL ?? "";
                const res = await fetch(`${base}/collections?limit=100`);
                if (!res.ok) return;
                const json = await res.json();
                const rows = (Array.isArray(json) ? json : json.collections ?? []).map(
                    (c: any) => ({ address: c.contractAddress ?? c.contract_address, paused: false })
                );
                setCollectionPauseRows(rows);
            } catch { /* non-fatal */ }
        };
        fetchCols();
    }, []);

    const [isWizardOpen, setIsWizardOpen] = useState(false);
    // A once-per-second clock so the proposal countdown ticks live.
    const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
    useEffect(() => {
        const id = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 1000);
        return () => clearInterval(id);
    }, []);
    const secondsRemaining = pendingAdmin ? pendingAdmin.expiresAt - nowSeconds : 0;
    const isConnectedWalletCandidate =
        !!pendingAdmin && !!publicKey && pendingAdmin.candidate === publicKey;

    // Local state for moderation search
    const [artistSearch, setArtistSearch] = useState("");
    const [searchResult, setSearchResult] = useState<{ address: string; isRevoked: boolean } | null>(null);
    const [searchError, setSearchError] = useState<string | null>(null);

    // Local state for token management
    const [newTokenAddress, setNewTokenAddress] = useState("");

    // Local state for per-collection fee overrides (Issue #322)
    const [collectionFeeAddress, setCollectionFeeAddress] = useState("");
    const [collectionFeeBps, setCollectionFeeBps] = useState("");
    const [collectionFeeRows, setCollectionFeeRows] = useState<{ address: string; fee_bps: number | null }[]>([]);
    const [isFeeLoading, setIsFeeLoading] = useState(false);
    const [isFeeProcessing, setIsFeeProcessing] = useState(false);
    const [feeError, setFeeError] = useState<string | null>(null);

    // Fetch collection fee list from indexer on mount
    useEffect(() => {
        const fetchFees = async () => {
            setIsFeeLoading(true);
            try {
                const base = process.env.NEXT_PUBLIC_INDEXER_URL ?? "";
                const res = await fetch(`${base}/collections?limit=100`);
                if (!res.ok) throw new Error("Failed to fetch collections");
                const json = await res.json();
                const rows = (Array.isArray(json) ? json : json.collections ?? []).map(
                    (c: any) => ({ address: c.contractAddress ?? c.contract_address, fee_bps: c.fee_bps ?? null })
                );
                setCollectionFeeRows(rows);
            } catch {
                // non-fatal — table stays empty
            } finally {
                setIsFeeLoading(false);
            }
        };
        fetchFees();
    }, []);

    const handleSetCollectionFee = async () => {
        const addr = collectionFeeAddress.trim();
        const bpsVal = parseInt(collectionFeeBps, 10);
        if (!addr) { setFeeError("Enter a collection contract address."); return; }
        if (isNaN(bpsVal) || bpsVal < 0 || bpsVal > 10000) {
            setFeeError("BPS must be a whole number between 0 and 10 000.");
            return;
        }
        setFeeError(null);
        setIsFeeProcessing(true);
        try {
            // Optimistically update the table
            setCollectionFeeRows((prev) => {
                const existing = prev.find((r) => r.address === addr);
                if (existing) return prev.map((r) => r.address === addr ? { ...r, fee_bps: bpsVal } : r);
                return [...prev, { address: addr, fee_bps: bpsVal }];
            });
            setCollectionFeeAddress("");
            setCollectionFeeBps("");
        } finally {
            setIsFeeProcessing(false);
        }
    };

    const handleClearCollectionFee = (addr: string) => {
        setCollectionFeeRows((prev) =>
            prev.map((r) => r.address === addr ? { ...r, fee_bps: null } : r)
        );
    };

    // Confirmation Modal state
    const [confirmConfig, setConfirmConfig] = useState<{
        isOpen: boolean;
        title: string;
        actionDescription: string;
        consequences: string[];
        onConfirm: () => void;
        variant: "danger" | "warning" | "info";
    }>({
        isOpen: false,
        title: "",
        actionDescription: "",
        consequences: [],
        onConfirm: () => { },
        variant: "danger"
    });

    const handleSearchArtist = async () => {
        if (!artistSearch) return;
        setSearchError(null);
        try {
            const isRevoked = await checkStatus(artistSearch);
            setSearchResult({ address: artistSearch, isRevoked });
        } catch {
            setSearchError("Invalid address or error fetching status.");
        }
    };

    const handleToggleArtistStatus = async () => {
        if (!searchResult) return;

        const action = searchResult.isRevoked ? "reinstate" : "revoke";
        
        setConfirmConfig({
            isOpen: true,
            title: searchResult.isRevoked ? "Reinstate Artist" : "Revoke Artist",
            actionDescription: `${searchResult.isRevoked ? "Restoring" : "Removing"} permissions for artist ${searchResult.address}.`,
            consequences: searchResult.isRevoked 
                ? ["Artist will be able to create new listings and auctions again.", "Their existing profile will be visible to all users."]
                : ["Artist will no longer be able to create new listings or auctions.", "This action will be recorded on the blockchain.", "Existing listings may need to be manually managed."],
            variant: searchResult.isRevoked ? "info" : "danger",
            onConfirm: async () => {
                const success = searchResult.isRevoked
                    ? await reinstate(searchResult.address)
                    : await revoke(searchResult.address);

                if (success) {
                    setSearchResult({ ...searchResult, isRevoked: !searchResult.isRevoked });
                    setConfirmConfig(prev => ({ ...prev, isOpen: false }));
                }
            }
        });
    };

    const handleWhitelistToken = async () => {
        if (!newTokenAddress) return;

        setConfirmConfig({
            isOpen: true,
            title: "Whitelist Token",
            actionDescription: `Adding token ${newTokenAddress} to the whitelisted payment options.`,
            consequences: [
                "Users will be able to list and buy NFTs using this token.",
                "The marketplace contract will interact with this token contract.",
                "Ensure the token address is correct and the token is trusted."
            ],
            variant: "info",
            onConfirm: async () => {
                const success = await whitelist(newTokenAddress);
                if (success) {
                    setNewTokenAddress("");
                    setConfirmConfig(prev => ({ ...prev, isOpen: false }));
                }
            }
        });
    };

    const handleViewHistory = async (address: string) => {
        const history = await getTokenHistory(address);
        if (history) {
            setSelectedTokenHistory(history);
            setHistoryDrawerOpen(true);
        }
    };

    const handleRemoveToken = async (addr: string) => {
        setConfirmConfig({
            isOpen: true,
            title: "Remove Token from Whitelist",
            actionDescription: `Removing token ${addr} from whitelisted payment options.`,
            consequences: [
                "Users will no longer be able to create new listings using this token.",
                "Existing listings using this token may become un-purchasable.",
                "This action is immediate and affects all users."
            ],
            variant: "danger",
            onConfirm: async () => {
                const success = await unwhitelist(addr);
                if (success) {
                    setConfirmConfig(prev => ({ ...prev, isOpen: false }));
                }
            }
        });
    };

    if (isCheckingAdmin) {
        return (
            <div className="flex h-[80vh] items-center justify-center">
                <Loader2 className="h-10 w-10 animate-spin text-brand-500" />
            </div>
        );
    }

    // A non-admin wallet that is the pending candidate gets a focused Accept view
    // instead of Access Denied, so it can complete the two-step rotation.
    if (!isAdmin && isConnectedWalletCandidate && pendingAdmin) {
        const expired = secondsRemaining <= 0;
        return (
            <div className="flex min-h-[80vh] flex-col items-center justify-center px-4 text-center">
                <div className="mb-6 rounded-full bg-brand-100 p-6">
                    <KeyRound className="h-12 w-12 text-brand-600" />
                </div>
                <h1 className="font-display text-4xl font-bold tracking-tight text-midnight-900 sm:text-5xl">
                    Admin Transfer Pending
                </h1>
                <p className="mt-4 max-w-lg text-lg text-gray-600">
                    The current administrator has proposed transferring admin authority to
                    <span className="font-semibold text-midnight-900"> your connected wallet</span>.
                    Accept to take over administration of the marketplace.
                </p>

                <div className={`mt-8 flex items-center gap-2 rounded-2xl px-5 py-3 text-sm font-semibold ${expired ? "bg-red-50 text-red-700" : "bg-brand-50 text-brand-700"}`}>
                    <Clock className="h-4 w-4" />
                    {expired
                        ? "This proposal has expired and can no longer be accepted."
                        : `Acceptance window closes in ${formatCountdown(secondsRemaining)}`}
                </div>

                {rotationError && (
                    <div className="mt-4 flex items-center gap-2 rounded-xl bg-red-50 p-4 text-sm text-red-600 border border-red-100">
                        <AlertCircle className="h-4 w-4" />
                        {rotationError}
                    </div>
                )}

                <button
                    type="button"
                    disabled={isRotating || expired}
                    onClick={async () => { await acceptAdminTransfer(); }}
                    className="mt-8 flex items-center gap-2 rounded-2xl bg-brand-600 px-8 py-4 text-lg font-bold text-white shadow-lg shadow-brand-200 transition-all hover:bg-brand-700 active:scale-95 disabled:opacity-50"
                >
                    {isRotating ? <Loader2 className="h-6 w-6 animate-spin" /> : <CheckCircle2 className="h-6 w-6" />}
                    Accept Admin Transfer
                </button>
            </div>
        );
    }

    if (!isAdmin) {
        return (
            <div className="flex h-[80vh] flex-col items-center justify-center px-4 text-center">
                <div className="mb-6 rounded-full bg-red-100 p-6">
                    <Lock className="h-12 w-12 text-red-600" />
                </div>
                <h1 className="font-display text-4xl font-bold tracking-tight text-midnight-900 sm:text-5xl">
                    Access Denied
                </h1>
                <p className="mt-4 max-w-lg text-lg text-gray-600">
                    This page is reserved for marketplace administrators.
                    Please connect the administrator wallet to view this panel.
                </p>
            </div>
        );
    }

    if (!isAuthenticated) {
        return (
            <div className="flex h-[80vh] flex-col items-center justify-center px-4 text-center">
                <div className="mb-6 rounded-full bg-brand-100 p-6">
                    <ShieldCheck className="h-12 w-12 text-brand-600" />
                </div>
                <h1 className="font-display text-4xl font-bold tracking-tight text-midnight-900 sm:text-5xl">
                    Admin Session Required
                </h1>
                <p className="mt-4 max-w-lg text-lg text-gray-600 mb-8">
                    To perform sensitive administrative actions, you must start a secure session.
                    This session will automatically expire after 15 minutes of inactivity.
                </p>
                <button
                    onClick={authenticate}
                    className="flex items-center gap-2 rounded-2xl bg-brand-600 px-8 py-4 text-lg font-bold text-white shadow-lg shadow-brand-200 transition-all hover:bg-brand-700 active:scale-95"
                >
                    <KeyRound className="h-6 w-6" />
                    Start Admin Session
                </button>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-brand-50 pb-20 pt-10">
            <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
                {/* Header */}
                <div className="mb-10 flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
                    <div>
                        <div className="flex items-center gap-2 mb-2">
                            <span className="inline-flex items-center rounded-full bg-brand-100 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-brand-700">
                                Admin Control Center
                            </span>
                            <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-700">
                                <History className="h-3 w-3" />
                                Session: {Math.floor(sessionExpiresIn / 60000)}m remaining
                            </span>
                        </div>
                        <h1 className="mt-3 font-display text-4xl font-bold text-midnight-950 sm:text-5xl">
                            Marketplace <span className="text-brand-500">Overview</span>
                        </h1>
                    </div>
                    <div className="flex gap-3">
                        <button
                            type="button"
                            onClick={logout}
                            className="flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-red-600 shadow-sm transition-all hover:bg-red-50 border border-red-100"
                        >
                            End Session
                        </button>
                        <button
                            type="button"
                            onClick={() => { refreshStats(); refreshTokens(); }}
                            className="flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-midnight-900 shadow-sm transition-all hover:bg-brand-50 hover:shadow-md border border-brand-100"
                        >
                            <Loader2 className={`h-4 w-4 ${isLoadingStats || isLoadingTokens ? 'animate-spin' : ''}`} />
                            Refresh Data
                        </button>
                    </div>
                </div>

                {/* Issue #522 — non-blocking indexer freshness indicator */}
                {freshness.status !== "healthy" && (
                    <div className="mb-8">
                        <StaleBanner
                            freshness={freshness.freshness}
                            status={freshness.status}
                            reorg={freshness.reorg}
                            onRefresh={freshness.refresh}
                            isRefreshing={freshness.isRefreshing}
                        />
                    </div>
                )}

                <div className="mb-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
                    <StatCard
                        title="Total Listed NFTs"
                        value={stats?.totalListings?.toString() || "0"}
                        icon={<Palette className="h-6 w-6" />}
                        color="bg-primary shadow-primary/20"
                    />
                    <StatCard
                        title="Active Artists"
                        value={stats?.totalUsers?.toString() || "0"}
                        icon={<Users className="h-6 w-6" />}
                        color="bg-secondary shadow-secondary/20"
                    />
                    <StatCard
                        title="Platform Fee"
                        value={`${stats?.protocolFeeBps || 0} BPS`}
                        icon={<BarChart3 className="h-6 w-6" />}
                        color="bg-primary-dark shadow-primary-dark/20"
                    />
                    <StatCard
                        title="Treasury Status"
                        value={stats?.treasuryAddress ? "Active" : "Not Set"}
                        icon={<ShieldCheck className="h-6 w-6" />}
                        color="bg-midnight-600 shadow-midnight/20"
                    />
                </div>

                <div className="grid gap-8 lg:grid-cols-2">
                    {/* Moderation Panel */}
                    <section className="rounded-3xl bg-white p-8 shadow-sm border border-brand-100">
                        <div className="mb-6 flex items-center gap-3">
                            <div className="rounded-xl bg-orange-100 p-2.5">
                                <ShieldAlert className="h-6 w-6 text-orange-600" />
                            </div>
                            <h2 className="font-display text-2xl font-bold text-midnight-950">Artist Moderation</h2>
                        </div>

                        <p className="mb-6 text-gray-600">
                            Restrict or reinstate artist permissions. Revoked artists can browse and buy, but cannot create new listings or auctions.
                        </p>

                        <div className="flex gap-2">
                            <div className="relative flex-1">
                                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                                <input
                                    type="text"
                                    placeholder="Artist Stellar Address (G...)"
                                    value={artistSearch}
                                    onChange={(e) => setArtistSearch(e.target.value)}
                                    className="w-full rounded-xl border border-gray-200 py-3 pl-10 pr-4 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                                />
                            </div>
                            <button
                                type="button"
                                onClick={handleSearchArtist}
                                className="rounded-xl bg-midnight-900 px-6 py-3 text-sm font-bold text-white transition-all hover:bg-midnight-800"
                            >
                                Inspect
                            </button>
                        </div>

                        {searchError && (
                            <div className="mt-4 flex items-center gap-2 rounded-xl bg-red-50 p-4 text-sm text-red-600 border border-red-100">
                                <AlertCircle className="h-4 w-4" />
                                {searchError}
                            </div>
                        )}

                        {searchResult && (
                            <div className="mt-8 rounded-2xl border border-gray-100 bg-gray-50/50 p-6 animate-fade-in-up">
                                <div className="mb-4 flex flex-col gap-1">
                                    <span className="text-xs font-bold uppercase tracking-wider text-gray-400">Inspecting Address</span>
                                    <code className="break-all font-mono text-sm font-medium text-midnight-900">
                                        {searchResult.address}
                                    </code>
                                </div>

                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        {searchResult.isRevoked ? (
                                            <>
                                                <div className="h-3 w-3 rounded-full bg-red-500 animate-pulse" />
                                                <span className="font-semibold text-red-600 uppercase tracking-tighter text-xs">Revoked / Suspended</span>
                                            </>
                                        ) : (
                                            <>
                                                <div className="h-3 w-3 rounded-full bg-secondary" />
                                                <span className="font-semibold text-secondary-dark uppercase tracking-tighter text-xs">Active / Verified</span>
                                            </>
                                        )}
                                    </div>

                                    <button
                                        type="button"
                                        disabled={isModerating}
                                        onClick={handleToggleArtistStatus}
                                        className={`flex items-center gap-2 rounded-full px-6 py-2.5 text-sm font-bold transition-all ${searchResult.isRevoked
                                            ? 'bg-secondary-light/20 text-secondary-dark hover:bg-secondary-light/40'
                                            : 'bg-red-50 text-red-700 hover:bg-red-100'
                                            } disabled:opacity-50`}
                                    >
                                        {isModerating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                                        {searchResult.isRevoked ? 'Reinstate Permission' : 'Revoke Permission'}
                                    </button>
                                </div>
                            </div>
                        )}
                    </section>

                    {/* Treasury Balances */}
                    <section className="rounded-3xl bg-white p-8 shadow-sm border border-brand-100">
                        <div className="mb-6 flex items-center gap-3">
                            <div className="rounded-xl bg-purple-100 p-2.5">
                                <Wallet className="h-6 w-6 text-purple-600" />
                            </div>
                            <h2 className="font-display text-2xl font-bold text-midnight-950">Treasury Balances</h2>
                        </div>

                        <div className="mb-6 rounded-2xl bg-midnight-900 p-6 text-white overflow-hidden relative">
                            <BarChart3 className="absolute -bottom-6 -right-6 h-32 w-32 opacity-10 rotate-12" />
                            <div className="relative z-10">
                                <p className="text-sm font-medium text-white/60 mb-1">Treasury Address</p>
                                <code className="break-all font-mono text-xs opacity-80 block mb-4">
                                    {stats?.treasuryAddress || "Not configured"}
                                </code>

                                <div className="flex items-end gap-2">
                                    <p className="text-3xl font-bold tracking-tight">
                                        {stats?.treasuryBalances.find(b => b.asset_type === 'native')?.balance || "0.00"}
                                    </p>
                                    <p className="mb-1 text-sm font-medium text-white/60 uppercase">XLM</p>
                                </div>
                            </div>
                        </div>

                        <div className="space-y-4">
                            <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400">Other Assets</h3>
                            {stats?.treasuryBalances && stats.treasuryBalances.length > 1 ? (
                                <div className="divide-y divide-gray-100">
                                    {stats.treasuryBalances.filter(b => b.asset_type !== 'native').map((balance: any, idx) => (
                                        <div key={idx} className="flex items-center justify-between py-3">
                                            <div className="flex flex-col">
                                                <span className="font-bold text-midnight-900">{balance.asset_code}</span>
                                                <span className="text-[10px] text-gray-400 font-mono truncate max-w-[150px]">{balance.asset_issuer}</span>
                                            </div>
                                            <span className="font-medium text-midnight-700">{balance.balance}</span>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="flex flex-col items-center justify-center py-6 text-center">
                                    <AlertCircle className="mb-2 h-8 w-8 text-gray-200" />
                                    <p className="text-sm text-gray-400 italic">No custom assets found in treasury</p>
                                </div>
                            )}
                        </div>
                    </section>

                    {/* Token Whitelist Panel */}
                    <section className="lg:col-span-2 rounded-3xl bg-white p-8 shadow-sm border border-brand-100">
                        <div className="mb-8 flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex items-center gap-3">
                                <div className="rounded-xl bg-mint-100 p-2.5">
                                    <Settings className="h-6 w-6 text-mint-600" />
                                </div>
                                <h2 className="font-display text-2xl font-bold text-midnight-950">Whitelisted Payment Tokens</h2>
                            </div>

                            <div className="flex max-w-md gap-2">
                                <input
                                    type="text"
                                    placeholder="Token Contract ID (C...)"
                                    value={newTokenAddress}
                                    onChange={(e) => setNewTokenAddress(e.target.value)}
                                    className="flex-1 rounded-xl border border-gray-200 px-4 py-2.5 text-sm focus:border-mint-500 focus:outline-none focus:ring-1 focus:ring-mint-500"
                                />
                                <button
                                    type="button"
                                    disabled={isManagingTokens || !newTokenAddress}
                                    onClick={handleWhitelistToken}
                                    className="flex items-center gap-2 rounded-xl bg-secondary-dark px-4 py-2.5 text-sm font-bold text-white transition-all hover:bg-secondary disabled:opacity-50 shadow-md shadow-secondary/10"
                                >
                                    {isManagingTokens ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                                    Add
                                </button>
                            </div>
                        </div>

                        {tokenError && (
                            <div className="mb-6 flex items-center gap-2 rounded-xl bg-red-50 p-4 text-sm text-red-600 border border-red-100">
                                <AlertCircle className="h-4 w-4" />
                                {tokenError}
                            </div>
                        )}

                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            <div className="rounded-2xl border-2 border-gray-100 bg-gray-50/20 p-6">
                                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-brand-100 text-brand-600 font-bold">
                                    X
                                </div>
                                <h4 className="font-bold text-midnight-950">Native Stellar (XLM)</h4>
                                <p className="mt-1 text-xs text-gray-500">Built-in default currency</p>
                                <div className="mt-4 flex items-center gap-2 rounded-full bg-secondary-light/30 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-secondary-dark w-fit">
                                    <CheckCircle2 className="h-3 w-3" />
                                    Default Enabled
                                </div>
                            </div>

                            {whitelistedTokens.map((token) => (
                                <div key={token.address} className="group relative rounded-2xl border border-gray-100 bg-white p-6 shadow-sm hover:border-brand-200 transition-all">
                                    <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-mint-50 text-mint-600 font-bold">
                                        T
                                    </div>
                                    <h4 className="font-bold text-midnight-950 truncate" title={token.address}>
                                        {token.address.slice(0, 8)}...{token.address.slice(-8)}
                                    </h4>
                                    <p className="mt-1 text-xs text-gray-500 font-mono">{token.address.slice(0, 16)}...</p>
                                    <div className="mt-2 text-[10px] text-gray-400">
                                        <span>Added: {token.addedAtLedger}</span>
                                        <span className="mx-1">•</span>
                                        <span className="truncate" title={token.addedBy}>{token.addedBy.slice(0, 8)}...</span>
                                    </div>
                                    
                                    <div className="absolute right-4 top-4 flex gap-1 opacity-0 group-hover:opacity-100 transition-all">
                                        <button
                                            type="button"
                                            aria-label="View token history"
                                            title="View history"
                                            onClick={() => handleViewHistory(token.address)}
                                            className="rounded-lg p-2 text-gray-300 hover:bg-blue-50 hover:text-blue-500 transition-all"
                                        >
                                            <History size={18} />
                                        </button>
                                        <button
                                            type="button"
                                            aria-label="Remove token"
                                            title="Remove token"
                                            onClick={() => handleRemoveToken(token.address)}
                                            className="rounded-lg p-2 text-gray-300 hover:bg-red-50 hover:text-red-500 transition-all"
                                        >
                                            <Trash2 size={18} />
                                        </button>
                                    </div>
                                </div>
                            ))}

                            {isLoadingTokens && (
                                <div className="flex h-32 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-gray-50 bg-gray-50/10 p-6 text-center text-gray-400">
                                    <Loader2 className="h-8 w-8 animate-spin opacity-20 mb-2" />
                                    <p className="text-xs">Loading tokens…</p>
                                </div>
                            )}

                            {!isLoadingTokens && whitelistedTokens.length === 0 && (
                                <div className="flex h-32 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-gray-100 p-6 text-center text-gray-400">
                                    <AlertCircle className="mb-2 h-8 w-8 opacity-20" />
                                    <p className="text-xs italic">No additional SRC-20 tokens whitelisted.</p>
                                </div>
                            )}
                        </div>
                    </section>

                    {/* Auction Configuration */}
                    <section className="rounded-3xl bg-white p-8 shadow-sm border border-brand-100">
                        <div className="mb-6 flex items-center gap-3">
                            <div className="rounded-xl bg-purple-100 p-2.5">
                                <Clock className="h-6 w-6 text-purple-600" />
                            </div>
                            <div>
                                <h2 className="font-display text-2xl font-bold text-midnight-950">Auction Configuration</h2>
                                <p className="mt-0.5 text-sm text-gray-500">Global auction timing and bid increment settings.</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => { refreshAuctionConfig(); }}
                                className="ml-auto flex items-center gap-1.5 rounded-full bg-gray-50 px-4 py-2 text-xs font-semibold text-gray-500 hover:bg-gray-100 border border-gray-200 transition-all"
                            >
                                <Loader2 className={`h-3.5 w-3.5 ${isAuctionConfigLoading ? "animate-spin" : ""}`} />
                                Refresh
                            </button>
                        </div>

                        {auctionConfigError && (
                            <div className="mb-4 flex items-center gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-600 border border-red-100">
                                <AlertCircle className="h-4 w-4 shrink-0" />
                                {auctionConfigError}
                            </div>
                        )}

                        <div className="space-y-6">
                            {/* Minimum Bid Increment */}
                            <div className="rounded-2xl border border-gray-100 p-6">
                                <div className="mb-4">
                                    <h3 className="font-bold text-midnight-950">Minimum Bid Increment</h3>
                                    <p className="mt-0.5 text-sm text-gray-500">Smallest amount by which a bid must exceed the current highest bid.</p>
                                </div>
                                <div className="flex items-center gap-4">
                                    <div className="flex-1">
                                        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Current Value</div>
                                        <div className="font-mono text-lg font-bold text-midnight-900">
                                            {auctionConfig ? stroopsToXlm(auctionConfig.minBidIncrement) : "Loading..."}
                                        </div>
                                    </div>
                                    <div className="flex-1">
                                        <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-gray-400">New Value (XLM)</label>
                                        <input
                                            type="number"
                                            step="0.0000001"
                                            min="0.0000001"
                                            placeholder="0.1"
                                            className="w-full rounded-xl border border-gray-200 py-2.5 px-4 text-sm focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                                            id="min-bid-input"
                                        />
                                    </div>
                                    <button
                                        type="button"
                                        disabled={isAuctionConfigProcessing}
                                        onClick={async () => {
                                            const input = document.getElementById('min-bid-input') as HTMLInputElement;
                                            const value = parseFloat(input.value);
                                            if (isNaN(value) || value <= 0) return;
                                            const stroops = Math.floor(value * 10_000_000);
                                            await setMinBid(BigInt(stroops));
                                            input.value = '';
                                        }}
                                        className="mt-5 flex items-center gap-2 rounded-xl bg-purple-600 px-5 py-2.5 text-sm font-bold text-white transition-all hover:bg-purple-700 disabled:opacity-50 shadow-md shadow-purple-200"
                                    >
                                        {isAuctionConfigProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                                        Update
                                    </button>
                                </div>
                            </div>

                            {/* Extension Window */}
                            <div className="rounded-2xl border border-gray-100 p-6">
                                <div className="mb-4">
                                    <h3 className="font-bold text-midnight-950">Extension Window</h3>
                                    <p className="mt-0.5 text-sm text-gray-500">Time added to auction end when a bid is placed near expiration (anti-sniping).</p>
                                </div>
                                <div className="flex items-center gap-4">
                                    <div className="flex-1">
                                        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Current Value</div>
                                        <div className="font-mono text-lg font-bold text-midnight-900">
                                            {auctionConfig ? `${auctionConfig.extensionWindow}s` : "Loading..."}
                                        </div>
                                    </div>
                                    <div className="flex-1">
                                        <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-gray-400">New Value (seconds)</label>
                                        <input
                                            type="number"
                                            min="0"
                                            placeholder="600"
                                            className="w-full rounded-xl border border-gray-200 py-2.5 px-4 text-sm focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                                            id="extension-window-input"
                                        />
                                    </div>
                                    <button
                                        type="button"
                                        disabled={isAuctionConfigProcessing}
                                        onClick={async () => {
                                            const input = document.getElementById('extension-window-input') as HTMLInputElement;
                                            const value = parseInt(input.value, 10);
                                            if (isNaN(value) || value < 0) return;
                                            await setExtensionWindow(BigInt(value));
                                            input.value = '';
                                        }}
                                        className="mt-5 flex items-center gap-2 rounded-xl bg-purple-600 px-5 py-2.5 text-sm font-bold text-white transition-all hover:bg-purple-700 disabled:opacity-50 shadow-md shadow-purple-200"
                                    >
                                        {isAuctionConfigProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                                        Update
                                    </button>
                                </div>
                            </div>

                            {/* Extension Trigger */}
                            <div className="rounded-2xl border border-gray-100 p-6">
                                <div className="mb-4">
                                    <h3 className="font-bold text-midnight-950">Extension Trigger</h3>
                                    <p className="mt-0.5 text-sm text-gray-500">Time remaining before auction end when extension window activates (0 = disabled).</p>
                                </div>
                                <div className="flex items-center gap-4">
                                    <div className="flex-1">
                                        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Current Value</div>
                                        <div className="font-mono text-lg font-bold text-midnight-900">
                                            {auctionConfig ? `${auctionConfig.extensionTrigger}s` : "Loading..."}
                                        </div>
                                    </div>
                                    <div className="flex-1">
                                        <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-gray-400">New Value (seconds)</label>
                                        <input
                                            type="number"
                                            min="0"
                                            placeholder="0"
                                            className="w-full rounded-xl border border-gray-200 py-2.5 px-4 text-sm focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                                            id="extension-trigger-input"
                                        />
                                    </div>
                                    <button
                                        type="button"
                                        disabled={isAuctionConfigProcessing}
                                        onClick={async () => {
                                            const input = document.getElementById('extension-trigger-input') as HTMLInputElement;
                                            const value = parseInt(input.value, 10);
                                            if (isNaN(value) || value < 0) return;
                                            await setExtensionTrigger(BigInt(value));
                                            input.value = '';
                                        }}
                                        className="mt-5 flex items-center gap-2 rounded-xl bg-purple-600 px-5 py-2.5 text-sm font-bold text-white transition-all hover:bg-purple-700 disabled:opacity-50 shadow-md shadow-purple-200"
                                    >
                                        {isAuctionConfigProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                                        Update
                                    </button>
                                </div>
                            </div>
                        </div>
                    </section>

                    {/* Circuit Breaker Panel (Issue #205) */}
                    <section className="lg:col-span-2 rounded-3xl bg-white p-8 shadow-sm border border-brand-100">
                        <div className="mb-6 flex items-center gap-3">
                            <div className="rounded-xl bg-red-100 p-2.5">
                                <ShieldOff className="h-6 w-6 text-red-600" />
                            </div>
                            <div>
                                <h2 className="font-display text-2xl font-bold text-midnight-950">Circuit Breakers</h2>
                                <p className="mt-0.5 text-sm text-gray-500">Granular pause controls — global, per-collection, or per-function.</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => { refreshPause(); }}
                                className="ml-auto flex items-center gap-1.5 rounded-full bg-gray-50 px-4 py-2 text-xs font-semibold text-gray-500 hover:bg-gray-100 border border-gray-200 transition-all"
                            >
                                <Loader2 className={`h-3.5 w-3.5 ${isPauseLoading ? "animate-spin" : ""}`} />
                                Refresh
                            </button>
                        </div>

                        {pauseError && (
                            <div className="mb-4 flex items-center gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-600 border border-red-100">
                                <AlertCircle className="h-4 w-4 shrink-0" />
                                {pauseError}
                            </div>
                        )}

                        <div className="space-y-8">
                            {/* ── 1. Global toggle ── */}
                            <div className="rounded-2xl border border-gray-100 p-6">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <h3 className="font-bold text-midnight-950">Global Pause</h3>
                                        <p className="mt-0.5 text-sm text-gray-500">Blocks all state-mutating operations marketplace-wide.</p>
                                    </div>
                                    <button
                                        type="button"
                                        disabled={isPauseProcessing}
                                        onClick={toggleGlobalPause}
                                        aria-label={pauseState.globalPaused ? "Unpause contract" : "Pause contract"}
                                        className={`flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-bold transition-all disabled:opacity-50 ${
                                            pauseState.globalPaused
                                                ? "bg-red-600 text-white hover:bg-red-700 shadow-md shadow-red-200"
                                                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                                        }`}
                                    >
                                        {isPauseProcessing ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : pauseState.globalPaused ? (
                                            <ToggleRight className="h-4 w-4" />
                                        ) : (
                                            <ToggleLeft className="h-4 w-4" />
                                        )}
                                        {pauseState.globalPaused ? "PAUSED — Click to Unpause" : "Active — Click to Pause"}
                                    </button>
                                </div>
                            </div>

                            {/* ── 2. Per-function checkboxes ── */}
                            <div className="rounded-2xl border border-gray-100 p-6">
                                <div className="mb-4 flex items-center gap-2">
                                    <Zap className="h-4 w-4 text-amber-500" />
                                    <h3 className="font-bold text-midnight-950">Function Circuit Breakers</h3>
                                </div>
                                <p className="mb-5 text-sm text-gray-500">
                                    Pause a single entry-point globally — e.g., halt all purchases without stopping new listings.
                                </p>
                                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                    {(PAUSABLE_FUNCTIONS as readonly string[]).map((fn) => {
                                        const paused = pauseState.pausedFunctions[fn as import("@/hooks/useAdmin").PausableFunction];
                                        return (
                                            <label
                                                key={fn}
                                                className={`flex cursor-pointer items-center justify-between rounded-xl border px-4 py-3 transition-all ${
                                                    paused
                                                        ? "border-red-200 bg-red-50"
                                                        : "border-gray-100 bg-gray-50/50 hover:border-brand-200"
                                                }`}
                                            >
                                                <span className={`text-sm font-mono font-medium ${paused ? "text-red-700" : "text-midnight-800"}`}>
                                                    {fn}
                                                </span>
                                                <input
                                                    type="checkbox"
                                                    checked={paused}
                                                    disabled={isPauseProcessing}
                                                    onChange={() => toggleFunctionPause(fn as import("@/hooks/useAdmin").PausableFunction)}
                                                    className="h-4 w-4 rounded accent-red-500"
                                                    aria-label={`Toggle pause for ${fn}`}
                                                />
                                            </label>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* ── 3. Per-collection table ── */}
                            <div className="rounded-2xl border border-gray-100 p-6">
                                <div className="mb-4 flex items-center gap-2">
                                    <ShieldAlert className="h-4 w-4 text-orange-500" />
                                    <h3 className="font-bold text-midnight-950">Collection Circuit Breakers</h3>
                                </div>
                                <p className="mb-5 text-sm text-gray-500">
                                    Pause a specific collection — only that collection's listings, auctions, bids, and offers are blocked.
                                </p>
                                {collectionPauseRows.length === 0 ? (
                                    <div className="flex flex-col items-center py-8 text-center text-gray-400">
                                        <AlertCircle className="mb-2 h-7 w-7 opacity-20" />
                                        <p className="text-sm italic">No collections indexed yet.</p>
                                    </div>
                                ) : (
                                    <div className="overflow-x-auto rounded-xl border border-gray-100">
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr className="border-b border-gray-100 bg-gray-50/60">
                                                    <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-gray-400">Collection Address</th>
                                                    <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-gray-400">Status</th>
                                                    <th className="px-4 py-3 text-right text-xs font-bold uppercase tracking-wider text-gray-400">Action</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-gray-50">
                                                {collectionPauseRows.map((row) => (
                                                    <tr key={row.address} className="hover:bg-gray-50/40 transition-colors">
                                                        <td className="px-4 py-3 font-mono text-xs text-midnight-800 max-w-xs truncate" title={row.address}>
                                                            {row.address}
                                                        </td>
                                                        <td className="px-4 py-3">
                                                            {row.paused ? (
                                                                <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-1 text-xs font-bold text-red-600">
                                                                    <ShieldOff className="h-3 w-3" /> Paused
                                                                </span>
                                                            ) : (
                                                                <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2.5 py-1 text-xs font-bold text-green-600">
                                                                    <ShieldCheck className="h-3 w-3" /> Active
                                                                </span>
                                                            )}
                                                        </td>
                                                        <td className="px-4 py-3 text-right">
                                                            <button
                                                                type="button"
                                                                disabled={isPauseProcessing}
                                                                onClick={async () => {
                                                                    await toggleCollectionPause(row.address, row.paused);
                                                                    setCollectionPauseRows(prev =>
                                                                        prev.map(r => r.address === row.address ? { ...r, paused: !r.paused } : r)
                                                                    );
                                                                }}
                                                                className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-all disabled:opacity-50 ${
                                                                    row.paused
                                                                        ? "bg-green-50 text-green-700 hover:bg-green-100"
                                                                        : "bg-red-50 text-red-700 hover:bg-red-100"
                                                                }`}
                                                            >
                                                                {row.paused ? "Unpause" : "Pause"}
                                                            </button>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        </div>
                    </section>

                    {/* Admin Key Rotation Panel (Issue #202) */}
                    <section className="lg:col-span-2 rounded-3xl bg-white p-8 shadow-sm border border-brand-100">
                        <div className="mb-6 flex items-center gap-3">
                            <div className="rounded-xl bg-red-100 p-2.5">
                                <KeyRound className="h-6 w-6 text-red-600" />
                            </div>
                            <h2 className="font-display text-2xl font-bold text-midnight-950">Admin Key Rotation</h2>
                        </div>

                        {rotationError && (
                            <div className="mb-6 flex items-center gap-2 rounded-xl bg-red-50 p-4 text-sm text-red-600 border border-red-100">
                                <AlertCircle className="h-4 w-4" />
                                {rotationError}
                            </div>
                        )}

                        {pendingAdmin ? (
                            <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-6">
                                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                                    <div className="flex flex-col gap-2">
                                        <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-bold uppercase tracking-wider text-amber-700">
                                            <ArrowRightLeft className="h-3 w-3" />
                                            Transfer Pending
                                        </span>
                                        <div>
                                            <span className="text-xs font-bold uppercase tracking-wider text-gray-400">Proposed New Admin</span>
                                            <code className="mt-1 block break-all font-mono text-sm font-medium text-midnight-900">
                                                {pendingAdmin.candidate}
                                            </code>
                                        </div>
                                    </div>
                                    <div className={`flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-bold ${secondsRemaining <= 0 ? "bg-red-100 text-red-700" : "bg-white text-midnight-900 border border-amber-200"}`}>
                                        <Clock className="h-4 w-4" />
                                        <span className="font-mono">{formatCountdown(secondsRemaining)}</span>
                                    </div>
                                </div>

                                <div className="mt-6 flex flex-wrap gap-3">
                                    <button
                                        type="button"
                                        disabled={isRotating}
                                        onClick={async () => { await cancelAdminTransfer(); }}
                                        className="flex items-center gap-2 rounded-full bg-red-50 px-6 py-2.5 text-sm font-bold text-red-700 transition-all hover:bg-red-100 disabled:opacity-50 border border-red-100"
                                    >
                                        {isRotating ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                                        Cancel Proposal
                                    </button>

                                    {isConnectedWalletCandidate && (
                                        <button
                                            type="button"
                                            disabled={isRotating || secondsRemaining <= 0}
                                            onClick={async () => { await acceptAdminTransfer(); }}
                                            className="flex items-center gap-2 rounded-full bg-brand-600 px-6 py-2.5 text-sm font-bold text-white transition-all hover:bg-brand-700 disabled:opacity-50 shadow-md shadow-brand-200"
                                        >
                                            {isRotating ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                                            Accept Admin
                                        </button>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                                <p className="max-w-xl text-gray-600">
                                    Transfer administrative control of the marketplace to a new wallet using a safe,
                                    two-step process. The new admin has 7 days to accept before the proposal expires.
                                </p>
                                <button
                                    type="button"
                                    onClick={() => setIsWizardOpen(true)}
                                    className="flex shrink-0 items-center gap-2 rounded-full bg-midnight-900 px-6 py-3 text-sm font-bold text-white transition-all hover:bg-midnight-800"
                                >
                                    <ArrowRightLeft className="h-4 w-4" />
                                    Start Admin Transfer
                                </button>
                            </div>
                        )}
                    </section>
                </div>

                {/* ── Listing Oversight ────────────────────────────────────────── */}
                <section className="mt-8 rounded-3xl bg-white p-8 shadow-sm border border-brand-100">
                    <div className="mb-6 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                            <div className="rounded-xl bg-brand-100 p-2.5">
                                <List className="h-6 w-6 text-brand-600" />
                            </div>
                            <div>
                                <h2 className="font-display text-2xl font-bold text-midnight-950">Listing Oversight</h2>
                                <p className="text-sm text-gray-500 mt-0.5">
                                    {isOversightLoading ? "Loading…" : `${oversightTotal} listing${oversightTotal !== 1 ? "s" : ""} total`}
                                </p>
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={refreshOversight}
                            className="flex items-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-all"
                        >
                            <Loader2 className={`h-3.5 w-3.5 ${isOversightLoading ? "animate-spin" : ""}`} />
                            Refresh
                        </button>
                    </div>

                    {/* Filter */}
                    <div className="mb-4 relative">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                        <input
                            type="text"
                            placeholder="Filter by artist, collection, or status…"
                            value={oversightFilter}
                            onChange={(e) => { setOversightFilter(e.target.value); setOversightPage(0); }}
                            className="w-full rounded-xl border border-gray-200 py-3 pl-10 pr-4 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                    </div>

                    {oversightError && (
                        <div className="mb-4 flex items-center gap-2 rounded-xl bg-red-50 p-4 text-sm text-red-600 border border-red-100">
                            <AlertCircle className="h-4 w-4 shrink-0" />{oversightError}
                        </div>
                    )}

                    {isOversightLoading ? (
                        <div className="flex items-center justify-center py-16 text-gray-400">
                            <Loader2 className="h-6 w-6 animate-spin mr-3" />
                            <span className="text-sm font-medium">Loading listings…</span>
                        </div>
                    ) : oversightListings.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                            <List className="h-10 w-10 mb-3 opacity-30" />
                            <p className="text-sm font-medium">
                                {oversightFilter ? "No listings match the current filter." : "No listings found."}
                            </p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto rounded-2xl border border-gray-100">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-gray-100 bg-gray-50/60">
                                        <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-gray-400">ID</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-gray-400">Artist</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-gray-400">Collection</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-gray-400">Status</th>
                                        <th className="px-4 py-3 text-right text-xs font-bold uppercase tracking-wider text-gray-400">Created</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {oversightListings.map((l) => (
                                        <tr key={l.listing_id} className="border-b border-gray-50 hover:bg-gray-50/40 transition-colors">
                                            <td className="px-4 py-3 font-mono text-xs text-gray-600">#{l.listing_id}</td>
                                            <td className="px-4 py-3 font-mono text-xs text-gray-700 max-w-[160px] truncate" title={l.artist}>{l.artist}</td>
                                            <td className="px-4 py-3 font-mono text-xs text-gray-700 max-w-[160px] truncate" title={l.collection}>{l.collection}</td>
                                            <td className="px-4 py-3">
                                                <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                                                    l.status === "Active"
                                                        ? "bg-green-50 text-green-700"
                                                        : l.status === "Sold"
                                                        ? "bg-blue-50 text-blue-700"
                                                        : "bg-gray-100 text-gray-500"
                                                }`}>
                                                    {l.status}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-right text-xs text-gray-400">
                                                {new Date(l.created_at * 1000).toLocaleDateString()}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {/* Pagination */}
                    {oversightTotalPages > 1 && (
                        <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
                            <span>
                                Page {oversightPage + 1} of {oversightTotalPages} ({oversightTotal} total)
                            </span>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    disabled={oversightPage === 0}
                                    onClick={() => setOversightPage((p) => Math.max(0, p - 1))}
                                    className="flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                                >
                                    <ChevronLeft className="h-3.5 w-3.5" /> Prev
                                </button>
                                <button
                                    type="button"
                                    disabled={oversightPage >= oversightTotalPages - 1}
                                    onClick={() => setOversightPage((p) => Math.min(oversightTotalPages - 1, p + 1))}
                                    className="flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                                >
                                    Next <ChevronRight className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        </div>
                    )}
                </section>

                {/* ── Content Moderation Triage (Issue #542) ──────────────────── */}
                <section className="mt-8 rounded-3xl bg-white p-8 shadow-sm border border-brand-100">
                    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex items-center gap-3">
                            <div className="rounded-xl bg-red-100 p-2.5">
                                <Flag className="h-6 w-6 text-red-600" />
                            </div>
                            <div>
                                <h2 className="font-display text-2xl font-bold text-midnight-950">Content Moderation</h2>
                                <p className="text-sm text-gray-500 mt-0.5">
                                    {isModerationLoading ? "Loading…" : `${moderationTotal} case${moderationTotal !== 1 ? "s" : ""}`}
                                    {" · "}
                                    <a
                                        href={MODERATION_POLICY_URL}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-1 text-brand-600 hover:underline"
                                    >
                                        Moderation policy <ExternalLink className="h-3 w-3" />
                                    </a>
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <select
                                value={moderationStateFilter}
                                onChange={(e) => setModerationStateFilter(e.target.value as typeof moderationStateFilter)}
                                className="rounded-xl border border-gray-200 py-2 px-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                            >
                                <option value="">All states</option>
                                <option value="PENDING">Pending</option>
                                <option value="APPROVED">Approved</option>
                                <option value="REPORTED">Reported</option>
                                <option value="QUARANTINED">Quarantined</option>
                                <option value="REJECTED">Rejected</option>
                            </select>
                            <button
                                type="button"
                                onClick={refreshModeration}
                                className="flex items-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-all"
                            >
                                <Loader2 className={`h-3.5 w-3.5 ${isModerationLoading ? "animate-spin" : ""}`} />
                                Refresh
                            </button>
                        </div>
                    </div>

                    {moderationError && (
                        <div className="mb-4 flex items-center gap-2 rounded-xl bg-red-50 p-4 text-sm text-red-600 border border-red-100">
                            <AlertCircle className="h-4 w-4 shrink-0" />{moderationError}
                        </div>
                    )}

                    {isModerationLoading ? (
                        <div className="flex items-center justify-center py-16 text-gray-400">
                            <Loader2 className="h-6 w-6 animate-spin mr-3" />
                            <span className="text-sm font-medium">Loading cases…</span>
                        </div>
                    ) : moderationCases.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                            <ShieldCheck className="h-10 w-10 mb-3 opacity-30" />
                            <p className="text-sm font-medium">No moderation cases match this filter.</p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto rounded-2xl border border-gray-100">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-gray-100 bg-gray-50/60">
                                        <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-gray-400">CID</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-gray-400">Kind</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-gray-400">State</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-gray-400">Reports</th>
                                        <th className="px-4 py-3 text-right text-xs font-bold uppercase tracking-wider text-gray-400">Updated</th>
                                        <th className="px-4 py-3 text-right text-xs font-bold uppercase tracking-wider text-gray-400">Action</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {moderationCases.map((c) => (
                                        <tr key={c.id} className="border-b border-gray-50 hover:bg-gray-50/40 transition-colors">
                                            <td className="px-4 py-3 font-mono text-xs text-gray-700 max-w-[200px] truncate" title={c.cid}>{c.cid}</td>
                                            <td className="px-4 py-3 text-xs text-gray-500">{c.kind}</td>
                                            <td className="px-4 py-3">
                                                <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                                                    c.state === "APPROVED" ? "bg-green-50 text-green-700"
                                                    : c.state === "PENDING" ? "bg-gray-100 text-gray-600"
                                                    : c.state === "REPORTED" ? "bg-amber-50 text-amber-700"
                                                    : "bg-red-50 text-red-700"
                                                }`}>
                                                    {c.state}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-xs text-gray-600">{c.reportCount}</td>
                                            <td className="px-4 py-3 text-right text-xs text-gray-400">
                                                {new Date(c.updatedAt).toLocaleDateString()}
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                <button
                                                    type="button"
                                                    onClick={() => { setModerationReason(""); openModerationCase(c.cid); }}
                                                    className="rounded-lg px-3 py-1.5 text-xs font-bold text-brand-600 hover:bg-brand-50 transition-all"
                                                >
                                                    Review
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </section>
            </div>

            {/* Moderation Case Detail Drawer */}
            {selectedModerationCase && (
                <div className="fixed inset-0 z-50 flex">
                    <div className="fixed inset-0 bg-black/50" onClick={closeModerationCase} />
                    <div className="relative ml-auto h-full w-full max-w-lg bg-white shadow-xl overflow-y-auto">
                        <div className="flex items-center justify-between border-b p-6">
                            <div>
                                <h2 className="text-xl font-bold text-midnight-950">Moderation Case</h2>
                                <p className="mt-1 text-sm text-gray-500 font-mono break-all">{selectedModerationCase.cid}</p>
                            </div>
                            <button
                                type="button"
                                onClick={closeModerationCase}
                                className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                            >
                                <X size={20} />
                            </button>
                        </div>

                        <div className="p-6 space-y-6">
                            {/* Current state + decision */}
                            <div className="rounded-2xl border border-gray-100 p-5">
                                <div className="mb-3 flex items-center justify-between">
                                    <span className="text-xs font-bold uppercase tracking-wider text-gray-400">Current State</span>
                                    <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold bg-gray-100 text-gray-700">
                                        {selectedModerationCase.state}
                                    </span>
                                </div>
                                <textarea
                                    value={moderationReason}
                                    onChange={(e) => setModerationReason(e.target.value.slice(0, 1000))}
                                    rows={3}
                                    placeholder="Internal reason (never shown publicly)…"
                                    className="mb-3 w-full resize-none rounded-xl border border-gray-200 px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                                />
                                <div className="flex flex-wrap gap-2">
                                    <button
                                        type="button"
                                        disabled={isModerationProcessing}
                                        onClick={() => decideModeration(selectedModerationCase.cid, "APPROVED", moderationReason || undefined)}
                                        className="rounded-lg bg-green-50 px-4 py-2 text-xs font-bold text-green-700 hover:bg-green-100 disabled:opacity-50"
                                    >
                                        Approve
                                    </button>
                                    <button
                                        type="button"
                                        disabled={isModerationProcessing}
                                        onClick={() => decideModeration(selectedModerationCase.cid, "QUARANTINED", moderationReason || undefined)}
                                        className="rounded-lg bg-amber-50 px-4 py-2 text-xs font-bold text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                                    >
                                        Quarantine
                                    </button>
                                    <button
                                        type="button"
                                        disabled={isModerationProcessing}
                                        onClick={() => decideModeration(selectedModerationCase.cid, "REJECTED", moderationReason || undefined)}
                                        className="rounded-lg bg-red-50 px-4 py-2 text-xs font-bold text-red-700 hover:bg-red-100 disabled:opacity-50"
                                    >
                                        Reject
                                    </button>
                                </div>
                            </div>

                            {/* Reports (operator-only — includes reporter identity) */}
                            <div>
                                <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-midnight-950">
                                    <Flag className="h-4 w-4 text-red-500" /> Reports ({selectedModerationCase.reports.length})
                                </h3>
                                <div className="space-y-2">
                                    {selectedModerationCase.reports.map((r) => (
                                        <div key={r.id} className="rounded-xl border border-gray-100 bg-gray-50/50 p-3 text-xs">
                                            <div className="flex justify-between font-semibold text-gray-700">
                                                <span>{r.category}</span>
                                                <span className="font-mono text-gray-400">{r.reporterAddress ? `${r.reporterAddress.slice(0, 6)}…${r.reporterAddress.slice(-4)}` : "anonymous"}</span>
                                            </div>
                                            {r.description && <p className="mt-1 text-gray-500">{r.description}</p>}
                                        </div>
                                    ))}
                                    {selectedModerationCase.reports.length === 0 && (
                                        <p className="text-xs text-gray-400 italic">No reports on file.</p>
                                    )}
                                </div>
                            </div>

                            {/* Decisions audit trail */}
                            <div>
                                <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-midnight-950">
                                    <History className="h-4 w-4 text-gray-400" /> Decision History
                                </h3>
                                <div className="space-y-2">
                                    {selectedModerationCase.decisions.map((d) => (
                                        <div key={d.id} className="rounded-xl border border-gray-100 p-3 text-xs text-gray-500">
                                            <span className="font-semibold text-gray-700">{d.previousState} → {d.newState}</span>
                                            {" · "}
                                            <span className="font-mono">{d.actor.slice(0, 8)}…</span>
                                            {" · "}
                                            {new Date(d.createdAt).toLocaleString()}
                                            {d.reason && <p className="mt-1">{d.reason}</p>}
                                        </div>
                                    ))}
                                    {selectedModerationCase.decisions.length === 0 && (
                                        <p className="text-xs text-gray-400 italic">No decisions recorded yet.</p>
                                    )}
                                </div>
                            </div>

                            {/* Appeals */}
                            <div>
                                <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-midnight-950">
                                    <Scale className="h-4 w-4 text-purple-500" /> Appeals ({selectedModerationCase.appeals.length})
                                </h3>
                                <div className="space-y-3">
                                    {selectedModerationCase.appeals.map((a) => (
                                        <div key={a.id} className="rounded-xl border border-gray-100 p-3 text-xs">
                                            <div className="flex justify-between font-semibold text-gray-700">
                                                <span className="font-mono">{a.appellantAddress.slice(0, 8)}…</span>
                                                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                                    a.status === "OVERTURNED" ? "bg-green-50 text-green-700"
                                                    : a.status === "UPHELD" ? "bg-red-50 text-red-700"
                                                    : "bg-gray-100 text-gray-600"
                                                }`}>{a.status}</span>
                                            </div>
                                            <p className="mt-1 text-gray-500">{a.statement}</p>
                                            {a.status === "PENDING" || a.status === "UNDER_REVIEW" ? (
                                                <div className="mt-2 flex gap-2">
                                                    <button
                                                        type="button"
                                                        disabled={isModerationProcessing}
                                                        onClick={() => resolveModerationAppeal(a.id, "OVERTURNED")}
                                                        className="rounded-lg bg-green-50 px-3 py-1 text-[10px] font-bold text-green-700 hover:bg-green-100 disabled:opacity-50"
                                                    >
                                                        Overturn
                                                    </button>
                                                    <button
                                                        type="button"
                                                        disabled={isModerationProcessing}
                                                        onClick={() => resolveModerationAppeal(a.id, "UPHELD")}
                                                        className="rounded-lg bg-red-50 px-3 py-1 text-[10px] font-bold text-red-700 hover:bg-red-100 disabled:opacity-50"
                                                    >
                                                        Uphold
                                                    </button>
                                                </div>
                                            ) : null}
                                        </div>
                                    ))}
                                    {selectedModerationCase.appeals.length === 0 && (
                                        <p className="text-xs text-gray-400 italic">No appeals filed.</p>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <AdminConfirmationModal
                isOpen={confirmConfig.isOpen}
                onClose={() => setConfirmConfig(prev => ({ ...prev, isOpen: false }))}
                onConfirm={confirmConfig.onConfirm}
                title={confirmConfig.title}
                actionDescription={confirmConfig.actionDescription}
                consequences={confirmConfig.consequences}
                variant={confirmConfig.variant}
                isProcessing={isModerating || isManagingTokens}
            />

            <AdminTransferWizard
                isOpen={isWizardOpen}
                isProcessing={isRotating}
                onClose={() => setIsWizardOpen(false)}
                onSubmit={async (candidate) => {
                    const ok = await proposeNewAdmin(candidate);
                    if (ok) setIsWizardOpen(false);
                    return ok;
                }}
            />

            {/* Token History Drawer */}
            {historyDrawerOpen && selectedTokenHistory && (
                <div className="fixed inset-0 z-50 flex">
                    <div 
                        className="fixed inset-0 bg-black/50"
                        onClick={() => setHistoryDrawerOpen(false)}
                    />
                    <div className="relative ml-auto h-full w-full max-w-md bg-white shadow-xl">
                        <div className="flex h-full flex-col">
                            <div className="flex items-center justify-between border-b p-6">
                                <div>
                                    <h2 className="text-xl font-bold text-midnight-950">Token History</h2>
                                    <p className="mt-1 text-sm text-gray-500 font-mono">
                                        {selectedTokenHistory.address.slice(0, 12)}...{selectedTokenHistory.address.slice(-8)}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setHistoryDrawerOpen(false)}
                                    className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                                >
                                    <X size={20} />
                                </button>
                            </div>
                            <div className="flex-1 overflow-y-auto p-6">
                                {selectedTokenHistory.events.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center h-full text-gray-400">
                                        <History className="h-12 w-12 mb-2 opacity-20" />
                                        <p className="text-sm">No history available</p>
                                    </div>
                                ) : (
                                    <div className="space-y-4">
                                        {selectedTokenHistory.events.map((event, idx) => (
                                            <div key={idx} className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <div className={`rounded-full p-1.5 ${
                                                        event.type === 'whitelisted' 
                                                            ? 'bg-green-100 text-green-600' 
                                                            : 'bg-red-100 text-red-600'
                                                    }`}>
                                                        {event.type === 'whitelisted' ? (
                                                            <CheckCircle2 className="h-4 w-4" />
                                                        ) : (
                                                            <X className="h-4 w-4" />
                                                        )}
                                                    </div>
                                                    <span className="font-semibold text-sm capitalize">
                                                        {event.type === 'whitelisted' ? 'Token Whitelisted' : 'Token Removed'}
                                                    </span>
                                                </div>
                                                <div className="space-y-1 text-xs text-gray-500">
                                                    <div className="flex justify-between">
                                                        <span>Ledger:</span>
                                                        <span className="font-mono">{event.ledger}</span>
                                                    </div>
                                                    <div className="flex justify-between">
                                                        <span>By:</span>
                                                        <span className="font-mono">{event.actor.slice(0, 8)}...</span>
                                                    </div>
                                                    <div className="flex justify-between">
                                                        <span>Timestamp:</span>
                                                        <span>{new Date(event.timestamp).toLocaleString()}</span>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div >
    );
}

// ── Admin Transfer Wizard (Issue #202) ────────────────────────────────────────

/**
 * Three-step modal that guides the current admin through proposing a new admin:
 *   1. Enter the candidate Stellar address (validated).
 *   2. Acknowledge the 7-day acceptance window and its implications.
 *   3. Confirm and submit the `transfer_admin` (propose) transaction.
 */
function AdminTransferWizard({
    isOpen,
    isProcessing,
    onClose,
    onSubmit,
}: {
    isOpen: boolean;
    isProcessing: boolean;
    onClose: () => void;
    onSubmit: (candidate: string) => Promise<boolean>;
}) {
    const [step, setStep] = useState<1 | 2 | 3>(1);
    const [candidate, setCandidate] = useState("");

    // Reset to a clean state whenever the modal is (re)opened.
    useEffect(() => {
        if (isOpen) {
            setStep(1);
            setCandidate("");
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const trimmed = candidate.trim();
    const isValid = isValidStellarAddress(trimmed);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-midnight-950/50 p-4 backdrop-blur-sm">
            <div className="w-full max-w-lg rounded-3xl bg-white p-8 shadow-2xl">
                {/* Header */}
                <div className="mb-6 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="rounded-xl bg-red-100 p-2.5">
                            <KeyRound className="h-6 w-6 text-red-600" />
                        </div>
                        <h3 className="font-display text-2xl font-bold text-midnight-950">Transfer Admin</h3>
                    </div>
                    <button
                        type="button"
                        aria-label="Close"
                        onClick={onClose}
                        className="rounded-lg p-2 text-gray-400 transition-all hover:bg-gray-100 hover:text-gray-600"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                {/* Step indicator */}
                <div className="mb-8 flex items-center gap-2">
                    {[1, 2, 3].map((s) => (
                        <div
                            key={s}
                            className={`h-1.5 flex-1 rounded-full transition-colors ${s <= step ? "bg-brand-500" : "bg-gray-200"}`}
                        />
                    ))}
                </div>

                {/* Step 1 — candidate address */}
                {step === 1 && (
                    <div>
                        <label className="mb-2 block text-sm font-bold text-midnight-900">
                            New Admin Stellar Address
                        </label>
                        <input
                            type="text"
                            autoFocus
                            placeholder="G..."
                            value={candidate}
                            onChange={(e) => setCandidate(e.target.value)}
                            className="w-full rounded-xl border border-gray-200 px-4 py-3 font-mono text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                        {trimmed.length > 0 && !isValid && (
                            <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-red-600">
                                <AlertCircle className="h-3.5 w-3.5" />
                                Not a valid Stellar public key (must start with G and be 56 characters).
                            </p>
                        )}
                        {isValid && (
                            <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-green-600">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                Valid Stellar address.
                            </p>
                        )}
                        <div className="mt-8 flex justify-end">
                            <button
                                type="button"
                                disabled={!isValid}
                                onClick={() => setStep(2)}
                                className="flex items-center gap-2 rounded-full bg-midnight-900 px-6 py-2.5 text-sm font-bold text-white transition-all hover:bg-midnight-800 disabled:opacity-40"
                            >
                                Continue
                                <ChevronRight className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                )}

                {/* Step 2 — warning */}
                {step === 2 && (
                    <div>
                        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
                            <div className="mb-3 flex items-center gap-2 text-amber-800">
                                <AlertTriangle className="h-5 w-5" />
                                <span className="font-bold">Please read carefully</span>
                            </div>
                            <ul className="space-y-2 text-sm text-amber-900">
                                <li>• The proposed admin has <strong>7 days</strong> to accept before the proposal expires.</li>
                                <li>• Until they accept, <strong>you remain the admin</strong> and can cancel the proposal at any time.</li>
                                <li>• Once accepted, <strong>this wallet loses all admin rights</strong> and cannot reverse the transfer.</li>
                                <li>• Ensure the address below is correct and that you control it or trust its owner.</li>
                            </ul>
                        </div>
                        <div className="mt-4 rounded-xl bg-gray-50 p-4">
                            <span className="text-xs font-bold uppercase tracking-wider text-gray-400">New Admin</span>
                            <code className="mt-1 block break-all font-mono text-sm text-midnight-900">{trimmed}</code>
                        </div>
                        <div className="mt-8 flex justify-between">
                            <button
                                type="button"
                                onClick={() => setStep(1)}
                                className="rounded-full px-6 py-2.5 text-sm font-bold text-gray-500 transition-all hover:bg-gray-100"
                            >
                                Back
                            </button>
                            <button
                                type="button"
                                onClick={() => setStep(3)}
                                className="flex items-center gap-2 rounded-full bg-midnight-900 px-6 py-2.5 text-sm font-bold text-white transition-all hover:bg-midnight-800"
                            >
                                I Understand
                                <ChevronRight className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                )}

                {/* Step 3 — confirm + submit */}
                {step === 3 && (
                    <div>
                        <p className="text-gray-600">
                            You are about to propose <span className="font-semibold text-midnight-900">a new marketplace administrator</span>.
                            This submits an on-chain transaction from your wallet.
                        </p>
                        <div className="mt-4 rounded-xl bg-gray-50 p-4">
                            <span className="text-xs font-bold uppercase tracking-wider text-gray-400">Proposing</span>
                            <code className="mt-1 block break-all font-mono text-sm text-midnight-900">{trimmed}</code>
                        </div>
                        <div className="mt-8 flex justify-between">
                            <button
                                type="button"
                                disabled={isProcessing}
                                onClick={() => setStep(2)}
                                className="rounded-full px-6 py-2.5 text-sm font-bold text-gray-500 transition-all hover:bg-gray-100 disabled:opacity-40"
                            >
                                Back
                            </button>
                            <button
                                type="button"
                                disabled={isProcessing || !isValid}
                                onClick={async () => { await onSubmit(trimmed); }}
                                className="flex items-center gap-2 rounded-full bg-brand-600 px-6 py-2.5 text-sm font-bold text-white transition-all hover:bg-brand-700 disabled:opacity-50 shadow-md shadow-brand-200"
                            >
                                {isProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRightLeft className="h-4 w-4" />}
                                Submit Proposal
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function StatCard({ title, value, icon, color }: { title: string; value: string; icon: React.ReactNode; color: string }) {
    return (
        <div className="group rounded-3xl bg-white p-6 shadow-sm transition-all hover:shadow-md border border-brand-100">
            <div className={`mb-4 inline-flex items-center justify-center rounded-2xl p-3 text-white ${color} shadow-lg transition-transform group-hover:scale-110`}>
                {icon}
            </div>
            <p className="text-sm font-medium text-gray-500">{title}</p>
            <p className="mt-1 font-display text-3xl font-bold text-midnight-950">{value}</p>
        </div>
    );
}
