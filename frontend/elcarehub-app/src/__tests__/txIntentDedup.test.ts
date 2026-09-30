// ─────────────────────────────────────────────────────────────────────────────
// __tests__/txIntentDedup.test.ts
//
// Issue #524: Tests for the client-side transaction intent dedup registry —
// fingerprinting, begin/duplicate detection, terminal clearing (retry),
// expiry, per-account/network scoping, and cross-tab notification.
// ─────────────────────────────────────────────────────────────────────────────

import {
  computeIntentFingerprint,
  beginIntent,
  updateIntentStatus,
  clearIntent,
  getIntent,
  intentScopeKey,
  subscribeToIntentChanges,
  DEFAULT_INTENT_WINDOW_MS,
} from "../lib/txIntentDedup";

// ── In-memory localStorage mock (mirrors the sessionStorage mock pattern
// already used by useTxLifecycle.test.tsx) ────────────────────────────────

function makeStorageMock() {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, val: string) => {
      store[key] = val;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
}

const localStorageMock = makeStorageMock();
Object.defineProperty(window, "localStorage", { value: localStorageMock, writable: true });

beforeEach(() => {
  localStorageMock.clear();
  jest.useRealTimers();
});

const NETWORK = "Test SDF Network ; September 2015";
const ACCOUNT = "GABC1234567890";

describe("computeIntentFingerprint", () => {
  it("is deterministic for identical inputs", () => {
    const input = { action: "Bid", account: ACCOUNT, network: NETWORK, contract: "C123", args: { auctionId: 1, amount: 5 } };
    expect(computeIntentFingerprint(input)).toBe(computeIntentFingerprint({ ...input }));
  });

  it("is stable regardless of argument key order", () => {
    const a = computeIntentFingerprint({
      action: "Bid",
      account: ACCOUNT,
      network: NETWORK,
      args: { amount: 5, auctionId: 1 },
    });
    const b = computeIntentFingerprint({
      action: "Bid",
      account: ACCOUNT,
      network: NETWORK,
      args: { auctionId: 1, amount: 5 },
    });
    expect(a).toBe(b);
  });

  it("differs when the price/amount argument differs", () => {
    const a = computeIntentFingerprint({ action: "Bid", account: ACCOUNT, network: NETWORK, args: { auctionId: 1, amount: 5 } });
    const b = computeIntentFingerprint({ action: "Bid", account: ACCOUNT, network: NETWORK, args: { auctionId: 1, amount: 6 } });
    expect(a).not.toBe(b);
  });

  it("differs when the account differs", () => {
    const a = computeIntentFingerprint({ action: "Bid", account: "GAAA", network: NETWORK, args: { auctionId: 1 } });
    const b = computeIntentFingerprint({ action: "Bid", account: "GBBB", network: NETWORK, args: { auctionId: 1 } });
    expect(a).not.toBe(b);
  });

  it("differs when the network differs", () => {
    const a = computeIntentFingerprint({ action: "Bid", account: ACCOUNT, network: "testnet", args: { auctionId: 1 } });
    const b = computeIntentFingerprint({ action: "Bid", account: ACCOUNT, network: "mainnet", args: { auctionId: 1 } });
    expect(a).not.toBe(b);
  });

  it("differs when the contract differs (different asset/collection)", () => {
    const a = computeIntentFingerprint({ action: "List", account: ACCOUNT, network: NETWORK, contract: "C_NFT_A", args: { price: 10 } });
    const b = computeIntentFingerprint({ action: "List", account: ACCOUNT, network: NETWORK, contract: "C_NFT_B", args: { price: 10 } });
    expect(a).not.toBe(b);
  });

  it("differs when the action differs", () => {
    const a = computeIntentFingerprint({ action: "Accept offer", account: ACCOUNT, network: NETWORK, args: { offerId: 1 } });
    const b = computeIntentFingerprint({ action: "Reject offer", account: ACCOUNT, network: NETWORK, args: { offerId: 1 } });
    expect(a).not.toBe(b);
  });
});

describe("beginIntent — duplicate detection", () => {
  it("first call is not a duplicate", () => {
    const res = beginIntent({ action: "Bid", account: ACCOUNT, network: NETWORK, args: { auctionId: 1, amount: 5 } });
    expect(res.duplicate).toBe(false);
    expect(res.record.status).toBe("pending");
  });

  it("an identical second call within the window is a duplicate", () => {
    beginIntent({ action: "Bid", account: ACCOUNT, network: NETWORK, args: { auctionId: 1, amount: 5 } });
    const res = beginIntent({ action: "Bid", account: ACCOUNT, network: NETWORK, args: { auctionId: 1, amount: 5 } });
    expect(res.duplicate).toBe(true);
  });

  it("a different price is NOT deduplicated against a pending intent", () => {
    beginIntent({ action: "Bid", account: ACCOUNT, network: NETWORK, args: { auctionId: 1, amount: 5 } });
    const res = beginIntent({ action: "Bid", account: ACCOUNT, network: NETWORK, args: { auctionId: 1, amount: 7 } });
    expect(res.duplicate).toBe(false);
  });

  it("a different account is NOT deduplicated against a pending intent", () => {
    beginIntent({ action: "Bid", account: "GAAA", network: NETWORK, args: { auctionId: 1, amount: 5 } });
    const res = beginIntent({ action: "Bid", account: "GBBB", network: NETWORK, args: { auctionId: 1, amount: 5 } });
    expect(res.duplicate).toBe(false);
  });

  it("a different asset/contract is NOT deduplicated against a pending intent", () => {
    beginIntent({ action: "List", account: ACCOUNT, network: NETWORK, contract: "COLLECTION_A", args: { price: 10 } });
    const res = beginIntent({ action: "List", account: ACCOUNT, network: NETWORK, contract: "COLLECTION_B", args: { price: 10 } });
    expect(res.duplicate).toBe(false);
  });
});

describe("updateIntentStatus — terminal clears the slot (retry)", () => {
  it("a terminal 'error' status frees the fingerprint for an immediate retry", () => {
    const first = beginIntent({ action: "Bid", account: ACCOUNT, network: NETWORK, args: { auctionId: 1, amount: 5 } });
    expect(first.duplicate).toBe(false);

    updateIntentStatus({ network: NETWORK, account: ACCOUNT, fingerprint: first.fingerprint, status: "error" });

    const retry = beginIntent({ action: "Bid", account: ACCOUNT, network: NETWORK, args: { auctionId: 1, amount: 5 } });
    expect(retry.duplicate).toBe(false);
  });

  it("a terminal 'success' status frees the fingerprint", () => {
    const first = beginIntent({ action: "Bid", account: ACCOUNT, network: NETWORK, args: { auctionId: 1, amount: 5 } });
    updateIntentStatus({ network: NETWORK, account: ACCOUNT, fingerprint: first.fingerprint, status: "success", txHash: "abc" });

    expect(getIntent(NETWORK, ACCOUNT, first.fingerprint)).toBeNull();
  });

  it("updating with 'pending' + a tx hash keeps it blocking and records the hash", () => {
    const first = beginIntent({ action: "Bid", account: ACCOUNT, network: NETWORK, args: { auctionId: 1, amount: 5 } });
    updateIntentStatus({ network: NETWORK, account: ACCOUNT, fingerprint: first.fingerprint, status: "pending", txHash: "hash123" });

    const dup = beginIntent({ action: "Bid", account: ACCOUNT, network: NETWORK, args: { auctionId: 1, amount: 5 } });
    expect(dup.duplicate).toBe(true);
    expect(dup.record.txHash).toBe("hash123");
  });
});

describe("clearIntent — manual reset", () => {
  it("explicitly removes a pending intent so it no longer blocks", () => {
    const first = beginIntent({ action: "Bid", account: ACCOUNT, network: NETWORK, args: { auctionId: 1, amount: 5 } });
    clearIntent(NETWORK, ACCOUNT, first.fingerprint);

    const res = beginIntent({ action: "Bid", account: ACCOUNT, network: NETWORK, args: { auctionId: 1, amount: 5 } });
    expect(res.duplicate).toBe(false);
  });
});

describe("beginIntent — validity window expiry", () => {
  it("an expired pending intent no longer blocks a new identical call", () => {
    jest.useFakeTimers().setSystemTime(1_000_000);
    const first = beginIntent({
      action: "Bid",
      account: ACCOUNT,
      network: NETWORK,
      args: { auctionId: 1, amount: 5 },
      windowMs: 1_000,
    });
    expect(first.duplicate).toBe(false);

    // Still within the window — blocked.
    jest.setSystemTime(1_000_000 + 500);
    expect(beginIntent({ action: "Bid", account: ACCOUNT, network: NETWORK, args: { auctionId: 1, amount: 5 }, windowMs: 1_000 }).duplicate).toBe(true);

    // Past the window — unblocked.
    jest.setSystemTime(1_000_000 + 5_000);
    const afterExpiry = beginIntent({ action: "Bid", account: ACCOUNT, network: NETWORK, args: { auctionId: 1, amount: 5 }, windowMs: 1_000 });
    expect(afterExpiry.duplicate).toBe(false);
  });

  it("defaults to DEFAULT_INTENT_WINDOW_MS when windowMs is not supplied", () => {
    jest.useFakeTimers().setSystemTime(0);
    const first = beginIntent({ action: "Bid", account: ACCOUNT, network: NETWORK, args: { auctionId: 1, amount: 5 } });
    expect(first.record.expiresAt).toBe(DEFAULT_INTENT_WINDOW_MS);
  });
});

describe("scoping — account and network isolation", () => {
  it("switching accounts does not inherit a pending intent from the old account", () => {
    beginIntent({ action: "Bid", account: "GOLD_ACCOUNT", network: NETWORK, args: { auctionId: 1, amount: 5 } });
    const res = beginIntent({ action: "Bid", account: "GNEW_ACCOUNT", network: NETWORK, args: { auctionId: 1, amount: 5 } });
    expect(res.duplicate).toBe(false);
  });

  it("switching networks does not inherit a pending intent from the old network", () => {
    beginIntent({ action: "Bid", account: ACCOUNT, network: "testnet-passphrase", args: { auctionId: 1, amount: 5 } });
    const res = beginIntent({ action: "Bid", account: ACCOUNT, network: "mainnet-passphrase", args: { auctionId: 1, amount: 5 } });
    expect(res.duplicate).toBe(false);
  });

  it("intentScopeKey differs per account and per network", () => {
    const k1 = intentScopeKey(NETWORK, "GAAA");
    const k2 = intentScopeKey(NETWORK, "GBBB");
    const k3 = intentScopeKey("other-network", "GAAA");
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
  });
});

describe("cross-tab — subscribeToIntentChanges reacts to the storage event", () => {
  it("invokes the listener with the scope key when a matching localStorage key changes", () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToIntentChanges(listener);

    const key = intentScopeKey(NETWORK, ACCOUNT);
    const event = new Event("storage") as StorageEvent;
    Object.defineProperty(event, "key", { value: key });
    window.dispatchEvent(event);

    expect(listener).toHaveBeenCalledWith(key);
    unsubscribe();
  });

  it("ignores storage events for unrelated keys", () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToIntentChanges(listener);

    const event = new Event("storage") as StorageEvent;
    Object.defineProperty(event, "key", { value: "some.other.app.key" });
    window.dispatchEvent(event);

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("stops receiving events after unsubscribe", () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToIntentChanges(listener);
    unsubscribe();

    const key = intentScopeKey(NETWORK, ACCOUNT);
    const event = new Event("storage") as StorageEvent;
    Object.defineProperty(event, "key", { value: key });
    window.dispatchEvent(event);

    expect(listener).not.toHaveBeenCalled();
  });
});
