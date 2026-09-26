"use client";

import { useState, useEffect, useCallback } from "react";
import {
  getAllCollections,
  getCollectionsByCreator,
  getCollectionMetadata,
  deployNormal721,
  deployNormal1155,
  deployLazy721,
  deployLazy1155,
  preflightDeployNormal721,
  preflightDeployNormal1155,
  preflightDeployLazy721,
  preflightDeployLazy1155,
  CollectionRecord,
  CollectionMetadata,
  CollectionKind,
  PreflightResult,
} from "@/lib/launchpad";
import { assertSupportedTokenAddress } from "@/lib/token-support";
import { decodeContractError } from "@/lib/contractErrors/decodeContractError";

// ── useLaunchpadCollections ───────────────────────────────────

export function useLaunchpadCollections() {
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const all = await getAllCollections();
      setCollections(all);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load collections");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { collections, isLoading, error, refresh };
}

// ── useCreatorCollections ─────────────────────────────────────

export function useCreatorCollections(creatorPublicKey: string | null) {
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!creatorPublicKey) return;
    setIsLoading(true);
    setError(null);
    try {
      const results = await getCollectionsByCreator(creatorPublicKey);
      setCollections(results);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load creator collections");
    } finally {
      setIsLoading(false);
    }
  }, [creatorPublicKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { collections, isLoading, error, refresh };
}

// ── useCollectionDetail ───────────────────────────────────────

export function useCollectionDetail(address: string | null) {
  const [metadata, setMetadata] = useState<CollectionMetadata | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!address) return;
    setIsLoading(true);
    setError(null);
    try {
      const data = await getCollectionMetadata(address);
      setMetadata(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load collection metadata");
    } finally {
      setIsLoading(false);
    }
  }, [address]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { metadata, isLoading, error, refresh };
}

// ── useDeployCollection ───────────────────────────────────────

export interface DeployCollectionInput {
  kind: CollectionKind;
  name: string;
  symbol?: string; // only for 721
  maxSupply?: number; // only for 721
  royaltyBps: number;
  royaltyReceiver: string;
  currencyAddress: string;
  creatorPubkeyBytes?: Buffer; // only for Lazy
  platformFeeBps?: number;
  /**
   * Deterministic deploy salt. Pass the same salt used for
   * `usePreflightDeploy` so the predicted address shown to the creator
   * matches the address the transaction actually deploys to (#277).
   * A fresh random salt is generated when omitted.
   */
  salt?: Buffer;
}

/**
 * Generates a stable, wizard-lifetime salt so the address predicted by
 * `usePreflightDeploy` is guaranteed to match the address `useDeployCollection`
 * ends up deploying to (#277).
 */
export function useDeploySalt(): Buffer {
  const [salt] = useState(() => {
    const buf = Buffer.alloc(32);
    window.crypto.getRandomValues(buf);
    return buf;
  });
  return salt;
}

async function runPreflight(
  input: DeployCollectionInput,
  creatorPublicKey: string,
  currencyAddress: string,
  salt: Buffer
): Promise<PreflightResult> {
  switch (input.kind) {
    case "Normal721":
      return preflightDeployNormal721(
        creatorPublicKey,
        currencyAddress,
        input.name,
        input.symbol || "",
        input.maxSupply || 0,
        input.royaltyBps,
        input.platformFeeBps || 0,
        salt
      );
    case "Normal1155":
      return preflightDeployNormal1155(
        creatorPublicKey,
        currencyAddress,
        input.name,
        input.royaltyBps,
        input.platformFeeBps || 0,
        salt
      );
    case "LazyMint721":
      return preflightDeployLazy721(
        creatorPublicKey,
        currencyAddress,
        input.name,
        input.symbol || "",
        input.maxSupply || 0,
        input.royaltyBps,
        input.platformFeeBps || 0,
        salt
      );
    case "LazyMint1155":
      return preflightDeployLazy1155(
        creatorPublicKey,
        currencyAddress,
        input.name,
        input.royaltyBps,
        input.platformFeeBps || 0,
        salt
      );
  }
}

/**
 * Read-only preflight for the collection wizard's Review step (#277).
 * Re-runs whenever the relevant form fields or the salt change, and never
 * requests a wallet signature.
 */
export function usePreflightDeploy(
  creatorPublicKey: string | null,
  input: DeployCollectionInput | null,
  salt: Buffer
) {
  const [result, setResult] = useState<PreflightResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputKey = input
    ? JSON.stringify({
        kind: input.kind,
        name: input.name,
        symbol: input.symbol,
        maxSupply: input.maxSupply,
        royaltyBps: input.royaltyBps,
        currencyAddress: input.currencyAddress,
        platformFeeBps: input.platformFeeBps,
      })
    : null;

  useEffect(() => {
    if (!creatorPublicKey || !input) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    assertSupportedTokenAddress(input.currencyAddress, "collection")
      .then((token) => runPreflight(input, creatorPublicKey, token.address, salt))
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setResult(null);
          setError(err instanceof Error ? err.message : "Preflight check failed");
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creatorPublicKey, inputKey, salt]);

  return { result, isLoading, error };
}

export function useDeployCollection(creatorPublicKey: string | null) {
  const [isDeploying, setIsDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deploy = useCallback(
    async (input: DeployCollectionInput): Promise<string | null> => {
      if (!creatorPublicKey) {
        setError("Wallet not connected");
        return null;
      }

      setIsDeploying(true);
      setError(null);

      try {
        const token = await assertSupportedTokenAddress(input.currencyAddress, "collection");
        let salt = input.salt;
        if (!salt) {
          salt = Buffer.alloc(32);
          window.crypto.getRandomValues(salt);
        }

        let address = "";

        const platformFeeBps = input.platformFeeBps || 0;

        switch (input.kind) {
          case "Normal721":
            address = await deployNormal721(
              creatorPublicKey,
              token.address,
              input.name,
              input.symbol || "",
              input.maxSupply || 0,
              input.royaltyBps,
              input.royaltyReceiver,
              platformFeeBps,
              salt
            );
            break;
          case "Normal1155":
            address = await deployNormal1155(
              creatorPublicKey,
              token.address,
              input.name,
              input.royaltyBps,
              input.royaltyReceiver,
              platformFeeBps,
              salt
            );
            break;
          case "LazyMint721":
            if (!input.creatorPubkeyBytes) throw new Error("Missing creator pubkey bytes");
            address = await deployLazy721(
              creatorPublicKey,
              token.address,
              input.creatorPubkeyBytes,
              input.name,
              input.symbol || "",
              input.maxSupply || 0,
              input.royaltyBps,
              input.royaltyReceiver,
              platformFeeBps,
              salt
            );
            break;
          case "LazyMint1155":
            if (!input.creatorPubkeyBytes) throw new Error("Missing creator pubkey bytes");
            address = await deployLazy1155(
              creatorPublicKey,
              token.address,
              input.creatorPubkeyBytes,
              input.name,
              input.royaltyBps,
              input.royaltyReceiver,
              platformFeeBps,
              salt
            );
            break;
        }

        return address;
      } catch (err: unknown) {
        const decoded = decodeContractError(err, "launchpad");
        setError(decoded.message);
        return null;
      } finally {
        setIsDeploying(false);
      }
    },
    [creatorPublicKey]
  );

  return { deploy, isDeploying, error };
}
