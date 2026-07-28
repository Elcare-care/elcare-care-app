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
    isArtistRevoked,
    addTokenToWhitelist,
    removeTokenFromWhitelist,
    getTokenWhitelist,
    getPendingAdmin,
    proposeAdmin,
    acceptAdmin,
    cancelAdminProposal,
    type PendingAdminProposal
} from "@/lib/contract";
import { Horizon } from "@stellar/stellar-sdk";
import { config } from "@/lib/config";
import { emitAuditEvent, extractTxHash } from "@/lib/auditLog";
import { pseudonymiseAddress } from "@/lib/privacy";

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
