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
        try {
            await revokeArtist(adminPublicKey, artistAddress);
            return true;
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Revoke failed");
            return false;
        } finally {
            setIsProcessing(false);
        }
    };

    const reinstate = async (artistAddress: string) => {
        if (!adminPublicKey) return;
        setIsProcessing(true);
        setError(null);
        try {
            await reinstateArtist(adminPublicKey, artistAddress);
            return true;
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Reinstate failed");
            return false;
        } finally {
            setIsProcessing(false);
        }
    };

    const checkStatus = async (artistAddress: string) => {
        try {
            return await isArtistRevoked(artistAddress);
        } catch {
            return false;
        }
    };

    return { revoke, reinstate, checkStatus, isProcessing, error };
}

export function useTokenManagement(adminPublicKey: string | null) {
    const [whitelistedTokens, setWhitelistedTokens] = useState<string[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const tokens = await getTokenWhitelist();
            setWhitelistedTokens(tokens);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Failed to load whitelist");
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const whitelist = async (tokenAddress: string) => {
        if (!adminPublicKey) return;
        setIsProcessing(true);
        setError(null);
        
        // Optimistic update
        const prev = [...whitelistedTokens];
        setWhitelistedTokens(curr => [...curr, tokenAddress]);

        try {
            await addTokenToWhitelist(adminPublicKey, tokenAddress);
            return true;
        } catch (err: unknown) {
            setWhitelistedTokens(prev); // Rollback
            setError(err instanceof Error ? err.message : "Whitelist failed");
            return false;
        } finally {
            setIsProcessing(false);
        }
    };

    const unwhitelist = async (tokenAddress: string) => {
        if (!adminPublicKey) return;
        setIsProcessing(true);
        setError(null);

        // Optimistic update
        const prev = [...whitelistedTokens];
        setWhitelistedTokens(curr => curr.filter(t => t !== tokenAddress));

        try {
            await removeTokenFromWhitelist(adminPublicKey, tokenAddress);
            return true;
        } catch (err: unknown) {
            setWhitelistedTokens(prev); // Rollback
            setError(err instanceof Error ? err.message : "Unwhitelist failed");
            return false;
        } finally {
            setIsProcessing(false);
        }
    };

    return { whitelistedTokens, whitelist, unwhitelist, isLoading, isProcessing, error, refresh };
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
        try {
            await proposeAdmin(currentPublicKey, candidate);
            await refresh();
            return true;
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Proposal failed");
            return false;
        } finally {
            setIsProcessing(false);
        }
    };

    const accept = async () => {
        if (!currentPublicKey) return false;
        setIsProcessing(true);
        setError(null);
        try {
            await acceptAdmin(currentPublicKey);
            await refresh();
            return true;
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Accept failed");
            return false;
        } finally {
            setIsProcessing(false);
        }
    };

    const cancel = async () => {
        if (!currentPublicKey) return false;
        setIsProcessing(true);
        setError(null);
        try {
            await cancelAdminProposal(currentPublicKey);
            await refresh();
            return true;
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Cancel failed");
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
