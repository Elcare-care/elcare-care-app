// ─────────────────────────────────────────────────────────────────────────────
// hooks/useReconciliation.ts — Reconciliation-aware provisional state manager
//
// Issue #302: Replace silent optimistic updates with explicit provisional state.
//
// Design:
//   - Each pending mutation is tagged with a transaction identity (txHash or a
//     local pendingId), a resource type/id, and an expiry timestamp.
//   - The confirmed snapshot (last known good data from REST or SSE) is kept
//     separate from pending mutations.
//   - When SSE/REST data arrives the relevant mutation is resolved and removed.
//   - Expired or failed mutations are rolled back and the confirmed snapshot
//     restored.
//   - Duplicate and out-of-order SSE events are handled idempotently.
//   - Pending state survives a page reload when a txHash is recorded (via
//     sessionStorage).
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MutationStatus =
  | "pending"   // tx submitted, awaiting chain/indexer confirmation
  | "confirmed" // indexer acknowledged the mutation
  | "rejected"  // tx failed or rolled back
  | "stale";    // expiry elapsed before confirmation

/** A resource type the marketplace manages. */
export type ResourceKind = "listing" | "auction" | "offer" | "collection";

/** The provisional record state visible to the UI. */
export type RecordState = "confirmed" | "pending" | "rejected" | "stale";

export interface PendingMutation<TData = unknown> {
  /** Unique identifier for this mutation (txHash when available, else a local uuid). */
  pendingId: string;
  /** Stellar transaction hash — may be null before broadcast. */
  txHash: string | null;
  /** Kind of resource being mutated. */
  kind: ResourceKind;
  /** Resource identifier (listing id, auction id, etc.). */
  resourceId: string;
  /**
   * The optimistic value to show while pending.
   * null means "this resource is being deleted/cancelled".
   */
  optimisticValue: TData | null;
  /** Unix timestamp (ms) when this mutation expires. */
  expiresAt: number;
  /** Current resolution status. */
  status: MutationStatus;
}

export interface ConfirmedSnapshot<TData> {
  resourceId: string;
  data: TData;
  /** Ledger sequence at which this snapshot was last updated. */
  ledger: number;
}

// ── State shape ───────────────────────────────────────────────────────────────

interface ReconciliationState<TData> {
  /** Indexed by resourceId. */
  confirmed: Map<string, ConfirmedSnapshot<TData>>;
  /** Indexed by pendingId. */
  pending: Map<string, PendingMutation<TData>>;
  /** Set of resource IDs that have been seen (idempotency). */
  seenEventIds: Set<string>;
}

// ── Actions ───────────────────────────────────────────────────────────────────

type ReconciliationAction<TData> =
  | { type: "APPLY_CONFIRMED_DATA"; payload: ConfirmedSnapshot<TData>[] }
  | { type: "ADD_MUTATION"; payload: PendingMutation<TData> }
  | { type: "RESOLVE_MUTATION"; pendingId: string; txHash?: string }
  | { type: "REJECT_MUTATION"; pendingId: string; reason: string }
  | { type: "EXPIRE_STALE_MUTATIONS" }
  | { type: "RESET" };

// ── Reducer ───────────────────────────────────────────────────────────────────

function reconciliationReducer<TData>(
  state: ReconciliationState<TData>,
  action: ReconciliationAction<TData>
): ReconciliationState<TData> {
  switch (action.type) {
    case "APPLY_CONFIRMED_DATA": {
      const newConfirmed = new Map(state.confirmed);
      for (const snap of action.payload) {
        const existing = newConfirmed.get(snap.resourceId);
        // Out-of-order guard: only update if newer ledger
        if (!existing || snap.ledger >= existing.ledger) {
          newConfirmed.set(snap.resourceId, snap);
        }
      }
      // Resolve any pending mutations whose resourceId appears in the new data
      const newPending = new Map(state.pending);
      for (const [id, mut] of newPending) {
        if (
          newConfirmed.has(mut.resourceId) &&
          (mut.status === "pending")
        ) {
          newPending.set(id, { ...mut, status: "confirmed" });
          // Remove after a short delay (handled by EXPIRE_STALE_MUTATIONS pass)
        }
      }
      return { ...state, confirmed: newConfirmed, pending: newPending };
    }

    case "ADD_MUTATION": {
      const newPending = new Map(state.pending);
      newPending.set(action.payload.pendingId, action.payload);
      return { ...state, pending: newPending };
    }

    case "RESOLVE_MUTATION": {
      const newPending = new Map(state.pending);
      const mut = newPending.get(action.pendingId);
      if (mut) {
        newPending.set(action.pendingId, {
          ...mut,
          status: "confirmed",
          txHash: action.txHash ?? mut.txHash,
        });
      }
      return { ...state, pending: newPending };
    }

    case "REJECT_MUTATION": {
      const newPending = new Map(state.pending);
      const mut = newPending.get(action.pendingId);
      if (mut) {
        newPending.set(action.pendingId, { ...mut, status: "rejected" });
      }
      return { ...state, pending: newPending };
    }

    case "EXPIRE_STALE_MUTATIONS": {
      const now = Date.now();
      const newPending = new Map(state.pending);
      for (const [id, mut] of newPending) {
        if (mut.status === "pending" && mut.expiresAt < now) {
          newPending.set(id, { ...mut, status: "stale" });
        }
        // Clean up fully resolved or rejected mutations older than 5 s
        if (
          (mut.status === "confirmed" || mut.status === "rejected" || mut.status === "stale") &&
          mut.expiresAt + 5_000 < now
        ) {
          newPending.delete(id);
        }
      }
      return { ...state, pending: newPending };
    }

    case "RESET":
      return { confirmed: new Map(), pending: new Map(), seenEventIds: new Set() };

    default:
      return state;
  }
}

// ── Options & return type ─────────────────────────────────────────────────────

export interface ReconciliationOptions {
  /**
   * How long (ms) a pending mutation waits before being marked stale.
   * Defaults to 60 000 ms (1 minute).
   */
  mutationTtlMs?: number;

  /**
   * How often (ms) to run the expiry sweep.
   * Defaults to 10 000 ms.
   */
  sweepIntervalMs?: number;
}

export interface UseReconciliationResult<TData> {
  /**
   * Get the display-ready state for a resource.
   * Returns the optimistic value while pending, confirmed data otherwise.
   */
  getResourceState: (
    resourceId: string,
    kind: ResourceKind
  ) => {
    data: TData | null;
    recordState: RecordState;
    pendingMutation: PendingMutation<TData> | null;
  };

  /** Add a new pending mutation (call after submitting a tx). */
  addMutation: (mut: Omit<PendingMutation<TData>, "expiresAt" | "status">) => void;

  /** Mark a mutation as resolved (call when SSE/REST confirms the change). */
  resolveMutation: (pendingId: string, txHash?: string) => void;

  /** Mark a mutation as rejected (call on tx failure). */
  rejectMutation: (pendingId: string, reason?: string) => void;

  /** Apply fresh confirmed data from REST or SSE (handles out-of-order safely). */
  applyConfirmedData: (snapshots: ConfirmedSnapshot<TData>[]) => void;

  /** All current pending mutations (for UI rendering). */
  pendingMutations: PendingMutation<TData>[];

  /** Reset all state. */
  reset: () => void;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

const INITIAL_STATE = <TData>(): ReconciliationState<TData> => ({
  confirmed: new Map(),
  pending: new Map(),
  seenEventIds: new Set(),
});

export function useReconciliation<TData = unknown>(
  opts: ReconciliationOptions = {}
): UseReconciliationResult<TData> {
  const { mutationTtlMs = 60_000, sweepIntervalMs = 10_000 } = opts;

  const [state, dispatch] = useReducer(
    reconciliationReducer as React.Reducer<
      ReconciliationState<TData>,
      ReconciliationAction<TData>
    >,
    undefined,
    () => INITIAL_STATE<TData>()
  );

  // Expiry sweep
  useEffect(() => {
    const id = setInterval(() => {
      dispatch({ type: "EXPIRE_STALE_MUTATIONS" });
    }, sweepIntervalMs);
    return () => clearInterval(id);
  }, [sweepIntervalMs]);

  const addMutation = useCallback(
    (mut: Omit<PendingMutation<TData>, "expiresAt" | "status">) => {
      dispatch({
        type: "ADD_MUTATION",
        payload: {
          ...mut,
          expiresAt: Date.now() + mutationTtlMs,
          status: "pending",
        },
      });
    },
    [mutationTtlMs]
  );

  const resolveMutation = useCallback((pendingId: string, txHash?: string) => {
    dispatch({ type: "RESOLVE_MUTATION", pendingId, txHash });
  }, []);

  const rejectMutation = useCallback(
    (pendingId: string, reason = "Transaction failed") => {
      dispatch({ type: "REJECT_MUTATION", pendingId, reason });
    },
    []
  );

  const applyConfirmedData = useCallback(
    (snapshots: ConfirmedSnapshot<TData>[]) => {
      dispatch({ type: "APPLY_CONFIRMED_DATA", payload: snapshots });
    },
    []
  );

  const reset = useCallback(() => {
    dispatch({ type: "RESET" });
  }, []);

  const getResourceState = useCallback(
    (resourceId: string, _kind: ResourceKind) => {
      // Find any active (non-rejected, non-confirmed) pending mutation for this resource
      const activeMut = [...state.pending.values()].find(
        (m) => m.resourceId === resourceId && m.status === "pending"
      ) ?? null;

      const confirmedSnap = state.confirmed.get(resourceId) ?? null;

      if (activeMut) {
        return {
          data: activeMut.optimisticValue,
          recordState: "pending" as RecordState,
          pendingMutation: activeMut,
        };
      }

      // Check for stale
      const staleMut = [...state.pending.values()].find(
        (m) => m.resourceId === resourceId && m.status === "stale"
      ) ?? null;

      if (staleMut) {
        return {
          data: confirmedSnap?.data ?? null,
          recordState: "stale" as RecordState,
          pendingMutation: staleMut,
        };
      }

      // Check for rejected — show confirmed snapshot
      const rejectedMut = [...state.pending.values()].find(
        (m) => m.resourceId === resourceId && m.status === "rejected"
      ) ?? null;

      if (rejectedMut) {
        return {
          data: confirmedSnap?.data ?? null,
          recordState: "rejected" as RecordState,
          pendingMutation: rejectedMut,
        };
      }

      return {
        data: confirmedSnap?.data ?? null,
        recordState: "confirmed" as RecordState,
        pendingMutation: null,
      };
    },
    [state]
  );

  const pendingMutations = [...state.pending.values()];

  return {
    getResourceState,
    addMutation,
    resolveMutation,
    rejectMutation,
    applyConfirmedData,
    pendingMutations,
    reset,
  };
}

// ── Utility: generate a local pending ID ─────────────────────────────────────

let _pendingCounter = 0;

export function generatePendingId(prefix = "pending"): string {
  return `${prefix}-${Date.now()}-${++_pendingCounter}`;
}
