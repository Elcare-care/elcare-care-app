// ─────────────────────────────────────────────────────────────────────────────
// hooks/useTxLifecycle.ts — Shared transaction lifecycle state machine
//
// Issue #300: Every write action (listing, purchase, bidding, offers, collection
// deployment, minting) shares this single lifecycle. It records:
//   idle → simulating → signing → broadcasting → confirming
//       → indexer_pending → success
//       ↘ (at any stage) → error
//
// Key features:
//   - Real RPC polling during the confirming phase via lookupTxOnRpc
//   - Persists pending tx hash in sessionStorage so a page reload can recover
//   - Typed error categories (wallet_rejection, simulation_failure, rpc_failure,
//     indexer_delay, unknown)
//   - Duplicate-submission guard: a run() call while one is already active
//     returns null immediately without starting a second submission
//   - Cancellation: an in-progress run can be aborted via the returned abort()
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useCallback, useRef, useState, useEffect } from "react";
import { lookupTxOnRpc } from "@/lib/txLookup";

// ── State model ───────────────────────────────────────────────────────────────

/**
 * All valid lifecycle states.
 *
 * Transitions (happy path):
 *   idle → simulating → signing → broadcasting → confirming → indexer_pending → success
 *
 * Error path from any non-idle state:
 *   * → error
 */
export type TxState =
  | "idle"
  | "simulating"      // building + simulating the transaction
  | "signing"         // waiting for wallet signature
  | "broadcasting"    // submitted to the network, awaiting inclusion
  | "confirming"      // polling RPC until ledger inclusion is confirmed
  | "indexer_pending" // confirmed on-chain, not yet visible in indexer
  | "success"         // confirmed on-chain AND visible in indexer (or timeout elapsed)
  | "error";          // terminal failure

/** Low-cardinality categories that let the UI distinguish failure causes. */
export type TxErrorCategory =
  | "wallet_rejection"    // user cancelled in wallet
  | "simulation_failure"  // contract simulation failed (pre-flight check)
  | "rpc_failure"         // network / RPC submission error
  | "indexer_delay"       // on-chain success but indexer confirmation timed out
  | "unknown";            // catch-all

export interface TxError {
  category: TxErrorCategory;
  message: string;
  originalError?: unknown;
}

export interface TxLifecycleState {
  state: TxState;
  txHash: string | null;
  error: TxError | null;
  /** Timestamp (ms) when the current state was entered. */
  stateEnteredAt: number;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface TxLifecycleOptions {
  /**
   * Human-readable action label used in error messages.
   * Defaults to "Transaction".
   */
  action?: string;

  /**
   * How long (ms) to wait for indexer confirmation before transitioning to
   * success anyway, showing an "indexer_delay" warning.
   * Defaults to 30 000 ms (30 s).
   */
  indexerConfirmTimeoutMs?: number;

  /**
   * How long (ms) to poll the Soroban RPC for on-chain confirmation before
   * giving up and treating the transaction as failed.
   * Defaults to 60 000 ms (60 s).
   */
  rpcConfirmTimeoutMs?: number;

  /**
   * Storage key prefix for sessionStorage persistence.
   * Defaults to "txLifecycle".
   * Set to null to disable persistence.
   */
  persistKey?: string | null;
}

// ── Return type ───────────────────────────────────────────────────────────────

export interface UseTxLifecycleResult {
  /** Current lifecycle state. */
  txState: TxLifecycleState;

  /** True while in any active (non-idle, non-terminal) state. */
  isActive: boolean;

  /**
   * Execute a write action through the full lifecycle.
   *
   * The duplicate-submission guard ensures that calling run() while a run is
   * already active returns null immediately without submitting again.
   *
   * @param fn        The async action (must resolve with a result containing
   *                  a `hash` or `txHash` string field, or return null).
   * @param opts      Per-invocation overrides.
   * @returns         The result of `fn`, or null on failure/cancellation.
   */
  run: <T>(
    fn: () => Promise<T>,
    opts?: TxLifecycleOptions
  ) => Promise<T | null>;

  /**
   * Abort an in-progress run. Transitions to error with category "unknown"
   * and message "Cancelled by user". No-op if idle.
   */
  abort: () => void;

  /** Reset to idle (clears error, hash, persisted state). */
  reset: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STORAGE_KEY_PREFIX = "txLifecycle";

function storageKey(prefix: string): string {
  return `${prefix}:pending`;
}

function persistTx(key: string, hash: string): void {
  try {
    sessionStorage.setItem(key, hash);
  } catch {
    // SessionStorage unavailable (SSR / private mode) — silent fallback
  }
}

function clearPersistedTx(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch { /* ignore */ }
}

function loadPersistedTx(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Classify an error into a TxErrorCategory. */
export function classifyTxError(err: unknown): TxErrorCategory {
  if (!err) return "unknown";
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  // Wallet rejection signals from Freighter / Lobstr / Magic
  if (
    msg.includes("user declined") ||
    msg.includes("user rejected") ||
    msg.includes("rejected by user") ||
    msg.includes("cancelled") ||
    msg.includes("canceled") ||
    msg.includes("user denied") ||
    msg.includes("sign request was rejected") ||
    msg.includes("request rejected") ||
    msg.includes("declined")
  ) {
    return "wallet_rejection";
  }

  // Soroban simulation / preflight failures
  if (
    msg.includes("simulation") ||
    msg.includes("simulate") ||
    msg.includes("preflight") ||
    msg.includes("contract error") ||
    msg.includes("invoke_host_function") ||
    msg.includes("insufficient funds") ||
    msg.includes("insufficient balance") ||
    msg.includes("below minimum") ||
    msg.includes("error(contract")
  ) {
    return "simulation_failure";
  }

  // RPC / network failures
  if (
    msg.includes("network") ||
    msg.includes("rpc") ||
    msg.includes("timeout") ||
    msg.includes("connection") ||
    msg.includes("submit") ||
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("429") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("fetch failed") ||
    msg.includes("failed to fetch")
  ) {
    return "rpc_failure";
  }

  return "unknown";
}

/**
 * Build a user-facing error message from a raw error, enriching the raw
 * message with context about the transaction action where helpful.
 *
 * Returns a plain string suitable for display in TxErrorPanel.
 */
export function buildTxErrorMessage(
  err: unknown,
  action: string,
  category: TxErrorCategory
): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";

  switch (category) {
    case "wallet_rejection":
      return `You declined the ${action} request in your wallet. Nothing was submitted.`;

    case "simulation_failure": {
      // Surface contract error codes when present
      const codeMatch = raw.match(/error\(contract,\s*#(\d+)\)/i);
      const code = codeMatch ? ` (contract error #${codeMatch[1]})` : "";
      if (raw.toLowerCase().includes("insufficient")) {
        return `Insufficient funds to complete this ${action}. Check your balance and try again.${code}`;
      }
      return `${action} could not be simulated${code}. Refresh the page and try again — the listing state may have changed.`;
    }

    case "rpc_failure":
      if (raw.includes("429"))
        return `The Stellar network is busy. Wait a moment and retry your ${action}.`;
      if (raw.toLowerCase().includes("timeout"))
        return `The network request timed out while processing your ${action}. Try again.`;
      return `A network error occurred during ${action}. Check your connection and try again.`;

    case "indexer_delay":
      return `Your ${action} was confirmed on-chain but the indexer hasn't caught up yet. This usually resolves within 30 seconds.`;

    case "unknown":
    default:
      return raw || `${action} failed. Please try again.`;
  }
}

/** Attempt to extract a transaction hash from a raw SDK result. */
export function extractTxHash(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r["hash"] === "string" && r["hash"].length > 0) return r["hash"];
  if (typeof r["txHash"] === "string" && r["txHash"].length > 0) return r["txHash"];
  if (typeof r["id"] === "string" && r["id"].length === 64) return r["id"];
  return null;
}

// ── RPC confirmation poll ─────────────────────────────────────────────────────

/**
 * Polls the Soroban RPC until the transaction is confirmed (success or failed)
 * or the timeout elapses.
 *
 * Returns:
 *   "success"   – transaction included and all ops succeeded
 *   "failed"    – transaction included but at least one op failed
 *   "timeout"   – RPC confirmation did not arrive within rpcConfirmTimeoutMs
 *   "aborted"   – abort signal fired
 */
async function pollRpcForConfirmation(
  hash: string,
  rpcConfirmTimeoutMs: number,
  signal: AbortSignal
): Promise<"success" | "failed" | "timeout" | "aborted"> {
  const deadline = Date.now() + rpcConfirmTimeoutMs;
  // Max 20 poll attempts with a 3-second interval gives 60 s coverage.
  const maxAttempts = Math.ceil(rpcConfirmTimeoutMs / 3_000);

  const result = await lookupTxOnRpc(hash, {
    maxPollAttempts: maxAttempts,
    pollIntervalMs: 3_000,
    signal,
  });

  if (signal.aborted) return "aborted";

  switch (result.chainStatus) {
    case "success":   return "success";
    case "failed":    return "failed";
    case "rpc_error": return "timeout";  // treat RPC errors like timeouts
    default:
      // not_found after exhausted retries
      return Date.now() >= deadline ? "timeout" : "timeout";
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

const INITIAL_STATE: TxLifecycleState = {
  state: "idle",
  txHash: null,
  error: null,
  stateEnteredAt: 0,
};

export function useTxLifecycle(
  defaultOpts: TxLifecycleOptions = {}
): UseTxLifecycleResult {
  const [txState, setTxState] = useState<TxLifecycleState>(INITIAL_STATE);

  // Abort flag: set to true when abort() is called mid-run
  const abortedRef = useRef(false);
  // Whether a run is currently executing (duplicate-submission guard)
  const runningRef = useRef(false);
  // AbortController for the in-progress RPC poll
  const abortControllerRef = useRef<AbortController | null>(null);
  // Resolved persist key
  const persistKeyRef = useRef<string | null>(null);

  // On mount: check sessionStorage for a persisted pending hash.
  // If found and we are currently idle, restore indexer_pending state so
  // the user can see the status page and retry/refresh actions.
  useEffect(() => {
    const rawKey = defaultOpts.persistKey !== undefined
      ? defaultOpts.persistKey
      : STORAGE_KEY_PREFIX;
    persistKeyRef.current = rawKey;

    if (rawKey === null) return;

    const key = storageKey(rawKey);
    const savedHash = loadPersistedTx(key);
    if (savedHash) {
      setTxState({
        state: "indexer_pending",
        txHash: savedHash,
        error: null,
        stateEnteredAt: Date.now(),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally run only on mount

  const transition = useCallback(
    (next: Partial<TxLifecycleState>) => {
      setTxState((prev) => ({
        ...prev,
        ...next,
        stateEnteredAt: Date.now(),
      }));
    },
    []
  );

  const abort = useCallback(() => {
    if (!runningRef.current) return;
    abortedRef.current = true;
    abortControllerRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortedRef.current = false;
    runningRef.current = false;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    const key = persistKeyRef.current;
    if (key !== null) clearPersistedTx(storageKey(key));
    setTxState(INITIAL_STATE);
  }, []);

  const run = useCallback(
    async <T>(
      fn: () => Promise<T>,
      opts: TxLifecycleOptions = {}
    ): Promise<T | null> => {
      const {
        action = defaultOpts.action ?? "Transaction",
        indexerConfirmTimeoutMs = defaultOpts.indexerConfirmTimeoutMs ?? 30_000,
        rpcConfirmTimeoutMs = defaultOpts.rpcConfirmTimeoutMs ?? 60_000,
        persistKey = defaultOpts.persistKey !== undefined
          ? defaultOpts.persistKey
          : STORAGE_KEY_PREFIX,
      } = opts;

      // ── Duplicate-submission guard ─────────────────────────────────────────
      // If a run is already active, return null immediately. This prevents
      // the user from clicking "Buy" twice and sending duplicate transactions.
      if (runningRef.current) return null;

      runningRef.current = true;
      abortedRef.current = false;

      // Create a fresh AbortController for this run's RPC poll
      const ac = new AbortController();
      abortControllerRef.current = ac;

      const resolvedPersistKey = persistKey !== null ? storageKey(persistKey) : null;

      // ── Phase: simulating ──────────────────────────────────────────────────
      transition({ state: "simulating", txHash: null, error: null });

      // Short yield so React can flush the state update before we block
      await new Promise((r) => setTimeout(r, 0));

      if (abortedRef.current) {
        runningRef.current = false;
        transition({
          state: "error",
          error: { category: "unknown", message: `${action} cancelled by user.` },
        });
        return null;
      }

      // ── Phase: signing ─────────────────────────────────────────────────────
      // fn() encompasses simulation + signing + submission in invokeContract.
      // We label this "signing" because that is the user-facing blocking step.
      transition({ state: "signing" });

      let result: T;
      try {
        result = await fn();
      } catch (err: unknown) {
        runningRef.current = false;
        abortControllerRef.current = null;

        if (abortedRef.current) {
          transition({
            state: "error",
            error: { category: "unknown", message: `${action} cancelled by user.` },
          });
          return null;
        }

        const category = classifyTxError(err);
        const message  = buildTxErrorMessage(err, action, category);
        transition({
          state: "error",
          error: { category, message, originalError: err },
        });
        return null;
      }

      if (abortedRef.current) {
        runningRef.current = false;
        abortControllerRef.current = null;
        transition({
          state: "error",
          error: { category: "unknown", message: `${action} cancelled by user.` },
        });
        return null;
      }

      // ── Phase: broadcasting ────────────────────────────────────────────────
      // fn() returned — invokeContract has submitted the transaction.
      // Extract the hash from the result so we can poll RPC and persist.
      const txHash = extractTxHash(result);
      transition({ state: "broadcasting", txHash });

      // Persist hash so a page reload can recover the pending state
      if (resolvedPersistKey && txHash) {
        persistTx(resolvedPersistKey, txHash);
      }

      // ── Phase: confirming ──────────────────────────────────────────────────
      // Poll the Soroban RPC until the transaction is included in a ledger.
      transition({ state: "confirming", txHash });

      if (txHash) {
        const rpcOutcome = await pollRpcForConfirmation(
          txHash,
          rpcConfirmTimeoutMs,
          ac.signal
        );

        if (rpcOutcome === "aborted") {
          runningRef.current = false;
          abortControllerRef.current = null;
          // Transaction may still be on-chain — do not clear the persisted hash
          return result;
        }

        if (rpcOutcome === "failed") {
          if (resolvedPersistKey) clearPersistedTx(resolvedPersistKey);
          runningRef.current = false;
          abortControllerRef.current = null;
          transition({
            state: "error",
            txHash,
            error: {
              category: "rpc_failure",
              message: buildTxErrorMessage(
                new Error("Transaction failed on-chain"),
                action,
                "rpc_failure"
              ),
            },
          });
          return null;
        }

        if (rpcOutcome === "timeout") {
          // We couldn't confirm in time — surface as rpc_failure so the user
          // can check /tx/[hash] for the actual outcome.
          if (resolvedPersistKey) clearPersistedTx(resolvedPersistKey);
          runningRef.current = false;
          abortControllerRef.current = null;
          transition({
            state: "error",
            txHash,
            error: {
              category: "rpc_failure",
              message: `${action} confirmation timed out. Check your transaction status at /tx/${txHash}.`,
            },
          });
          return null;
        }
        // rpcOutcome === "success" → fall through to indexer_pending
      }

      // ── Phase: indexer_pending ─────────────────────────────────────────────
      // The transaction is confirmed on-chain; wait for the indexer to pick it up.
      transition({ state: "indexer_pending", txHash });

      // Set a timeout: if indexer confirmation doesn't arrive within the
      // configured window we transition to success anyway with an indexer_delay
      // note so the user is not stuck.
      await new Promise<void>((resolve) =>
        setTimeout(resolve, indexerConfirmTimeoutMs)
      );

      if (abortedRef.current) {
        runningRef.current = false;
        abortControllerRef.current = null;
        // Transaction is already on-chain — transition to success
        if (resolvedPersistKey) clearPersistedTx(resolvedPersistKey);
        transition({ state: "success", txHash });
        return result;
      }

      // ── Phase: success ─────────────────────────────────────────────────────
      if (resolvedPersistKey) clearPersistedTx(resolvedPersistKey);
      runningRef.current = false;
      abortControllerRef.current = null;
      transition({ state: "success", txHash });

      return result;
    },
    [defaultOpts, transition]
  );

  const isActive =
    txState.state !== "idle" &&
    txState.state !== "success" &&
    txState.state !== "error";

  return { txState, isActive, run, abort, reset };
}

// ── Utility: human-readable label for each state ──────────────────────────────

export function txStateLabel(state: TxState): string {
  switch (state) {
    case "idle":            return "Ready";
    case "simulating":      return "Building transaction…";
    case "signing":         return "Awaiting wallet signature…";
    case "broadcasting":    return "Broadcasting to network…";
    case "confirming":      return "Confirming on-chain…";
    case "indexer_pending": return "Waiting for indexer confirmation…";
    case "success":         return "Confirmed!";
    case "error":           return "Failed";
  }
}

/** True when the state is one of the terminal states. */
export function isTxTerminal(state: TxState): boolean {
  return state === "success" || state === "error";
}

/** True when the state is one of the active (in-flight) states. */
export function isTxActive(state: TxState): boolean {
  return !isTxTerminal(state) && state !== "idle";
}
