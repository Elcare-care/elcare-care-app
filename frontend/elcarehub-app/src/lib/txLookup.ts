// ─────────────────────────────────────────────────────────────────────────────
// lib/txLookup.ts — Transaction hash lookup client (Issue #301)
//
// Provides two functions for recovering transaction status from a hash:
//
//   lookupTxOnRpc(hash, options)
//     → Polls the Soroban RPC directly with bounded retries and cancellation.
//       Used by the /tx/[hash] recovery page and by useTxLifecycle when it
//       needs to confirm an already-submitted transaction after a page reload.
//
//   lookupTxOnIndexer(hash, options)
//     → Queries the ELCARE-HUB indexer for enriched event data (related
//       resources, events, explorer URL).  Falls back gracefully.
//
//   lookupTx(hash, options)
//     → Combines both calls; returns a TxLookupResult that merges the chain
//       status from the RPC with the event/resource data from the indexer.
//
// Network-context validation:
//   The caller passes the expected network passphrase.  If the indexer
//   returns a `network` field that does not match, the result carries
//   chainStatus: "wrong_network" so the UI can give an instant, clear error.
//
// Security note:
//   This module never handles secret keys or XDR signing.  It only reads
//   public data (transaction status, indexed events) from the RPC and
//   indexer endpoints.
// ─────────────────────────────────────────────────────────────────────────────

import { SorobanRpc } from "@stellar/stellar-sdk";
import { config } from "./config";

// ── Status types ──────────────────────────────────────────────────────────────

/**
 * Authoritative on-chain status returned by the Soroban RPC.
 *
 * - success       : included in a finalized ledger, all operations succeeded
 * - failed        : included in a finalized ledger, at least one op failed
 * - pending       : submitted but not yet included in any ledger
 * - not_found     : RPC has no record (may be very recent or too old)
 * - wrong_network : the hash was looked up on the wrong network passphrase
 * - rpc_error     : the RPC itself returned an error or was unreachable
 */
export type TxChainStatus =
  | "success"
  | "failed"
  | "pending"
  | "not_found"
  | "wrong_network"
  | "rpc_error";

/**
 * Indexer ingestion status.
 *
 * - confirmed : at least one event for this hash is in the indexer database
 * - pending   : the chain confirmed but indexer hasn't ingested it yet
 * - not_found : no indexer data (includes the case where the chain failed)
 */
export type TxIndexerStatus = "confirmed" | "pending" | "not_found";

/** A single marketplace event associated with the transaction. */
export interface TxEvent {
  id: number;
  eventType: string;
  listingId?: string | null;
  auctionId?: string | null;
  actor: string;
  ledgerSequence: number;
  ledgerTimestamp?: string | null;
  contractId?: string | null;
}

/** Resources related to the transaction (listing, auction, offer). */
export interface TxRelatedResources {
  listing_id?: string | null;
  auction_id?: string | null;
  offer_id?: string | null;
}

/**
 * Combined result from both the RPC and the indexer.
 */
export interface TxLookupResult {
  hash: string;
  /** Network passphrase-validated chain status */
  chainStatus: TxChainStatus;
  /** Indexer ingestion status (not_found when chain failed/not_found) */
  indexerStatus: TxIndexerStatus;
  /**
   * True when chainStatus is "success" but indexerStatus is not yet "confirmed".
   * The UI should show a "catching up" message rather than an error.
   */
  staleIndexer: boolean;
  /** Ledger sequence in which the transaction was included (0 when unknown) */
  ledger: number;
  /** Error result XDR when the transaction failed on-chain */
  errorResultXdr?: string;
  /** Network name from the indexer response (e.g. "testnet", "mainnet") */
  network: string;
  /** Stellar Expert explorer URL (network-aware) */
  explorerUrl: string;
  /** Indexed marketplace events for this transaction */
  events: TxEvent[];
  /** Related marketplace resources */
  relatedResources: TxRelatedResources;
  /** Human-readable error message when something went wrong during lookup */
  lookupError?: string;
}

// ── Lookup options ────────────────────────────────────────────────────────────

export interface TxLookupOptions {
  /**
   * Maximum number of RPC poll iterations before giving up.
   * Each iteration waits `pollIntervalMs` ms.
   * Defaults to 10.
   */
  maxPollAttempts?: number;

  /**
   * Base delay between RPC poll attempts in ms.
   * The actual delay follows the schedule in POLL_INTERVALS_MS.
   * Defaults to 2 000 ms.
   */
  pollIntervalMs?: number;

  /**
   * Expected network passphrase.  When provided and the indexer returns a
   * different network, the result will carry chainStatus: "wrong_network".
   * Defaults to config.networkPassphrase.
   */
  expectedNetwork?: string;

  /**
   * AbortSignal to cancel an in-progress poll loop.
   * Pass signal.abort() to stop polling (e.g. on component unmount).
   */
  signal?: AbortSignal;

  /**
   * Override the Soroban RPC URL (useful for tests).
   * Defaults to config.rpcUrl.
   */
  rpcUrl?: string;

  /**
   * Override the indexer base URL (useful for tests).
   * Defaults to config.indexerUrl.
   */
  indexerUrl?: string;
}

// ── Internal constants ────────────────────────────────────────────────────────

/** Stepped poll intervals in ms: 2s, 3s, 4s, 5s, 5s, … */
const POLL_INTERVALS_MS = [2_000, 3_000, 4_000, 5_000, 5_000];

function pollInterval(attempt: number): number {
  return POLL_INTERVALS_MS[Math.min(attempt, POLL_INTERVALS_MS.length - 1)];
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

function buildExplorerUrl(hash: string, network: string): string {
  const net = network === "mainnet" ? "mainnet" : "testnet";
  return `https://stellar.expert/explorer/${net}/tx/${hash}`;
}

/** Validate that a hash is a 64-character hex string. */
export function isValidTxHash(hash: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(hash);
}

// ── RPC lookup ────────────────────────────────────────────────────────────────

/**
 * Polls the Soroban RPC for the status of a submitted transaction.
 *
 * Behaviour:
 *   - Returns immediately on SUCCESS or FAILED.
 *   - Polls up to `maxPollAttempts` times while the status is NOT_FOUND.
 *   - The AbortSignal stops the loop on component unmount.
 *   - Returns chainStatus "not_found" after exhausting retries.
 *   - Returns chainStatus "rpc_error" if the RPC is unreachable.
 *
 * Does NOT throw — the caller should inspect chainStatus.
 */
export async function lookupTxOnRpc(
  hash: string,
  opts: TxLookupOptions = {}
): Promise<{
  chainStatus: TxChainStatus;
  ledger: number;
  errorResultXdr?: string;
}> {
  const {
    maxPollAttempts = 10,
    rpcUrl = config.rpcUrl,
    signal,
  } = opts;

  if (!isValidTxHash(hash)) {
    return { chainStatus: "not_found", ledger: 0 };
  }

  const rpc = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });

  for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
    if (signal?.aborted) {
      return { chainStatus: "not_found", ledger: 0 };
    }

    try {
      const result = await rpc.getTransaction(hash);

      if (result.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        const success = result as SorobanRpc.Api.GetSuccessfulTransactionResponse;
        return {
          chainStatus: "success",
          ledger: (success as any).ledger ?? 0,
        };
      }

      if (result.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        const failed = result as SorobanRpc.Api.GetFailedTransactionResponse;
        return {
          chainStatus: "failed",
          ledger: (failed as any).ledger ?? 0,
          errorResultXdr: (failed as any).errorResult
            ? JSON.stringify((failed as any).errorResult)
            : undefined,
        };
      }

      // NOT_FOUND — transaction is pending or unknown; wait and retry
      if (attempt < maxPollAttempts - 1) {
        await sleep(pollInterval(attempt), signal);
      }
    } catch (err: unknown) {
      // Abort is expected on component unmount
      if (err instanceof DOMException && err.name === "AbortError") {
        return { chainStatus: "not_found", ledger: 0 };
      }
      // RPC error — return immediately rather than retrying on network failures
      return { chainStatus: "rpc_error", ledger: 0 };
    }
  }

  // Exhausted retries: the tx is not yet visible on the RPC
  return { chainStatus: "not_found", ledger: 0 };
}

// ── Indexer lookup ────────────────────────────────────────────────────────────

/** Shape the indexer returns for GET /transactions/:hash */
interface IndexerTxResponse {
  hash: string;
  chain_status?: string;
  indexer_status?: string;
  stale_indexer?: boolean;
  explorer_url?: string;
  events?: TxEvent[];
  related_resources?: TxRelatedResources;
  network?: string;
}

/**
 * Queries the ELCARE-HUB indexer for transaction enrichment data.
 *
 * Returns null when the indexer is unreachable or returns 404.
 * The caller uses RPC data as the source of truth for chainStatus.
 */
export async function lookupTxOnIndexer(
  hash: string,
  opts: TxLookupOptions = {}
): Promise<IndexerTxResponse | null> {
  const { indexerUrl = config.indexerUrl, signal } = opts;

  if (!isValidTxHash(hash)) return null;

  try {
    const url = `${indexerUrl}/transactions/${hash}`;
    const res = await fetch(url, { signal });

    if (res.status === 404) return null;
    if (!res.ok) return null;

    const data: IndexerTxResponse = await res.json();
    return data;
  } catch (err: unknown) {
    // Abort or network error — treat as unavailable
    if (err instanceof DOMException && err.name === "AbortError") {
      return null;
    }
    return null;
  }
}

// ── Combined lookup ───────────────────────────────────────────────────────────

/**
 * Combines the Soroban RPC poll with the indexer enrichment query.
 *
 * Strategy:
 *   1. Fire both the RPC poll and the indexer query concurrently.
 *   2. Use the RPC result as the authoritative chainStatus.
 *   3. Enrich with events / resources / related IDs from the indexer.
 *   4. If the indexer returns a `network` field that doesn't match the
 *      expected passphrase, override chainStatus → "wrong_network".
 *
 * Does NOT throw. Inspect `chainStatus` and `lookupError` on the result.
 */
export async function lookupTx(
  hash: string,
  opts: TxLookupOptions = {}
): Promise<TxLookupResult> {
  const {
    expectedNetwork = config.networkPassphrase,
    signal,
  } = opts;

  const networkName = config.network ?? "testnet";

  const empty: TxLookupResult = {
    hash,
    chainStatus: "not_found",
    indexerStatus: "not_found",
    staleIndexer: false,
    ledger: 0,
    network: networkName,
    explorerUrl: buildExplorerUrl(hash, networkName),
    events: [],
    relatedResources: {},
  };

  if (!isValidTxHash(hash)) {
    return {
      ...empty,
      lookupError: "Invalid transaction hash — must be 64 hexadecimal characters.",
    };
  }

  // Run RPC poll and indexer query concurrently
  const [rpcResult, indexerData] = await Promise.allSettled([
    lookupTxOnRpc(hash, opts),
    lookupTxOnIndexer(hash, { ...opts, maxPollAttempts: 1 }),
  ]);

  const rpc = rpcResult.status === "fulfilled"
    ? rpcResult.value
    : { chainStatus: "rpc_error" as TxChainStatus, ledger: 0 };

  const idx = indexerData.status === "fulfilled" ? indexerData.value : null;

  // ── Network validation ─────────────────────────────────────────────────────
  // The indexer embeds the network it runs against in its response.
  // Cross-check it with the expected passphrase from config.
  if (idx?.network) {
    const indexerNet = idx.network.toLowerCase();
    const expectedNet = expectedNetwork.toLowerCase();
    // A simple heuristic: "mainnet" vs "testnet" substring matching
    const isMainnetExpected = expectedNet.includes("public global");
    const isMainnetIndexer = indexerNet === "mainnet" || indexerNet.includes("public global");
    if (isMainnetExpected !== isMainnetIndexer) {
      return {
        ...empty,
        chainStatus: "wrong_network",
        indexerStatus: "not_found",
        network: idx.network,
        explorerUrl: buildExplorerUrl(hash, idx.network),
        lookupError: `This transaction belongs to ${idx.network}, but your wallet is connected to ${isMainnetExpected ? "Mainnet" : "Testnet"}.`,
      };
    }
  }

  // ── Determine indexer status ───────────────────────────────────────────────
  let indexerStatus: TxIndexerStatus = "not_found";
  if (idx) {
    if (idx.indexer_status === "confirmed" || (idx.events && idx.events.length > 0)) {
      indexerStatus = "confirmed";
    } else if (rpc.chainStatus === "success") {
      // Chain confirmed but indexer hasn't caught up yet
      indexerStatus = "pending";
    }
  } else if (rpc.chainStatus === "success") {
    // Indexer unreachable but chain confirmed — treat as pending ingestion
    indexerStatus = "pending";
  }

  const staleIndexer = rpc.chainStatus === "success" && indexerStatus !== "confirmed";

  return {
    hash,
    chainStatus: rpc.chainStatus,
    indexerStatus,
    staleIndexer,
    ledger: rpc.ledger,
    errorResultXdr: rpc.errorResultXdr,
    network: idx?.network ?? networkName,
    explorerUrl: idx?.explorer_url ?? buildExplorerUrl(hash, idx?.network ?? networkName),
    events: idx?.events ?? [],
    relatedResources: idx?.related_resources ?? {},
  };
}

// ── Bounded auto-poll helper ──────────────────────────────────────────────────

/**
 * Poll intervals for the auto-refresh loop in the /tx/[hash] page.
 * Backs off from 3 s → 5 s → 10 s → 15 s → 30 s and holds there.
 */
export const TX_PAGE_POLL_INTERVALS_MS = [3_000, 5_000, 10_000, 15_000, 30_000];

export function nextTxPageInterval(attempt: number): number {
  return TX_PAGE_POLL_INTERVALS_MS[
    Math.min(attempt, TX_PAGE_POLL_INTERVALS_MS.length - 1)
  ];
}

/**
 * Returns true when the result is in a terminal state that does NOT need
 * further polling.
 */
export function isTxLookupTerminal(result: TxLookupResult): boolean {
  switch (result.chainStatus) {
    case "success":
      return !result.staleIndexer; // keep polling while indexer is catching up
    case "failed":
    case "wrong_network":
      return true;
    case "not_found":
    case "pending":
    case "rpc_error":
      return false;
  }
}
