// ─────────────────────────────────────────────────────────────
// hooks/useAdmin.ts — Administrative hooks for stats + moderation
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useEffect, useCallback } from "react";
import {
    getTotalListings,
    getAllListings,
    getTreasury,
    getProtocolFee,
    getAdmin,
    revokeArtist,
    reinstateArtist,
    type Listing,
    isArtistRevoked,
    addTokenToWhitelist,
    removeTokenFromWhitelist,
    getTokenWhitelist,
    getPendingAdmin,
    proposeAdmin,
    acceptAdmin,
    cancelAdminProposal,
    getAuctionConfig,
    setMinBidIncrement,
    setAuctionExtensionWindow,
    setAuctionExtensionTrigger,
    type PendingAdminProposal,
    type AuctionConfig
} from "@/lib/contract";
import { Horizon } from "@stellar/stellar-sdk";
import { config } from "@/lib/config";
import { emitAuditEvent, extractTxHash } from "@/lib/auditLog";
import { pseudonymiseAddress } from "@/lib/privacy";
import {
    listModerationCases,
    getModerationCaseFull,
    decideModerationCase,
    decideAppeal,
    type ModerationCaseFull,
    type ModerationState,
} from "@/lib/moderation";

export interface AdminStats {
    totalListings: number;
    totalUsers: number;
    protocolFeeBps: number;
    treasuryAddress: string | null;
    treasuryBalances: any[];
}

export function useAdminStats() {
    const [stats, setStats] = useState<AdminStats | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const totalListings = await getTotalListings();
            const allListings = await getAllListings();

            // Calculate unique users (artists)
            const uniqueArtists = new Set(allListings.map(l => l.artist));
            const totalUsers = uniqueArtists.size;

            const protocolFeeBps = await getProtocolFee();
            const treasuryAddress = await getTreasury();

            let treasuryBalances: any[] = [];
            if (treasuryAddress) {
                const horizon = new Horizon.Server(config.horizonUrl);
                const account = await horizon.loadAccount(treasuryAddress).catch(() => null);
                if (account) {
                    treasuryBalances = account.balances;
                }
            }

            setStats({
                totalListings,
                totalUsers,
                protocolFeeBps,
                treasuryAddress,
                treasuryBalances
            });
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Failed to load admin stats");
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    return { stats, isLoading, error, refresh };
}

export function useModeration(adminPublicKey: string | null) {
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const revoke = async (artistAddress: string) => {
        if (!adminPublicKey) return;
        setIsProcessing(true);
        setError(null);
        emitAuditEvent("artist.revoke", adminPublicKey, "initiated", {
            target: pseudonymiseAddress(artistAddress),
            network: config.network,
        });
        try {
            const result = await revokeArtist(adminPublicKey, artistAddress);
            emitAuditEvent("artist.revoke", adminPublicKey, "success", {
                target: pseudonymiseAddress(artistAddress),
                txHash: extractTxHash(result) ?? undefined,
                network: config.network,
                contractId: config.contractId,
            });
            return true;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Revoke failed";
            const category = msg.toLowerCase().includes("rejected") || msg.toLowerCase().includes("cancelled")
                ? "rejected" as const
                : "failed" as const;
            emitAuditEvent("artist.revoke", adminPublicKey, category, {
                target: pseudonymiseAddress(artistAddress),
                errorMessage: msg,
                network: config.network,
            });
            setError(msg);
            return false;
        } finally {
            setIsProcessing(false);
        }
    };

    const reinstate = async (artistAddress: string) => {
        if (!adminPublicKey) return;
        setIsProcessing(true);
        setError(null);
        emitAuditEvent("artist.reinstate", adminPublicKey, "initiated", {
            target: pseudonymiseAddress(artistAddress),
            network: config.network,
        });
        try {
            const result = await reinstateArtist(adminPublicKey, artistAddress);
            emitAuditEvent("artist.reinstate", adminPublicKey, "success", {
                target: pseudonymiseAddress(artistAddress),
                txHash: extractTxHash(result) ?? undefined,
                network: config.network,
                contractId: config.contractId,
            });
            return true;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Reinstate failed";
            const category = msg.toLowerCase().includes("rejected") || msg.toLowerCase().includes("cancelled")
                ? "rejected" as const
                : "failed" as const;
            emitAuditEvent("artist.reinstate", adminPublicKey, category, {
                target: pseudonymiseAddress(artistAddress),
                errorMessage: msg,
                network: config.network,
            });
            setError(msg);
            return false;
        } finally {
            setIsProcessing(false);
        }
    };

    const checkStatus = async (artistAddress: string) => {
        try {
            const revoked = await isArtistRevoked(artistAddress);
            return revoked;
        } catch {
            return false;
        }
    };

    return { revoke, reinstate, checkStatus, isProcessing, error };
}

export interface WhitelistedToken {
    address: string;
    addedAtLedger: number;
    addedBy: string;
}

export interface TokenHistory {
    address: string;
    active: boolean;
    addedAtLedger: number;
    addedBy: string;
    removedAtLedger: number | null;
    removedBy: string | null;
    createdAt: string;
    updatedAt: string;
}

export function useTokenManagement(adminPublicKey: string | null) {
    const [whitelistedTokens, setWhitelistedTokens] = useState<WhitelistedToken[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const response = await fetch(`${config.indexerUrl}/tokens`);
            if (!response.ok) throw new Error('Failed to fetch tokens');
            const data = await response.json();
            setWhitelistedTokens(data.tokens || []);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Failed to load whitelist");
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const getTokenHistory = useCallback(async (address: string): Promise<TokenHistory | null> => {
        try {
            const response = await fetch(`${config.indexerUrl}/tokens/${address}/history`);
            if (!response.ok) return null;
            return await response.json();
        } catch {
            return null;
        }
    }, []);

    const whitelist = async (tokenAddress: string) => {
        if (!adminPublicKey) return;
        setIsProcessing(true);
        setError(null);
        emitAuditEvent("token.whitelist_add", adminPublicKey, "initiated", {
            target: pseudonymiseAddress(tokenAddress),
            network: config.network,
        });
        // Optimistic update
        const prev = [...whitelistedTokens];
        setWhitelistedTokens(curr => [...curr, { 
            address: tokenAddress, 
            addedAtLedger: 0, 
            addedBy: adminPublicKey 
        }]);

        try {
            const result = await addTokenToWhitelist(adminPublicKey, tokenAddress);
            emitAuditEvent("token.whitelist_add", adminPublicKey, "success", {
                target: pseudonymiseAddress(tokenAddress),
                txHash: extractTxHash(result) ?? undefined,
                network: config.network,
                contractId: config.contractId,
            });
            await refresh(); // Refresh to get actual data from indexer
            return true;
        } catch (err: unknown) {
            setWhitelistedTokens(prev); // Rollback
            const msg = err instanceof Error ? err.message : "Whitelist failed";
            const category = msg.toLowerCase().includes("rejected") || msg.toLowerCase().includes("cancelled")
                ? "rejected" as const : "failed" as const;
            emitAuditEvent("token.whitelist_add", adminPublicKey, category, {
                target: pseudonymiseAddress(tokenAddress),
                errorMessage: msg,
                network: config.network,
            });
            setError(msg);
            return false;
        } finally {
            setIsProcessing(false);
        }
    };

    const unwhitelist = async (tokenAddress: string) => {
        if (!adminPublicKey) return;
        setIsProcessing(true);
        setError(null);
        emitAuditEvent("token.whitelist_remove", adminPublicKey, "initiated", {
            target: pseudonymiseAddress(tokenAddress),
            network: config.network,
        });
        // Optimistic update
        const prev = [...whitelistedTokens];
        setWhitelistedTokens(curr => curr.filter(t => t.address !== tokenAddress));

        try {
            const result = await removeTokenFromWhitelist(adminPublicKey, tokenAddress);
            emitAuditEvent("token.whitelist_remove", adminPublicKey, "success", {
                target: pseudonymiseAddress(tokenAddress),
                txHash: extractTxHash(result) ?? undefined,
                network: config.network,
                contractId: config.contractId,
            });
            await refresh(); // Refresh to get actual data from indexer
            return true;
        } catch (err: unknown) {
            setWhitelistedTokens(prev); // Rollback
            const msg = err instanceof Error ? err.message : "Unwhitelist failed";
            const category = msg.toLowerCase().includes("rejected") || msg.toLowerCase().includes("cancelled")
                ? "rejected" as const : "failed" as const;
            emitAuditEvent("token.whitelist_remove", adminPublicKey, category, {
                target: pseudonymiseAddress(tokenAddress),
                errorMessage: msg,
                network: config.network,
            });
            setError(msg);
            return false;
        } finally {
            setIsProcessing(false);
        }
    };

    return { whitelistedTokens, whitelist, unwhitelist, isLoading, isProcessing, error, refresh, getTokenHistory };
}

/**
 * Two-step admin key rotation (Issue #202).
 *
 * Loads the currently-pending proposal (if any) and exposes propose / accept /
 * cancel actions.  The pending proposal is refreshed after every mutating call
 * so the UI countdown and available actions stay in sync with chain state.
 */
export function useAdminTransfer(currentPublicKey: string | null) {
    const [pending, setPending] = useState<PendingAdminProposal | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setIsLoading(true);
        try {
            setPending(await getPendingAdmin());
        } catch {
            setPending(null);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const propose = async (candidate: string) => {
        if (!currentPublicKey) return false;
        setIsProcessing(true);
        setError(null);
        emitAuditEvent("admin.transfer_propose", currentPublicKey, "initiated", {
            target: pseudonymiseAddress(candidate),
            network: config.network,
        });
        try {
            const result = await proposeAdmin(currentPublicKey, candidate);
            emitAuditEvent("admin.transfer_propose", currentPublicKey, "success", {
                target: pseudonymiseAddress(candidate),
                txHash: extractTxHash(result) ?? undefined,
                network: config.network,
                contractId: config.contractId,
            });
            await refresh();
            return true;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Proposal failed";
            const category = msg.toLowerCase().includes("rejected") || msg.toLowerCase().includes("cancelled")
                ? "rejected" as const : "failed" as const;
            emitAuditEvent("admin.transfer_propose", currentPublicKey, category, {
                target: pseudonymiseAddress(candidate),
                errorMessage: msg,
                network: config.network,
            });
            setError(msg);
            return false;
        } finally {
            setIsProcessing(false);
        }
    };

    const accept = async () => {
        if (!currentPublicKey) return false;
        setIsProcessing(true);
        setError(null);
        emitAuditEvent("admin.transfer_accept", currentPublicKey, "initiated", {
            network: config.network,
        });
        try {
            const result = await acceptAdmin(currentPublicKey);
            emitAuditEvent("admin.transfer_accept", currentPublicKey, "success", {
                txHash: extractTxHash(result) ?? undefined,
                network: config.network,
                contractId: config.contractId,
            });
            await refresh();
            return true;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Accept failed";
            const category = msg.toLowerCase().includes("rejected") || msg.toLowerCase().includes("cancelled")
                ? "rejected" as const : "failed" as const;
            emitAuditEvent("admin.transfer_accept", currentPublicKey, category, {
                errorMessage: msg,
                network: config.network,
            });
            setError(msg);
            return false;
        } finally {
            setIsProcessing(false);
        }
    };

    const cancel = async () => {
        if (!currentPublicKey) return false;
        setIsProcessing(true);
        setError(null);
        emitAuditEvent("admin.transfer_cancel", currentPublicKey, "initiated", {
            network: config.network,
        });
        try {
            const result = await cancelAdminProposal(currentPublicKey);
            emitAuditEvent("admin.transfer_cancel", currentPublicKey, "success", {
                txHash: extractTxHash(result) ?? undefined,
                network: config.network,
                contractId: config.contractId,
            });
            await refresh();
            return true;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Cancel failed";
            const category = msg.toLowerCase().includes("rejected") || msg.toLowerCase().includes("cancelled")
                ? "rejected" as const : "failed" as const;
            emitAuditEvent("admin.transfer_cancel", currentPublicKey, category, {
                errorMessage: msg,
                network: config.network,
            });
            setError(msg);
            return false;
        } finally {
            setIsProcessing(false);
        }
    };

    return { pending, isLoading, isProcessing, error, refresh, propose, accept, cancel };
}

export function useAdminCheck(currentPublicKey: string | null) {
    const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const check = async () => {
            if (!currentPublicKey) {
                setIsAdmin(false);
                setIsLoading(false);
                return;
            }
            try {
                const adminAddr = await getAdmin();
                setIsAdmin(adminAddr === currentPublicKey);
            } catch {
                setIsAdmin(false);
            } finally {
                setIsLoading(false);
            }
        };
        check();
    }, [currentPublicKey]);

    return { isAdmin, isLoading };
}

// ── Granular pause controls hook (Issue #205) ─────────────────────────────────

import {
    adminPause,
    adminUnpause,
    getIsContractPaused,
    pauseCollection,
    unpauseCollection,
    pauseFunction,
    unpauseFunction,
    isFunctionPaused,
} from "@/lib/contract";

/** The five entry-points that can be individually paused. */
export const PAUSABLE_FUNCTIONS = [
    "buy_artwork",
    "create_listing",
    "place_bid",
    "create_auction",
    "make_offer",
] as const;
export type PausableFunction = typeof PAUSABLE_FUNCTIONS[number];

export interface PauseState {
    globalPaused: boolean;
    pausedFunctions: Record<PausableFunction, boolean>;
}

/**
 * Hook for the three-section circuit-breaker panel in the admin page.
 *
 * Exposes:
 *  - `state`       — current pause state (global + per-function)
 *  - `refresh()`   — re-read all pause flags from the chain
 *  - `toggleGlobal()` — toggle the global pause
 *  - `toggleCollection(address)` — pause/unpause a single collection
 *  - `toggleFunction(name)` — pause/unpause a single entry-point
 */
export function usePauseControls(adminPublicKey: string | null) {
    const [state, setState] = useState<PauseState>({
        globalPaused: false,
        pausedFunctions: {
            buy_artwork: false,
            create_listing: false,
            place_bid: false,
            create_auction: false,
            make_offer: false,
        },
    });
    const [isLoading, setIsLoading] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const [globalPaused, ...fnStates] = await Promise.all([
                getIsContractPaused(),
                ...PAUSABLE_FUNCTIONS.map((fn) => isFunctionPaused(fn)),
            ]);
            const pausedFunctions = Object.fromEntries(
                PAUSABLE_FUNCTIONS.map((fn, i) => [fn, fnStates[i]])
            ) as Record<PausableFunction, boolean>;
            setState({ globalPaused, pausedFunctions });
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Failed to load pause state");
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const toggleGlobal = useCallback(async () => {
        if (!adminPublicKey) return;
        setIsProcessing(true);
        setError(null);
        const action = state.globalPaused ? "pause.global_disable" : "pause.global_enable";
        emitAuditEvent(action, adminPublicKey, "initiated", { network: config.network });
        try {
            let result: unknown;
            if (state.globalPaused) {
                result = await adminUnpause(adminPublicKey);
            } else {
                result = await adminPause(adminPublicKey);
            }
            emitAuditEvent(action, adminPublicKey, "success", {
                txHash: extractTxHash(result) ?? undefined,
                network: config.network,
                contractId: config.contractId,
            });
            await refresh();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Toggle failed";
            const category = msg.toLowerCase().includes("rejected") || msg.toLowerCase().includes("cancelled")
                ? "rejected" as const : "failed" as const;
            emitAuditEvent(action, adminPublicKey, category, {
                errorMessage: msg,
                network: config.network,
            });
            setError(msg);
        } finally {
            setIsProcessing(false);
        }
    }, [adminPublicKey, state.globalPaused, refresh]);

    const toggleCollection = useCallback(async (collectionAddress: string, currentlyPaused: boolean) => {
        if (!adminPublicKey) return;
        setIsProcessing(true);
        setError(null);
        const action = currentlyPaused ? "pause.collection_disable" : "pause.collection_enable";
        emitAuditEvent(action, adminPublicKey, "initiated", {
            target: pseudonymiseAddress(collectionAddress),
            network: config.network,
        });
        try {
            let result: unknown;
            if (currentlyPaused) {
                result = await unpauseCollection(adminPublicKey, collectionAddress);
            } else {
                result = await pauseCollection(adminPublicKey, collectionAddress);
            }
            emitAuditEvent(action, adminPublicKey, "success", {
                target: pseudonymiseAddress(collectionAddress),
                txHash: extractTxHash(result) ?? undefined,
                network: config.network,
                contractId: config.contractId,
            });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Collection toggle failed";
            const category = msg.toLowerCase().includes("rejected") || msg.toLowerCase().includes("cancelled")
                ? "rejected" as const : "failed" as const;
            emitAuditEvent(action, adminPublicKey, category, {
                target: pseudonymiseAddress(collectionAddress),
                errorMessage: msg,
                network: config.network,
            });
            setError(msg);
        } finally {
            setIsProcessing(false);
        }
    }, [adminPublicKey]);

    const toggleFunction = useCallback(async (fn: PausableFunction) => {
        if (!adminPublicKey) return;
        setIsProcessing(true);
        setError(null);
        const action = state.pausedFunctions[fn] ? "pause.function_disable" : "pause.function_enable";
        emitAuditEvent(action, adminPublicKey, "initiated", {
            target: fn,
            network: config.network,
        });
        // Optimistic update
        setState(prev => ({
            ...prev,
            pausedFunctions: { ...prev.pausedFunctions, [fn]: !prev.pausedFunctions[fn] },
        }));
        try {
            let result: unknown;
            if (state.pausedFunctions[fn]) {
                result = await unpauseFunction(adminPublicKey, fn);
            } else {
                result = await pauseFunction(adminPublicKey, fn);
            }
            emitAuditEvent(action, adminPublicKey, "success", {
                target: fn,
                txHash: extractTxHash(result) ?? undefined,
                network: config.network,
                contractId: config.contractId,
            });
            await refresh();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Function toggle failed";
            const category = msg.toLowerCase().includes("rejected") || msg.toLowerCase().includes("cancelled")
                ? "rejected" as const : "failed" as const;
            emitAuditEvent(action, adminPublicKey, category, {
                target: fn,
                errorMessage: msg,
                network: config.network,
            });
            setError(msg);
            await refresh(); // rollback optimistic update
        } finally {
            setIsProcessing(false);
        }
    }, [adminPublicKey, state.pausedFunctions, refresh]);

    return {
        state,
        isLoading,
        isProcessing,
        error,
        refresh,
        toggleGlobal,
        toggleCollection,
        toggleFunction,
    };
}

// ── Auction configuration ────────────────────────────────────────────────────────

export function useAuctionConfig(adminPublicKey: string | null) {
    const [config, setConfig] = useState<AuctionConfig | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        if (!adminPublicKey) return;
        setIsLoading(true);
        setError(null);
        try {
            const data = await getAuctionConfig();
            setConfig(data);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Failed to load auction config");
        } finally {
            setIsLoading(false);
        }
    }, [adminPublicKey]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const setMinBid = useCallback(async (increment: bigint) => {
        if (!adminPublicKey) return;
        setIsProcessing(true);
        setError(null);
        emitAuditEvent("auction_config.set_min_increment", adminPublicKey, "initiated", {
            value: increment.toString(),
        });
        try {
            await setMinBidIncrement(adminPublicKey, increment);
            await refresh();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Failed to set min bid increment";
            setError(msg);
        } finally {
            setIsProcessing(false);
        }
    }, [adminPublicKey, refresh]);

    const setExtensionWindow = useCallback(async (window: bigint) => {
        if (!adminPublicKey) return;
        setIsProcessing(true);
        setError(null);
        emitAuditEvent("auction_config.set_extension_window", adminPublicKey, "initiated", {
            value: window.toString(),
        });
        try {
            await setAuctionExtensionWindow(adminPublicKey, window);
            await refresh();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Failed to set extension window";
            setError(msg);
        } finally {
            setIsProcessing(false);
        }
    }, [adminPublicKey, refresh]);

    const setExtensionTrigger = useCallback(async (trigger: bigint) => {
        if (!adminPublicKey) return;
        setIsProcessing(true);
        setError(null);
        emitAuditEvent("auction_config.set_extension_trigger", adminPublicKey, "initiated", {
            value: trigger.toString(),
        });
        try {
            await setAuctionExtensionTrigger(adminPublicKey, trigger);
            await refresh();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Failed to set extension trigger";
            setError(msg);
        } finally {
            setIsProcessing(false);
        }
    }, [adminPublicKey, refresh]);

    return {
        config,
        isLoading,
        isProcessing,
        error,
        refresh,
        setMinBid,
        setExtensionWindow,
        setExtensionTrigger,
    };
}

// ── useListingOversight ───────────────────────────────────────────────────────

const LISTING_PAGE_SIZE = 20;

export interface ListingOversightRow {
    listing_id: number;
    artist: string;
    collection: string;
    status: string;
    price: bigint;
    currency: string;
    created_at: number;
}

export function useListingOversight(adminPublicKey: string | null) {
    const [allListings, setAllListings] = useState<ListingOversightRow[]>([]);
    const [page, setPage] = useState(0);
    const [filter, setFilter] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        if (!adminPublicKey) return;
        setIsLoading(true);
        setError(null);
        try {
            const raw: Listing[] = await getAllListings();
            setAllListings(
                raw.map((l) => ({
                    listing_id: l.listing_id,
                    artist: l.artist,
                    collection: l.collection,
                    status: l.status,
                    price: l.price,
                    currency: l.currency,
                    created_at: l.created_at,
                }))
            );
            setPage(0);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Failed to load listings');
        } finally {
            setIsLoading(false);
        }
    }, [adminPublicKey]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const filtered = allListings.filter((l) => {
        if (!filter) return true;
        const q = filter.toLowerCase();
        return (
            l.artist.toLowerCase().includes(q) ||
            l.collection.toLowerCase().includes(q) ||
            l.status.toLowerCase().includes(q)
        );
    });

    const totalPages = Math.max(1, Math.ceil(filtered.length / LISTING_PAGE_SIZE));
    const safePage = Math.min(page, totalPages - 1);
    const paginated = filtered.slice(
        safePage * LISTING_PAGE_SIZE,
        (safePage + 1) * LISTING_PAGE_SIZE
    );

    return {
        listings: paginated,
        totalCount: filtered.length,
        page: safePage,
        totalPages,
        setPage,
        filter,
        setFilter,
        isLoading,
        error,
        refresh,
    };
}

// ── useModerationQueue (Issue #542) ────────────────────────────────────────────
//
// Operator triage queue for content moderation cases. Calls route through
// the Next.js server-side proxy under app/api/moderation/admin/* so the
// indexer's OPERATOR_TOKEN never reaches the browser bundle — see
// lib/moderation.ts for the underlying fetch calls.

export function useModerationQueue(adminPublicKey: string | null) {
    const [cases, setCases] = useState<ModerationCaseFull[]>([]);
    const [total, setTotal] = useState(0);
    const [stateFilter, setStateFilter] = useState<ModerationState | "">("");
    const [selectedCase, setSelectedCase] = useState<ModerationCaseFull | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        if (!adminPublicKey) return;
        setIsLoading(true);
        setError(null);
        try {
            const { cases: rows, total: count } = await listModerationCases({
                state: stateFilter || undefined,
                limit: 50,
            });
            setCases(rows);
            setTotal(count);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Failed to load moderation cases");
        } finally {
            setIsLoading(false);
        }
    }, [adminPublicKey, stateFilter]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const openCase = useCallback(async (cid: string) => {
        try {
            const full = await getModerationCaseFull(cid);
            setSelectedCase(full);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Failed to load case detail");
        }
    }, []);

    const closeCase = useCallback(() => setSelectedCase(null), []);

    const decide = useCallback(async (
        cid: string,
        state: "APPROVED" | "QUARANTINED" | "REJECTED",
        reason?: string
    ) => {
        if (!adminPublicKey) return false;
        setIsProcessing(true);
        setError(null);
        emitAuditEvent("moderation.decision", adminPublicKey, "initiated", {
            target: cid,
            value: state,
        });
        try {
            await decideModerationCase(cid, { state, actor: adminPublicKey, reason });
            emitAuditEvent("moderation.decision", adminPublicKey, "success", {
                target: cid,
                value: state,
            });
            await refresh();
            if (selectedCase?.cid === cid) await openCase(cid);
            return true;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Failed to record decision";
            emitAuditEvent("moderation.decision", adminPublicKey, "failed", { target: cid, errorMessage: msg });
            setError(msg);
            return false;
        } finally {
            setIsProcessing(false);
        }
    }, [adminPublicKey, refresh, selectedCase, openCase]);

    const resolveAppeal = useCallback(async (
        appealId: number,
        status: "UPHELD" | "OVERTURNED",
        decisionReason?: string
    ) => {
        if (!adminPublicKey) return false;
        setIsProcessing(true);
        setError(null);
        emitAuditEvent("moderation.appeal_decision", adminPublicKey, "initiated", {
            target: String(appealId),
            value: status,
        });
        try {
            await decideAppeal(appealId, { status, decidedBy: adminPublicKey, decisionReason });
            emitAuditEvent("moderation.appeal_decision", adminPublicKey, "success", {
                target: String(appealId),
                value: status,
            });
            await refresh();
            if (selectedCase) await openCase(selectedCase.cid);
            return true;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Failed to resolve appeal";
            emitAuditEvent("moderation.appeal_decision", adminPublicKey, "failed", { target: String(appealId), errorMessage: msg });
            setError(msg);
            return false;
        } finally {
            setIsProcessing(false);
        }
    }, [adminPublicKey, refresh, selectedCase, openCase]);

    return {
        cases,
        total,
        stateFilter,
        setStateFilter,
        selectedCase,
        openCase,
        closeCase,
        decide,
        resolveAppeal,
        isLoading,
        isProcessing,
        error,
        refresh,
    };
}
