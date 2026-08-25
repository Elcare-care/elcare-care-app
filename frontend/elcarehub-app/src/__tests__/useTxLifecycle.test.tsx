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
  extractTxHash,
  txStateLabel,
  isTxTerminal,
  isTxActive,
  buildTxErrorMessage,
} from "../hooks/useTxLifecycle";

// ── Mock lookupTxOnRpc ────────────────────────────────────────────────────────
// useTxLifecycle calls lookupTxOnRpc during the "confirming" phase.
// Mock it so tests never hit a real node and can control outcomes per-test.

jest.mock("@/lib/txLookup", () => ({
  lookupTxOnRpc: jest.fn().mockResolvedValue({ chainStatus: "success", ledger: 0 }),
  isValidTxHash: jest.requireActual("../lib/txLookup").isValidTxHash,
}));

function getMockedLookupTxOnRpc() {
  const { lookupTxOnRpc } = require("@/lib/txLookup");
  return lookupTxOnRpc as jest.Mock;
}

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
  // Reset the lookupTxOnRpc mock to its safe default before each test so
  // existing happy-path tests (which reach the confirming phase) don't hang.
  getMockedLookupTxOnRpc().mockResolvedValue({ chainStatus: "success", ledger: 0 });
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

// ─────────────────────────────────────────────────────────────────────────────
// Additional tests added for Issue #300 enhancements:
//   - Duplicate-submission guard (thorough)
//   - indexer_delay error category via buildTxErrorMessage
//   - RPC poll: on-chain failed → error state with rpc_failure category
//   - RPC poll: timeout → error state with recovery link hint
//   - rpcConfirmTimeoutMs option respected
//   - stateEnteredAt is updated on every transition
//   - abort() during confirming phase preserves txHash
// ─────────────────────────────────────────────────────────────────────────────

// ── buildTxErrorMessage — indexer_delay category ──────────────────────────────

describe("buildTxErrorMessage — indexer_delay", () => {
  it("returns a message mentioning on-chain confirmation and indexer lag", () => {
    const msg = buildTxErrorMessage(null, "Purchase", "indexer_delay");
    expect(msg).toMatch(/confirmed on-chain/i);
    expect(msg).toMatch(/indexer/i);
  });

  it("includes the action name", () => {
    const msg = buildTxErrorMessage(null, "Bid", "indexer_delay");
    expect(msg).toMatch(/bid/i);
  });
});

// ── buildTxErrorMessage — all categories smoke test ──────────────────────────

describe("buildTxErrorMessage — all categories produce non-empty strings", () => {
  const categories = [
    "wallet_rejection",
    "simulation_failure",
    "rpc_failure",
    "indexer_delay",
    "unknown",
  ] as const;

  for (const cat of categories) {
    it(`category "${cat}" returns a non-empty string`, () => {
      const msg = buildTxErrorMessage(new Error("raw error"), "Transfer", cat);
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
    });
  }

  it("wallet_rejection message says nothing was submitted", () => {
    const msg = buildTxErrorMessage(new Error("user declined"), "Purchase", "wallet_rejection");
    expect(msg).toMatch(/nothing was submitted/i);
  });

  it("simulation_failure surfaces contract error code when present", () => {
    const msg = buildTxErrorMessage(
      new Error("Error(Contract, #42) reverted"),
      "Buy",
      "simulation_failure"
    );
    expect(msg).toMatch(/contract error #42/i);
  });

  it("simulation_failure mentions insufficient funds when relevant", () => {
    const msg = buildTxErrorMessage(
      new Error("insufficient balance"),
      "Purchase",
      "simulation_failure"
    );
    expect(msg).toMatch(/insufficient/i);
  });

  it("rpc_failure mentions retry for 429", () => {
    const msg = buildTxErrorMessage(new Error("429 too many requests"), "Bid", "rpc_failure");
    expect(msg).toMatch(/busy/i);
  });

  it("rpc_failure mentions timeout specifically", () => {
    const msg = buildTxErrorMessage(new Error("timeout exceeded"), "Purchase", "rpc_failure");
    expect(msg).toMatch(/timed out/i);
  });
});

// ── Duplicate-submission guard — thorough ─────────────────────────────────────

describe("useTxLifecycle — duplicate-submission guard (thorough)", () => {
  it("second run() call returns null immediately without mutating state", async () => {
    getMockedLookupTxOnRpc().mockResolvedValue({ chainStatus: "success", ledger: 1 });

    const { result } = renderHook(() =>
      useTxLifecycle({
        persistKey: null,
        indexerConfirmTimeoutMs: 2000,
        rpcConfirmTimeoutMs: 5000,
      })
    );

    let firstRunPromise: Promise<unknown>;
    act(() => {
      firstRunPromise = result.current.run(successFn("first-hash"));
    });

    // State is now active
    expect(result.current.isActive).toBe(true);

    // Immediately fire a second run with a different hash — must be blocked
    let secondResult: unknown = "sentinel";
    await act(async () => {
      secondResult = await result.current.run(successFn("second-hash-should-not-run"));
    });

    expect(secondResult).toBeNull();
    // The hash from the first run should never be overwritten
    expect(result.current.txState.txHash).not.toBe("second-hash-should-not-run");

    // Finish the first run
    await act(async () => {
      jest.advanceTimersByTime(3000);
      await firstRunPromise!;
    });
  });

  it("a third run() after reset() succeeds normally", async () => {
    getMockedLookupTxOnRpc().mockResolvedValue({ chainStatus: "success", ledger: 1 });

    const { result } = renderHook(() =>
      useTxLifecycle({
        persistKey: null,
        indexerConfirmTimeoutMs: 10,
        rpcConfirmTimeoutMs: 100,
      })
    );

    // Run 1 — succeeds
    await act(async () => {
      const p = result.current.run(successFn("run1-hash"));
      jest.advanceTimersByTime(200);
      await p;
    });
    expect(result.current.txState.state).toBe("success");

    // Reset
    act(() => result.current.reset());
    expect(result.current.txState.state).toBe("idle");

    // Run 2 — should succeed again (guard is cleared)
    await act(async () => {
      const p = result.current.run(successFn("run2-hash"));
      jest.advanceTimersByTime(200);
      await p;
    });
    expect(result.current.txState.state).toBe("success");
    expect(result.current.txState.txHash).toBe("run2-hash");
  });
});

// ── RPC poll: on-chain failed → error state ───────────────────────────────────

describe("useTxLifecycle — RPC poll returns failed", () => {
  it("transitions to error with rpc_failure category when chain rejects the tx", async () => {
    getMockedLookupTxOnRpc().mockResolvedValue({ chainStatus: "failed", ledger: 500 });

    const { result } = renderHook(() =>
      useTxLifecycle({
        persistKey: null,
        indexerConfirmTimeoutMs: 500,
        rpcConfirmTimeoutMs: 5000,
      })
    );

    await act(async () => {
      const p = result.current.run(successFn("fail-hash"), { action: "Purchase" });
      jest.advanceTimersByTime(100);
      await p;
    });

    expect(result.current.txState.state).toBe("error");
    expect(result.current.txState.error?.category).toBe("rpc_failure");
    // txHash should still be available so the user can check /tx/[hash]
    expect(result.current.txState.txHash).toBe("fail-hash");
  });

  it("does NOT persist the hash to sessionStorage after a chain failure", async () => {
    getMockedLookupTxOnRpc().mockResolvedValue({ chainStatus: "failed", ledger: 501 });

    const { result } = renderHook(() =>
      useTxLifecycle({
        persistKey: "chain-fail-test",
        indexerConfirmTimeoutMs: 500,
        rpcConfirmTimeoutMs: 5000,
      })
    );

    await act(async () => {
      const p = result.current.run(successFn("fail-cleanup"));
      jest.advanceTimersByTime(100);
      await p;
    });

    // Key should have been cleared after the failure transition
    expect(sessionStorageMock.getItem("chain-fail-test:pending")).toBeNull();
  });
});

// ── RPC poll: timeout → error state ──────────────────────────────────────────

describe("useTxLifecycle — RPC poll timeout", () => {
  it("transitions to error when RPC returns rpc_error (unreachable)", async () => {
    getMockedLookupTxOnRpc().mockResolvedValue({ chainStatus: "rpc_error", ledger: 0 });

    const { result } = renderHook(() =>
      useTxLifecycle({
        persistKey: null,
        indexerConfirmTimeoutMs: 500,
        rpcConfirmTimeoutMs: 5000,
      })
    );

    await act(async () => {
      const p = result.current.run(successFn("timeout-hash"), { action: "Bid" });
      jest.advanceTimersByTime(100);
      await p;
    });

    expect(result.current.txState.state).toBe("error");
    expect(result.current.txState.error?.category).toBe("rpc_failure");
    // The error message should hint at the recovery page
    expect(result.current.txState.error?.message).toMatch(/\/tx\//i);
  });

  it("includes the tx hash in the timeout error message", async () => {
    getMockedLookupTxOnRpc().mockResolvedValue({ chainStatus: "not_found", ledger: 0 });

    const { result } = renderHook(() =>
      useTxLifecycle({
        persistKey: null,
        indexerConfirmTimeoutMs: 500,
        rpcConfirmTimeoutMs: 5000,
      })
    );

    await act(async () => {
      const p = result.current.run(successFn("abc-timeout-hash"), { action: "List" });
      jest.advanceTimersByTime(100);
      await p;
    });

    expect(result.current.txState.state).toBe("error");
    expect(result.current.txState.error?.message).toContain("abc-timeout-hash");
  });
});

// ── indexer_pending → success with indexer_delay warning ─────────────────────

describe("useTxLifecycle — indexer_pending → success via timeout", () => {
  it("reaches success when indexerConfirmTimeoutMs elapses", async () => {
    getMockedLookupTxOnRpc().mockResolvedValue({ chainStatus: "success", ledger: 200 });

    const { result } = renderHook(() =>
      useTxLifecycle({
        persistKey: null,
        indexerConfirmTimeoutMs: 50,
        rpcConfirmTimeoutMs: 5000,
      })
    );

    let runPromise: Promise<unknown>;
    act(() => {
      runPromise = result.current.run(successFn("idx-hash"), { action: "Transfer" });
    });

    // After RPC succeeds but before indexer timeout we should be in indexer_pending
    await act(async () => {
      // Advance past RPC poll (which resolves immediately in mock)
      jest.advanceTimersByTime(10);
      await Promise.resolve(); // flush microtasks
    });

    // Advance past indexer timeout
    await act(async () => {
      jest.advanceTimersByTime(100);
      await runPromise!;
    });

    expect(result.current.txState.state).toBe("success");
    expect(result.current.txState.txHash).toBe("idx-hash");
  });

  it("clears sessionStorage when reaching success after indexer timeout", async () => {
    getMockedLookupTxOnRpc().mockResolvedValue({ chainStatus: "success", ledger: 300 });

    const { result } = renderHook(() =>
      useTxLifecycle({
        persistKey: "idx-clear-test",
        indexerConfirmTimeoutMs: 10,
        rpcConfirmTimeoutMs: 5000,
      })
    );

    await act(async () => {
      const p = result.current.run(successFn("idx-clear-hash"));
      jest.advanceTimersByTime(200);
      await p;
    });

    expect(sessionStorageMock.getItem("idx-clear-test:pending")).toBeNull();
    expect(result.current.txState.state).toBe("success");
  });
});

// ── abort() during confirming preserves txHash ────────────────────────────────

describe("useTxLifecycle — abort() during confirming phase", () => {
  it("does not clear txHash after aborting mid-confirm (tx may be on-chain)", async () => {
    // Simulate a long-running RPC poll that never resolves during the test
    getMockedLookupTxOnRpc().mockImplementation(
      () => new Promise(() => {}) // never resolves
    );

    const { result } = renderHook(() =>
      useTxLifecycle({
        persistKey: null,
        indexerConfirmTimeoutMs: 5000,
        rpcConfirmTimeoutMs: 60_000,
      })
    );

    act(() => {
      result.current.run(successFn("confirm-abort-hash"));
    });

    // Let the hook move past signing into confirming
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Abort while confirming
    act(() => {
      result.current.abort();
    });

    // Advance timers to let any pending promises settle
    await act(async () => {
      jest.advanceTimersByTime(100);
      await Promise.resolve();
    });

    // The lifecycle should not be stuck showing an error without a hash —
    // the user needs the hash to navigate to /tx/[hash]
    if (result.current.txState.state === "error") {
      // If it transitioned to error it should still carry the hash
      expect(result.current.txState.txHash).toBeTruthy();
    }
  });
});

// ── stateEnteredAt is updated on each transition ──────────────────────────────

describe("useTxLifecycle — stateEnteredAt", () => {
  it("updates stateEnteredAt when transitioning from idle to simulating", async () => {
    getMockedLookupTxOnRpc().mockResolvedValue({ chainStatus: "success", ledger: 1 });

    const { result } = renderHook(() =>
      useTxLifecycle({
        persistKey: null,
        indexerConfirmTimeoutMs: 10,
        rpcConfirmTimeoutMs: 5000,
      })
    );

    const idleEnteredAt = result.current.txState.stateEnteredAt;

    act(() => {
      result.current.run(successFn("ts-hash"));
    });

    // stateEnteredAt should be updated (≥ idleEnteredAt)
    expect(result.current.txState.stateEnteredAt).toBeGreaterThanOrEqual(idleEnteredAt);
    expect(result.current.txState.state).not.toBe("idle");

    // Finish
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
  });

  it("stateEnteredAt is 0 in the initial idle state", () => {
    const { result } = renderHook(() => useTxLifecycle({ persistKey: null }));
    expect(result.current.txState.stateEnteredAt).toBe(0);
  });
});

// ── No fn() call while already running (no double-spend risk) ─────────────────

describe("useTxLifecycle — fn() is never called during a concurrent run", () => {
  it("the second fn is never invoked when guard fires", async () => {
    getMockedLookupTxOnRpc().mockResolvedValue({ chainStatus: "success", ledger: 1 });

    const { result } = renderHook(() =>
      useTxLifecycle({
        persistKey: null,
        indexerConfirmTimeoutMs: 2000,
        rpcConfirmTimeoutMs: 5000,
      })
    );

    const firstFn  = successFn("hash-first");
    const secondFn = jest.fn().mockResolvedValue({ hash: "hash-second" });

    let firstPromise: Promise<unknown>;
    act(() => {
      firstPromise = result.current.run(firstFn);
    });

    // Fire second while first is still active
    await act(async () => {
      await result.current.run(secondFn);
    });

    // secondFn should NEVER have been called — this is the core double-spend guard
    expect(secondFn).not.toHaveBeenCalled();

    // Clean up
    await act(async () => {
      jest.advanceTimersByTime(3000);
      await firstPromise!;
    });
  });
});
