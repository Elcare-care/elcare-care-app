// ─────────────────────────────────────────────────────────────────────────────
// __tests__/txLookup.test.ts
//
// Unit tests for lib/txLookup.ts covering:
//   - isValidTxHash
//   - lookupTxOnRpc: not_found, pending (exhausted retries), failed, success, rpc_error, abort
//   - lookupTxOnIndexer: success, not_found (404), network error
//   - lookupTx (combined): confirmed, stale-indexer, failed, not_found, wrong_network, rpc_error
//   - isTxLookupTerminal / nextTxPageInterval helpers
// ─────────────────────────────────────────────────────────────────────────────

import {
  isValidTxHash,
  lookupTxOnRpc,
  lookupTxOnIndexer,
  lookupTx,
  isTxLookupTerminal,
  nextTxPageInterval,
  TX_PAGE_POLL_INTERVALS_MS,
  type TxLookupResult,
} from "../lib/txLookup";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock @stellar/stellar-sdk SorobanRpc so tests never hit a real node.
jest.mock("@stellar/stellar-sdk", () => {
  const GetTransactionStatus = {
    SUCCESS:   "SUCCESS",
    FAILED:    "FAILED",
    NOT_FOUND: "NOT_FOUND",
  };

  const mockGetTransaction = jest.fn();

  const Server = jest.fn().mockImplementation(() => ({
    getTransaction: mockGetTransaction,
  }));

  return {
    SorobanRpc: {
      Server,
      Api: { GetTransactionStatus },
    },
    // other SDK exports used elsewhere — no-ops here
    Contract: jest.fn(),
    TransactionBuilder: jest.fn(),
    xdr: {},
    nativeToScVal: jest.fn(),
    scValToNative: jest.fn(),
    Address: jest.fn(),
    BASE_FEE: "100",
  };
});

// Mock global fetch for indexer calls
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock config so tests don't need env vars
jest.mock("@/lib/config", () => ({
  config: {
    rpcUrl:            "https://soroban-testnet.stellar.org",
    indexerUrl:        "http://localhost:4000",
    network:           "testnet",
    networkPassphrase: "Test SDF Network ; September 2015",
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_HASH = "a".repeat(64);
const SHORT_HASH = "abc123";

/** Grab the mock getTransaction fn from the SDK mock */
function mockRpc() {
  const { SorobanRpc } = require("@stellar/stellar-sdk");
  const instance = new SorobanRpc.Server();
  return instance.getTransaction as jest.Mock;
}

function buildIndexerResponse(overrides: Record<string, unknown> = {}) {
  return {
    hash: VALID_HASH,
    chain_status: "success",
    indexer_status: "confirmed",
    stale_indexer: false,
    explorer_url: `https://stellar.expert/explorer/testnet/tx/${VALID_HASH}`,
    events: [],
    related_resources: {},
    network: "testnet",
    ...overrides,
  };
}

function mockIndexerOk(body: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

function mockIndexerNotFound() {
  mockFetch.mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) });
}

function mockIndexerNetworkError() {
  mockFetch.mockRejectedValueOnce(new Error("fetch failed"));
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// ── isValidTxHash ─────────────────────────────────────────────────────────────

describe("isValidTxHash", () => {
  it("accepts a 64-char lowercase hex string", () => {
    expect(isValidTxHash(VALID_HASH)).toBe(true);
  });

  it("accepts a 64-char uppercase hex string", () => {
    expect(isValidTxHash("A".repeat(64))).toBe(true);
  });

  it("accepts a 64-char mixed-case hex string", () => {
    expect(isValidTxHash("aAbBcCdDeEfF0123456789aAbBcCdDeEfF0123456789aAbBcCdDeEfF01234567")).toBe(true);
  });

  it("rejects a hash shorter than 64 chars", () => {
    expect(isValidTxHash("abc")).toBe(false);
  });

  it("rejects a hash longer than 64 chars", () => {
    expect(isValidTxHash("a".repeat(65))).toBe(false);
  });

  it("rejects a hash with non-hex characters", () => {
    expect(isValidTxHash("g".repeat(64))).toBe(false);
    expect(isValidTxHash("z".repeat(64))).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidTxHash("")).toBe(false);
  });
});

// ── lookupTxOnRpc ─────────────────────────────────────────────────────────────

describe("lookupTxOnRpc — confirmed (SUCCESS)", () => {
  it("returns chainStatus success immediately when RPC says SUCCESS", async () => {
    const getTransaction = mockRpc();
    getTransaction.mockResolvedValue({ status: "SUCCESS", ledger: 1234 });

    const result = await lookupTxOnRpc(VALID_HASH, {
      maxPollAttempts: 3,
      rpcUrl: "https://soroban-testnet.stellar.org",
    });

    expect(result.chainStatus).toBe("success");
    expect(result.ledger).toBe(1234);
    // Should only have called getTransaction once (no retries needed)
    expect(getTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("lookupTxOnRpc — failed (FAILED)", () => {
  it("returns chainStatus failed when RPC says FAILED", async () => {
    const getTransaction = mockRpc();
    getTransaction.mockResolvedValue({ status: "FAILED", ledger: 5678 });

    const result = await lookupTxOnRpc(VALID_HASH, {
      maxPollAttempts: 3,
      rpcUrl: "https://soroban-testnet.stellar.org",
    });

    expect(result.chainStatus).toBe("failed");
    expect(result.ledger).toBe(5678);
    expect(getTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("lookupTxOnRpc — pending then confirmed", () => {
  it("polls NOT_FOUND then returns success when tx appears", async () => {
    const getTransaction = mockRpc();
    getTransaction
      .mockResolvedValueOnce({ status: "NOT_FOUND" })
      .mockResolvedValueOnce({ status: "NOT_FOUND" })
      .mockResolvedValueOnce({ status: "SUCCESS", ledger: 9000 });

    // Run with fake timers — advance past each poll interval
    const promise = lookupTxOnRpc(VALID_HASH, {
      maxPollAttempts: 5,
      pollIntervalMs: 100,
      rpcUrl: "https://soroban-testnet.stellar.org",
    });

    // Advance timer twice (for the two NOT_FOUND sleeps)
    await jest.runAllTimersAsync();

    const result = await promise;
    expect(result.chainStatus).toBe("success");
    expect(result.ledger).toBe(9000);
    expect(getTransaction).toHaveBeenCalledTimes(3);
  });
});

describe("lookupTxOnRpc — not_found after exhausted retries", () => {
  it("returns not_found when all attempts return NOT_FOUND", async () => {
    const getTransaction = mockRpc();
    getTransaction.mockResolvedValue({ status: "NOT_FOUND" });

    const promise = lookupTxOnRpc(VALID_HASH, {
      maxPollAttempts: 3,
      pollIntervalMs: 10,
      rpcUrl: "https://soroban-testnet.stellar.org",
    });

    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.chainStatus).toBe("not_found");
    expect(getTransaction).toHaveBeenCalledTimes(3);
  });
});

describe("lookupTxOnRpc — rpc_error", () => {
  it("returns rpc_error when the RPC throws a network error", async () => {
    const getTransaction = mockRpc();
    getTransaction.mockRejectedValue(new Error("connection refused"));

    const result = await lookupTxOnRpc(VALID_HASH, {
      maxPollAttempts: 3,
      rpcUrl: "https://soroban-testnet.stellar.org",
    });

    expect(result.chainStatus).toBe("rpc_error");
  });
});

describe("lookupTxOnRpc — abort signal", () => {
  it("returns not_found immediately when signal is already aborted", async () => {
    const getTransaction = mockRpc();
    getTransaction.mockResolvedValue({ status: "NOT_FOUND" });

    const ac = new AbortController();
    ac.abort();

    const result = await lookupTxOnRpc(VALID_HASH, {
      maxPollAttempts: 5,
      signal: ac.signal,
      rpcUrl: "https://soroban-testnet.stellar.org",
    });

    expect(result.chainStatus).toBe("not_found");
    // getTransaction should not have been called at all because signal was pre-aborted
    expect(getTransaction).not.toHaveBeenCalled();
  });
});

describe("lookupTxOnRpc — invalid hash", () => {
  it("returns not_found without calling the RPC for an invalid hash", async () => {
    const getTransaction = mockRpc();

    const result = await lookupTxOnRpc(SHORT_HASH, {
      rpcUrl: "https://soroban-testnet.stellar.org",
    });

    expect(result.chainStatus).toBe("not_found");
    expect(getTransaction).not.toHaveBeenCalled();
  });
});

// ── lookupTxOnIndexer ─────────────────────────────────────────────────────────

describe("lookupTxOnIndexer — confirmed", () => {
  it("returns indexed data when the indexer responds with 200", async () => {
    mockIndexerOk(buildIndexerResponse({ events: [{ id: 1, eventType: "ARTWORK_SOLD", actor: "GTEST", ledgerSequence: 100 }] }));

    const result = await lookupTxOnIndexer(VALID_HASH);

    expect(result).not.toBeNull();
    expect(result!.indexer_status).toBe("confirmed");
    expect(result!.events).toHaveLength(1);
    expect(result!.events![0].eventType).toBe("ARTWORK_SOLD");
  });
});

describe("lookupTxOnIndexer — not found (404)", () => {
  it("returns null on 404", async () => {
    mockIndexerNotFound();
    const result = await lookupTxOnIndexer(VALID_HASH);
    expect(result).toBeNull();
  });
});

describe("lookupTxOnIndexer — network error", () => {
  it("returns null when fetch throws", async () => {
    mockIndexerNetworkError();
    const result = await lookupTxOnIndexer(VALID_HASH);
    expect(result).toBeNull();
  });
});

describe("lookupTxOnIndexer — invalid hash", () => {
  it("returns null without fetching for an invalid hash", async () => {
    const result = await lookupTxOnIndexer(SHORT_HASH);
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── lookupTx (combined) ───────────────────────────────────────────────────────

describe("lookupTx — fully confirmed (chain + indexer)", () => {
  it("returns chainStatus success and indexerStatus confirmed", async () => {
    const getTransaction = mockRpc();
    getTransaction.mockResolvedValue({ status: "SUCCESS", ledger: 1500 });
    mockIndexerOk(buildIndexerResponse({
      indexer_status: "confirmed",
      events: [{ id: 2, eventType: "LISTING_CREATED", actor: "GART", ledgerSequence: 1500 }],
      related_resources: { listing_id: "42" },
    }));

    const result = await lookupTx(VALID_HASH, { maxPollAttempts: 1 });

    expect(result.chainStatus).toBe("success");
    expect(result.indexerStatus).toBe("confirmed");
    expect(result.staleIndexer).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.relatedResources.listing_id).toBe("42");
    expect(result.explorerUrl).toContain(VALID_HASH);
    expect(result.explorerUrl).toContain("testnet");
  });
});

describe("lookupTx — stale indexer (chain confirmed, indexer pending)", () => {
  it("sets staleIndexer true when chain is success but indexer has no data", async () => {
    const getTransaction = mockRpc();
    getTransaction.mockResolvedValue({ status: "SUCCESS", ledger: 2000 });
    // Indexer returns 404 (not yet ingested)
    mockIndexerNotFound();

    const result = await lookupTx(VALID_HASH, { maxPollAttempts: 1 });

    expect(result.chainStatus).toBe("success");
    expect(result.indexerStatus).toBe("pending");
    expect(result.staleIndexer).toBe(true);
  });
});

describe("lookupTx — failed on chain", () => {
  it("returns chainStatus failed with indexerStatus not_found", async () => {
    const getTransaction = mockRpc();
    getTransaction.mockResolvedValue({ status: "FAILED", ledger: 3000 });
    mockIndexerNotFound();

    const result = await lookupTx(VALID_HASH, { maxPollAttempts: 1 });

    expect(result.chainStatus).toBe("failed");
    expect(result.indexerStatus).toBe("not_found");
    expect(result.staleIndexer).toBe(false);
  });
});

describe("lookupTx — not found on both RPC and indexer", () => {
  it("returns chainStatus not_found when both sources have no data", async () => {
    const getTransaction = mockRpc();
    // Exhaust all attempts with NOT_FOUND
    getTransaction.mockResolvedValue({ status: "NOT_FOUND" });
    mockIndexerNotFound();

    const promise = lookupTx(VALID_HASH, { maxPollAttempts: 2, pollIntervalMs: 10 });
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.chainStatus).toBe("not_found");
    expect(result.indexerStatus).toBe("not_found");
  });
});

describe("lookupTx — wrong network", () => {
  it("returns chainStatus wrong_network when indexer reports a different network", async () => {
    const getTransaction = mockRpc();
    getTransaction.mockResolvedValue({ status: "SUCCESS", ledger: 4000 });
    // Indexer says the tx belongs to mainnet, but our config expects testnet
    mockIndexerOk(buildIndexerResponse({
      network: "mainnet",
      indexer_status: "confirmed",
    }));

    const result = await lookupTx(VALID_HASH, {
      maxPollAttempts: 1,
      expectedNetwork: "Test SDF Network ; September 2015", // testnet passphrase
    });

    expect(result.chainStatus).toBe("wrong_network");
    expect(result.lookupError).toBeTruthy();
    expect(result.lookupError).toMatch(/mainnet/i);
  });

  it("does NOT flag wrong_network when both are testnet", async () => {
    const getTransaction = mockRpc();
    getTransaction.mockResolvedValue({ status: "SUCCESS", ledger: 4001 });
    mockIndexerOk(buildIndexerResponse({ network: "testnet", indexer_status: "confirmed" }));

    const result = await lookupTx(VALID_HASH, {
      maxPollAttempts: 1,
      expectedNetwork: "Test SDF Network ; September 2015",
    });

    expect(result.chainStatus).toBe("success");
  });
});

describe("lookupTx — invalid hash", () => {
  it("returns not_found with a lookupError for a short hash", async () => {
    const result = await lookupTx(SHORT_HASH);

    expect(result.chainStatus).toBe("not_found");
    expect(result.lookupError).toMatch(/invalid/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("lookupTx — rpc_error with indexer available", () => {
  it("returns rpc_error when RPC throws regardless of indexer data", async () => {
    const getTransaction = mockRpc();
    getTransaction.mockRejectedValue(new Error("socket hang up"));
    mockIndexerOk(buildIndexerResponse({ indexer_status: "confirmed" }));

    const result = await lookupTx(VALID_HASH, { maxPollAttempts: 1 });

    expect(result.chainStatus).toBe("rpc_error");
  });
});

// ── isTxLookupTerminal ────────────────────────────────────────────────────────

describe("isTxLookupTerminal", () => {
  function makeResult(overrides: Partial<TxLookupResult>): TxLookupResult {
    return {
      hash: VALID_HASH,
      chainStatus: "success",
      indexerStatus: "confirmed",
      staleIndexer: false,
      ledger: 0,
      network: "testnet",
      explorerUrl: "",
      events: [],
      relatedResources: {},
      ...overrides,
    };
  }

  it("is terminal for success + indexer confirmed", () => {
    expect(isTxLookupTerminal(makeResult({ chainStatus: "success", staleIndexer: false }))).toBe(true);
  });

  it("is NOT terminal for success with stale indexer", () => {
    expect(isTxLookupTerminal(makeResult({ chainStatus: "success", staleIndexer: true }))).toBe(false);
  });

  it("is terminal for failed", () => {
    expect(isTxLookupTerminal(makeResult({ chainStatus: "failed" }))).toBe(true);
  });

  it("is terminal for wrong_network", () => {
    expect(isTxLookupTerminal(makeResult({ chainStatus: "wrong_network" }))).toBe(true);
  });

  it("is NOT terminal for pending", () => {
    expect(isTxLookupTerminal(makeResult({ chainStatus: "pending" }))).toBe(false);
  });

  it("is NOT terminal for not_found", () => {
    expect(isTxLookupTerminal(makeResult({ chainStatus: "not_found" }))).toBe(false);
  });

  it("is NOT terminal for rpc_error", () => {
    expect(isTxLookupTerminal(makeResult({ chainStatus: "rpc_error" }))).toBe(false);
  });
});

// ── nextTxPageInterval ────────────────────────────────────────────────────────

describe("nextTxPageInterval", () => {
  it("returns the first interval for attempt 0", () => {
    expect(nextTxPageInterval(0)).toBe(TX_PAGE_POLL_INTERVALS_MS[0]);
  });

  it("caps at the last interval for large attempt numbers", () => {
    const last = TX_PAGE_POLL_INTERVALS_MS[TX_PAGE_POLL_INTERVALS_MS.length - 1];
    expect(nextTxPageInterval(999)).toBe(last);
  });

  it("returns increasing intervals across the first few attempts", () => {
    const intervals = [0, 1, 2, 3].map(nextTxPageInterval);
    for (let i = 1; i < intervals.length; i++) {
      expect(intervals[i]).toBeGreaterThanOrEqual(intervals[i - 1]);
    }
  });
});
