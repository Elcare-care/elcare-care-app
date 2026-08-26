/**
 * Tests for lib/tx-intent.ts — canonical transaction intent, comparison,
 * and pre-sign mismatch detection (Issue #536).
 *
 * These build real, unsigned Soroban transactions with the Stellar SDK (the
 * same way lib/contract.ts does) so `buildTransactionIntent` is exercised
 * against genuine XDR, not hand-rolled fixtures. Addresses are derived via
 * `Address.account` / `Address.contract` from fixed byte buffers so they
 * are valid, checksummed strkeys without depending on random key
 * generation.
 */

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Operation,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import {
  assertIntentsMatch,
  buildExpectedBuyArtworkIntent,
  buildTransactionIntent,
  intentsMatch,
  TxIntentMismatchError,
} from "@/lib/tx-intent";

// ── Fixtures ──────────────────────────────────────────────────────────────

const NETWORK_A = "Test SDF Network ; September 2015";
const NETWORK_B = "Public Global Stellar Network ; September 2015";

const BUYER = Address.account(Buffer.alloc(32, 1)).toString();
const BIDDER = Address.account(Buffer.alloc(32, 2)).toString();
const ATTACKER = Address.account(Buffer.alloc(32, 9)).toString();

const CONTRACT_A = Address.contract(Buffer.alloc(32, 3)).toString();
const CONTRACT_B = Address.contract(Buffer.alloc(32, 4)).toString();

const TOKEN_A = Address.contract(Buffer.alloc(32, 5)).toString();
const TOKEN_B = Address.contract(Buffer.alloc(32, 6)).toString();

/** Builds a real, unsigned Transaction invoking `method` on `contractId`. */
function buildTx(opts: {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  networkPassphrase?: string;
  sourceAccount?: string;
}): Transaction {
  const account = new Account(opts.sourceAccount ?? BUYER, "1");
  const contract = new Contract(opts.contractId);
  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: opts.networkPassphrase ?? NETWORK_A,
  })
    .addOperation(contract.call(opts.method, ...opts.args))
    .setTimeout(30)
    .build() as Transaction;
}

function buyArtworkTx(overrides: Partial<{ contractId: string; buyer: string; listingId: number; network: string }> = {}) {
  const { contractId = CONTRACT_A, buyer = BUYER, listingId = 42, network = NETWORK_A } = overrides;
  return buildTx({
    contractId,
    method: "buy_artwork",
    networkPassphrase: network,
    args: [new Address(buyer).toScVal(), nativeToScVal(BigInt(listingId), { type: "u64" })],
  });
}

function placeBidTx(overrides: Partial<{ bidder: string; auctionId: number; amount: bigint }> = {}) {
  const { bidder = BIDDER, auctionId = 7, amount = 5_000_000n } = overrides;
  return buildTx({
    contractId: CONTRACT_A,
    method: "place_bid",
    args: [
      new Address(bidder).toScVal(),
      nativeToScVal(BigInt(auctionId), { type: "u64" }),
      nativeToScVal(amount, { type: "i128" }),
    ],
  });
}

function transferAdminTx(overrides: Partial<{ currentAdmin: string; candidate: string }> = {}) {
  const { currentAdmin = BUYER, candidate = BIDDER } = overrides;
  return buildTx({
    contractId: CONTRACT_A,
    method: "transfer_admin",
    args: [new Address(currentAdmin).toScVal(), new Address(candidate).toScVal()],
  });
}

function makeOfferTx(overrides: Partial<{ offerer: string; listingId: number; amount: bigint; token: string }> = {}) {
  const { offerer = BUYER, listingId = 3, amount = 1_000_0000n, token = TOKEN_A } = overrides;
  return buildTx({
    contractId: CONTRACT_A,
    method: "make_offer",
    args: [
      new Address(offerer).toScVal(),
      nativeToScVal(BigInt(listingId), { type: "u64" }),
      nativeToScVal(amount, { type: "i128" }),
      new Address(token).toScVal(),
    ],
  });
}

// ════════════════════════════════════════════════════════════════════════════
// buildTransactionIntent — decoding
// ════════════════════════════════════════════════════════════════════════════

describe("buildTransactionIntent", () => {
  test("decodes method, contractId, network, sourceAccount, and labelled args for buy_artwork", () => {
    const tx = buyArtworkTx();
    const intent = buildTransactionIntent(tx);

    expect(intent.method).toBe("buy_artwork");
    expect(intent.contractId).toBe(CONTRACT_A);
    expect(intent.networkPassphrase).toBe(NETWORK_A);
    expect(intent.sourceAccount).toBe(BUYER);
    expect(intent.args).toEqual([
      { index: 0, label: "buyer", value: BUYER },
      { index: 1, label: "listing_id", value: "42" },
    ]);
  });

  test("decodes amount for place_bid", () => {
    const tx = placeBidTx({ amount: 12_345_000n });
    const intent = buildTransactionIntent(tx);

    const amountArg = intent.args.find((a) => a.label === "amount");
    expect(amountArg?.value).toBe("12345000");
  });

  test("decodes asset (token address) for make_offer", () => {
    const tx = makeOfferTx({ token: TOKEN_B });
    const intent = buildTransactionIntent(tx);

    const assetArg = intent.args.find((a) => a.label === "asset");
    expect(assetArg?.value).toBe(TOKEN_B);
  });

  test("unrecognised method still decodes with generic arg_<n> labels", () => {
    const tx = buildTx({
      contractId: CONTRACT_A,
      method: "some_future_method",
      args: [nativeToScVal(7, { type: "u32" })],
    });
    const intent = buildTransactionIntent(tx);
    expect(intent.method).toBe("some_future_method");
    expect(intent.args).toEqual([{ index: 0, label: "arg_0", value: 7 }]);
  });

  test("fails closed: throws when the transaction has no contract-invocation operation", () => {
    const account = new Account(BUYER, "1");
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_A })
      .addOperation(Operation.bumpSequence({ bumpTo: "123" }))
      .setTimeout(30)
      .build();

    expect(() => buildTransactionIntent(tx as Transaction)).toThrow();
  });

  test("redacts internal/non-user-relevant fields — only the canonical fields are present", () => {
    const tx = buyArtworkTx();
    const intent = buildTransactionIntent(tx);

    expect(Object.keys(intent).sort()).toEqual(
      ["args", "contractId", "method", "networkPassphrase", "sourceAccount"].sort()
    );
    // Sanity: none of the redacted fields leak in as extra keys under any name.
    expect(intent).not.toHaveProperty("fee");
    expect(intent).not.toHaveProperty("sequence");
    expect(intent).not.toHaveProperty("signatures");
    expect(intent).not.toHaveProperty("timeBounds");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// buildExpectedBuyArtworkIntent — UI-side canonical intent matches the real tx
// ════════════════════════════════════════════════════════════════════════════

describe("buildExpectedBuyArtworkIntent", () => {
  test("matches the intent decoded from the real assembled buy_artwork transaction", () => {
    const tx = buyArtworkTx({ contractId: CONTRACT_A, buyer: BUYER, listingId: 42, network: NETWORK_A });
    const actual = buildTransactionIntent(tx);
    const displayed = buildExpectedBuyArtworkIntent(42, BUYER, CONTRACT_A, NETWORK_A);

    expect(intentsMatch(displayed, actual)).toEqual({ matches: true, mismatchedFields: [] });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// intentsMatch / assertIntentsMatch — the six required mismatch categories
// ════════════════════════════════════════════════════════════════════════════

describe("intentsMatch — substitution detection", () => {
  test("identical intents match", () => {
    const displayed = buildTransactionIntent(buyArtworkTx());
    const actual = buildTransactionIntent(buyArtworkTx());
    expect(intentsMatch(displayed, actual)).toEqual({ matches: true, mismatchedFields: [] });
  });

  test("detects a modified argument (listing_id substituted)", () => {
    const displayed = buildTransactionIntent(buyArtworkTx({ listingId: 42 }));
    const actual = buildTransactionIntent(buyArtworkTx({ listingId: 999 }));

    const result = intentsMatch(displayed, actual);
    expect(result.matches).toBe(false);
    expect(result.mismatchedFields).toContain("args[1].listing_id");
  });

  test("detects a substituted contract ID", () => {
    const displayed = buildTransactionIntent(buyArtworkTx({ contractId: CONTRACT_A }));
    const actual = buildTransactionIntent(buyArtworkTx({ contractId: CONTRACT_B }));

    const result = intentsMatch(displayed, actual);
    expect(result.matches).toBe(false);
    expect(result.mismatchedFields).toContain("contractId");
  });

  test("detects a substituted network passphrase", () => {
    const displayed = buildTransactionIntent(buyArtworkTx({ network: NETWORK_A }));
    const actual = buildTransactionIntent(buyArtworkTx({ network: NETWORK_B }));

    const result = intentsMatch(displayed, actual);
    expect(result.matches).toBe(false);
    expect(result.mismatchedFields).toContain("networkPassphrase");
  });

  test("detects a substituted asset/token address", () => {
    const displayed = buildTransactionIntent(makeOfferTx({ token: TOKEN_A }));
    const actual = buildTransactionIntent(makeOfferTx({ token: TOKEN_B }));

    const result = intentsMatch(displayed, actual);
    expect(result.matches).toBe(false);
    expect(result.mismatchedFields).toContain("args[3].asset");
  });

  test("detects a substituted counterparty address (buyer)", () => {
    const displayed = buildTransactionIntent(buyArtworkTx({ buyer: BUYER }));
    const actual = buildTransactionIntent(buyArtworkTx({ buyer: ATTACKER }));

    const result = intentsMatch(displayed, actual);
    expect(result.matches).toBe(false);
    expect(result.mismatchedFields).toContain("args[0].buyer");
  });

  test("detects a substituted recipient address", () => {
    const displayed = buildTransactionIntent(transferAdminTx({ candidate: BIDDER }));
    const actual = buildTransactionIntent(transferAdminTx({ candidate: ATTACKER }));

    const result = intentsMatch(displayed, actual);
    expect(result.matches).toBe(false);
    expect(result.mismatchedFields).toContain("args[1].recipient");
  });

  test("detects a substituted amount", () => {
    const displayed = buildTransactionIntent(placeBidTx({ amount: 5_000_000n }));
    const actual = buildTransactionIntent(placeBidTx({ amount: 50_000_000n }));

    const result = intentsMatch(displayed, actual);
    expect(result.matches).toBe(false);
    expect(result.mismatchedFields).toContain("args[2].amount");
  });

  test("detects a substituted method (different call entirely)", () => {
    const displayed = buildTransactionIntent(buyArtworkTx());
    const actual = buildTransactionIntent(placeBidTx());

    const result = intentsMatch(displayed, actual);
    expect(result.matches).toBe(false);
    expect(result.mismatchedFields).toContain("method");
  });
});

describe("assertIntentsMatch", () => {
  test("does not throw when intents match", () => {
    const displayed = buildTransactionIntent(buyArtworkTx());
    const actual = buildTransactionIntent(buyArtworkTx());
    expect(() => assertIntentsMatch(displayed, actual, "test")).not.toThrow();
  });

  test("throws TxIntentMismatchError with the mismatched fields on any difference — signing must abort", () => {
    const displayed = buildTransactionIntent(buyArtworkTx({ listingId: 1 }));
    const actual = buildTransactionIntent(buyArtworkTx({ listingId: 2 }));

    let caught: unknown = null;
    try {
      assertIntentsMatch(displayed, actual, "checkout_confirmation");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(TxIntentMismatchError);
    expect((caught as TxIntentMismatchError).name).toBe("TxIntentMismatchError");
    expect((caught as TxIntentMismatchError).mismatchedFields.length).toBeGreaterThan(0);
    // The message must never leak secrets — it only names fields, not values.
    expect((caught as TxIntentMismatchError).message).not.toContain(BUYER);
  });
});
