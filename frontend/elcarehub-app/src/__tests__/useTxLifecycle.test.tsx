// ─────────────────────────────────────────────────────────────────────────────
// __tests__/useTxLifecycle.test.tsx
//
// Issue #300: Tests for the shared transaction lifecycle state machine.
// Covers all transitions, error categories, persistence, abort, and retry guard.
// ─────────────────────────────────────────────────────────────────────────────

import React from "react";
import { renderHook, act } from "@testing-library/react";
import {
  useTxLifecycle,
  classifyTxError,
  buildTxErrorMessage,
  extractTxHash,
  txStateLabel,
  isTxTerminal,
  isTxActive,
} from "../hooks/useTxLifecycle";

// ── Mock sessionStorage ───────────────────────────────────────────────────────

const sessionStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

Object.defineProperty(window, "sessionStorage", { value: sessionStorageMock });

beforeEach(() => {
  sessionStorageMock.clear();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function successFn(hash = "abc123") {
  return jest.fn().mockResolvedValue({ hash });
}

function failFn(message = "RPC timeout") {
  return jest.fn().mockRejectedValue(new Error(message));
}

// ── classifyTxError ───────────────────────────────────────────────────────────

describe("classifyTxError", () => {
  it("classifies user rejection errors", () => {
    expect(classifyTxError(new Error("user declined"))).toBe("wallet_rejection");
    expect(classifyTxError(new Error("User rejected the request"))).toBe("wallet_rejection");
    expect(classifyTxError(new Error("cancelled"))).toBe("wallet_rejection");
  });

  it("classifies simulation failures", () => {
    expect(classifyTxError(new Error("simulation failed"))).toBe("simulation_failure");
    expect(classifyTxError(new Error("invoke_host_function error"))).toBe("simulation_failure");
    expect(classifyTxError(new Error("preflight check failed"))).toBe("simulation_failure");
  });

  it("classifies RPC failures", () => {
    expect(classifyTxError(new Error("network error"))).toBe("rpc_failure");
    expect(classifyTxError(new Error("rpc unavailable"))).toBe("rpc_failure");
    expect(classifyTxError(new Error("timeout waiting for submit"))).toBe("rpc_failure");
    expect(classifyTxError(new Error("503 service unavailable"))).toBe("rpc_failure");
  });

  it("falls back to unknown", () => {
    expect(classifyTxError(new Error("some random error"))).toBe("unknown");
    expect(classifyTxError(null)).toBe("unknown");
    expect(classifyTxError(undefined)).toBe("unknown");
  });

  // Issue #536: the transaction-substitution guard in lib/contract.ts throws
  // a `TxIntentMismatchError` (named error, not a message-content match) —
  // it must always be classified as "intent_mismatch" and never fall
  // through to "unknown" or get mis-bucketed as a simulation/rpc failure.
  it("classifies TxIntentMismatchError as intent_mismatch regardless of message wording", () => {
    class TxIntentMismatchError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "TxIntentMismatchError";
      }
    }
    expect(
      classifyTxError(new TxIntentMismatchError("Transaction verification failed: mismatched fields: contractId."))
    ).toBe("intent_mismatch");

    const message = buildTxErrorMessage(
      new TxIntentMismatchError("mismatch"),
      "Purchase",
      "intent_mismatch"
    );
    expect(message).toMatch(/stopped/i);
    expect(message).toMatch(/wallet/i);
  });
});

// ── extractTxHash ─────────────────────────────────────────────────────────────

describe("extractTxHash", () => {
  it("extracts hash from .hash field", () => {
    expect(extractTxHash({ hash: "abc" })).toBe("abc");
  });

  it("extracts hash from .txHash field", () => {
    expect(extractTxHash({ txHash: "def" })).toBe("def");
  });

  it("extracts hash from .id field (64-char hex)", () => {
    const id = "a".repeat(64);
    expect(extractTxHash({ id })).toBe(id);
  });

  it("returns null for missing or short id", () => {
    expect(extractTxHash({})).toBeNull();
    expect(extractTxHash({ id: "short" })).toBeNull();
    expect(extractTxHash(null)).toBeNull();
    expect(extractTxHash(42)).toBeNull();
  });
});

// ── txStateLabel ──────────────────────────────────────────────────────────────

describe("txStateLabel", () => {
  it("returns a non-empty string for every state", () => {
    const states = [
      "idle", "simulating", "signing", "broadcasting",
      "confirming", "indexer_pending", "success", "error",
    ] as const;
    for (const s of states) {
      expect(txStateLabel(s).length).toBeGreaterThan(0);
    }
  });
});

// ── isTxTerminal / isTxActive ─────────────────────────────────────────────────

describe("isTxTerminal / isTxActive", () => {
  it("reports success and error as terminal", () => {
    expect(isTxTerminal("success")).toBe(true);
    expect(isTxTerminal("error")).toBe(true);
    expect(isTxTerminal("idle")).toBe(false);
    expect(isTxTerminal("signing")).toBe(false);
  });

  it("reports active states correctly", () => {
    expect(isTxActive("signing")).toBe(true);
    expect(isTxActive("broadcasting")).toBe(true);
    expect(isTxActive("indexer_pending")).toBe(true);
    expect(isTxActive("idle")).toBe(false);
    expect(isTxActive("success")).toBe(false);
    expect(isTxActive("error")).toBe(false);
  });
});

// ── useTxLifecycle — happy path ───────────────────────────────────────────────

describe("useTxLifecycle — happy path", () => {
  it("starts idle", () => {
    const { result } = renderHook(() => useTxLifecycle({ persistKey: null }));
    expect(result.current.txState.state).toBe("idle");
    expect(result.current.isActive).toBe(false);
  });

  it("transitions through states and reaches success", async () => {
    const { result } = renderHook(() => useTxLifecycle({ persistKey: null, indexerConfirmTimeoutMs: 10 }));

    let runPromise: Promise<unknown>;
    act(() => {
      runPromise = result.current.run(successFn(), { action: "Test" });
    });

    // After run starts, state should be active
    expect(result.current.isActive).toBe(true);

    // Let the indexer confirm timeout elapse
    await act(async () => {
      jest.advanceTimersByTime(50);
      await runPromise;
    });

    expect(result.current.txState.state).toBe("success");
    expect(result.current.txState.txHash).toBe("abc123");
    expect(result.current.isActive).toBe(false);
  });

  it("returns the result from fn on success", async () => {
    const { result } = renderHook(() => useTxLifecycle({ persistKey: null, indexerConfirmTimeoutMs: 0 }));

    let returnValue: unknown;
    await act(async () => {
      const p = result.current.run(async () => ({ hash: "txabc", value: 42 }));
      jest.advanceTimersByTime(100);
      returnValue = await p;
    });

    expect((returnValue as any).value).toBe(42);
  });
});

// ── useTxLifecycle — failure paths ────────────────────────────────────────────

describe("useTxLifecycle — failure paths", () => {
  it("transitions to error on wallet rejection", async () => {
    const { result } = renderHook(() => useTxLifecycle({ persistKey: null }));

    await act(async () => {
      await result.current.run(failFn("user rejected"));
    });

    expect(result.current.txState.state).toBe("error");
    expect(result.current.txState.error?.category).toBe("wallet_rejection");
    expect(result.current.isActive).toBe(false);
  });

  it("transitions to error on simulation failure", async () => {
    const { result } = renderHook(() => useTxLifecycle({ persistKey: null }));

    await act(async () => {
      await result.current.run(failFn("simulation failed"));
    });

    expect(result.current.txState.state).toBe("error");
    expect(result.current.txState.error?.category).toBe("simulation_failure");
  });

  it("transitions to error on RPC failure", async () => {
    const { result } = renderHook(() => useTxLifecycle({ persistKey: null }));

    await act(async () => {
      await result.current.run(failFn("rpc timeout"));
    });

    expect(result.current.txState.state).toBe("error");
    expect(result.current.txState.error?.category).toBe("rpc_failure");
  });

  it("returns null on failure", async () => {
    const { result } = renderHook(() => useTxLifecycle({ persistKey: null }));

    let returnValue: unknown = "sentinel";
    await act(async () => {
      returnValue = await result.current.run(failFn("network error"));
    });

    expect(returnValue).toBeNull();
  });
});

// ── useTxLifecycle — reset ────────────────────────────────────────────────────

describe("useTxLifecycle — reset", () => {
  it("resets to idle after error", async () => {
    const { result } = renderHook(() => useTxLifecycle({ persistKey: null }));

    await act(async () => {
      await result.current.run(failFn());
    });
    expect(result.current.txState.state).toBe("error");

    act(() => {
      result.current.reset();
    });
    expect(result.current.txState.state).toBe("idle");
    expect(result.current.txState.error).toBeNull();
    expect(result.current.txState.txHash).toBeNull();
  });

  it("resets to idle after success", async () => {
    const { result } = renderHook(() => useTxLifecycle({ persistKey: null, indexerConfirmTimeoutMs: 0 }));

    await act(async () => {
      const p = result.current.run(successFn());
      jest.advanceTimersByTime(100);
      await p;
    });
    expect(result.current.txState.state).toBe("success");

    act(() => {
      result.current.reset();
    });
    expect(result.current.txState.state).toBe("idle");
  });
});

// ── useTxLifecycle — retry guard ──────────────────────────────────────────────

describe("useTxLifecycle — retry guard", () => {
  it("does not start a new run while one is already active", async () => {
    const { result } = renderHook(() =>
      useTxLifecycle({ persistKey: null, indexerConfirmTimeoutMs: 5000 })
    );

    let firstRun: Promise<unknown>;
    let secondReturn: unknown;

    act(() => {
      firstRun = result.current.run(successFn());
    });

    // Immediately try a second run — should be blocked
    await act(async () => {
      secondReturn = await result.current.run(successFn("should-not-run"));
    });

    expect(secondReturn).toBeNull();

    // Let the first run finish
    await act(async () => {
      jest.advanceTimersByTime(6000);
      await firstRun;
    });
  });
});

// ── useTxLifecycle — persistence ─────────────────────────────────────────────

describe("useTxLifecycle — sessionStorage persistence", () => {
  it("persists txHash to sessionStorage during run", async () => {
    const { result } = renderHook(() =>
      useTxLifecycle({ persistKey: "test-action", indexerConfirmTimeoutMs: 5000 })
    );

    act(() => {
      result.current.run(successFn("persist-hash"));
    });

    // After broadcasting state the hash should be in sessionStorage
    // (give at least one tick for async work)
    await act(async () => {
      await Promise.resolve();
    });

    const stored = sessionStorageMock.getItem("test-action:pending");
    expect(stored).toBe("persist-hash");

    // Finish the run to clean up
    await act(async () => {
      jest.advanceTimersByTime(6000);
    });
  });

  it("clears sessionStorage on success", async () => {
    const { result } = renderHook(() =>
      useTxLifecycle({ persistKey: "test-clear", indexerConfirmTimeoutMs: 10 })
    );

    await act(async () => {
      const p = result.current.run(successFn("clear-hash"));
      jest.advanceTimersByTime(100);
      await p;
    });

    expect(sessionStorageMock.getItem("test-clear:pending")).toBeNull();
  });

  it("restores indexer_pending state from sessionStorage on mount", () => {
    sessionStorageMock.setItem("restore-key:pending", "restored-hash");

    const { result } = renderHook(() =>
      useTxLifecycle({ persistKey: "restore-key" })
    );

    expect(result.current.txState.state).toBe("indexer_pending");
    expect(result.current.txState.txHash).toBe("restored-hash");
  });
});
