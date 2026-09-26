/**
 * lib/tx-intent.ts — Canonical transaction intent (Issue #536)
 *
 * Threat: a malicious browser extension, a compromised frontend build, or a
 * stale/incorrect network configuration could present the user with one
 * transaction summary while the object actually handed to the wallet for
 * signing is different (different contract, different method, different
 * arguments, different network). The existing preflight guard
 * (lib/preflight.ts) checks network + contract identity *before* a
 * transaction is even built; it does not verify that the transaction the
 * user is about to sign still matches what they were shown.
 *
 * This module provides a single, canonical way to turn an assembled Soroban
 * `Transaction` into a small, JSON-safe, user-verifiable summary — the
 * "intent". The same function is used to:
 *
 *   1. Build the intent the confirmation UI renders (from the real args the
 *      call site is about to use), and
 *   2. Re-derive the intent from the transaction object that is *actually*
 *      about to be handed to the wallet adapter's `signTransaction`.
 *
 * `intentsMatch` / `assertIntentsMatch` compare the two. Any mismatch means
 * something changed the transaction between "what the user was shown" and
 * "what is being signed" — signing must abort.
 *
 * ── What is included, and why ──────────────────────────────────────────────
 *   - `method`             the contract entry point being invoked
 *   - `contractId`         the contract address the call targets
 *   - `networkPassphrase`  the network the transaction is bound to
 *   - `sourceAccount`      the account paying fees / the signer
 *   - `args`               decoded, labelled call arguments (recipient
 *                          addresses, amounts, asset/token addresses,
 *                          listing/auction ids, etc.)
 *
 * All of the above are exactly what the user needs to verify "is this the
 * transaction I think I'm signing?" — and all of it is public information
 * that will appear on-chain once submitted, so it is safe to log/telemetry.
 *
 * ── What is deliberately redacted / omitted, and why ───────────────────────
 *   - sequence number       — internal bookkeeping, churns on every attempt,
 *                              not something a user can meaningfully verify
 *   - fee / resource fee    — varies per-simulation; cost is already
 *                              surfaced separately in the settlement preview
 *   - time bounds            — internal replay-protection plumbing
 *   - Soroban resource footprint / instructions — internal execution
 *                              metadata, meaningless to a human reviewer
 *   - signatures              — never present before signing; would be a
 *                              secret-adjacent field if it were
 *   - source account's private key / any wallet secret — never touched by
 *     this module; it only ever reads an already-built, unsigned Transaction
 */

import {
  Address,
  Transaction,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { config } from "./config";

// ── Types ─────────────────────────────────────────────────────────────────

/** A single decoded, labelled call argument. */
export interface DecodedArg {
  /** Positional index in the contract call. */
  index: number;
  /**
   * Human/semantically meaningful label when the method is known
   * (e.g. "recipient", "amount", "asset"), otherwise `arg_<index>`.
   */
  label: string;
  /** JSON-safe decoded value (bigints/Addresses/Buffers stringified). */
  value: unknown;
}

/**
 * Canonical, user-verifiable summary of a Soroban contract-invocation
 * transaction. This is the single shape rendered by the confirmation UI
 * AND recomputed immediately before signing.
 */
export interface TransactionIntent {
  method: string;
  contractId: string;
  networkPassphrase: string;
  sourceAccount: string;
  args: DecodedArg[];
}

/** Result of comparing two intents. */
export interface IntentComparison {
  matches: boolean;
  /** Dotted/bracketed field paths that differ, e.g. "contractId", "args[1].amount". */
  mismatchedFields: string[];
}

/**
 * Thrown when the intent rendered to the user does not match the intent
 * re-derived from the transaction that is about to be signed. Signing must
 * never proceed past this error.
 */
export class TxIntentMismatchError extends Error {
  readonly kind = "TX_INTENT_MISMATCH" as const;
  constructor(
    message: string,
    public readonly mismatchedFields: string[]
  ) {
    super(message);
    this.name = "TxIntentMismatchError";
  }
}

// ── Method → argument label maps ─────────────────────────────────────────
//
// Positional argument labels for the contract entry points this app calls.
// These only affect *display* (the label shown next to a value) — the
// mismatch comparison itself is purely positional/value-based, so an
// unrecognised method still gets fully compared, just with generic
// `arg_<n>` labels.

const METHOD_ARG_LABELS: Record<string, string[]> = {
  create_listing: ["artist", "price", "currency", "asset", "collection", "listing_token_id", "quantity", "recipients", "expires_at"],
  buy_artwork: ["buyer", "listing_id"],
  cancel_listing: ["artist", "listing_id"],
  create_listings: ["artist", "requests"],
  cancel_listings: ["artist", "listing_ids"],
  update_listing: ["artist", "listing_id", "new_price", "asset", "recipients"],
  update_listings: ["artist", "requests"],
  make_offer: ["offerer", "listing_id", "amount", "asset"],
  withdraw_offer: ["offerer", "offer_id"],
  reclaim_offer: ["offer_id"],
  accept_offer: ["owner", "offer_id"],
  reject_offer: ["owner", "offer_id"],
  create_auction: ["creator", "metadata_cid", "asset", "reserve_price", "duration_seconds", "royalty_bps", "recipients"],
  place_bid: ["bidder", "auction_id", "amount"],
  finalize_auction: ["caller", "auction_id"],
  block_bidder: ["caller", "auction_id", "recipient"],
  unblock_bidder: ["caller", "auction_id", "recipient"],
  transfer_admin: ["current_admin", "recipient"],
  accept_admin: ["candidate"],
  cancel_admin_proposal: ["current_admin"],
};

// ── ScVal → JSON-safe native value ───────────────────────────────────────

/**
 * Recursively converts a native value decoded via `scValToNative` into a
 * stable, JSON-safe representation so intents can be deep-compared and
 * rendered without any bigint/Buffer/Address-specific handling leaking into
 * callers.
 */
function sanitizeNativeValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Address) return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `0x${Buffer.from(value).toString("hex")}`;
  }
  if (Array.isArray(value)) return value.map(sanitizeNativeValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeNativeValue(v);
    }
    return out;
  }
  return value;
}

// ── Core: build the canonical intent from an assembled transaction ───────

/**
 * Extracts the canonical, user-verifiable intent from an assembled Soroban
 * transaction — the exact object about to be (or that was) handed to the
 * wallet adapter's `signTransaction`.
 *
 * Fails closed: if the transaction has no `invokeHostFunction` contract-call
 * operation (which every write flow in this app produces), this throws
 * rather than returning a placeholder — an unrecognisable transaction shape
 * must never be silently treated as "nothing to compare".
 */
export function buildTransactionIntent(tx: Transaction): TransactionIntent {
  const op = tx.operations.find((o) => o.type === "invokeHostFunction");

  if (!op || op.type !== "invokeHostFunction") {
    throw new Error(
      "Cannot build transaction intent: no invokeHostFunction operation found on the transaction."
    );
  }

  let invocation: xdr.InvokeContractArgs;
  try {
    invocation = op.func.invokeContract();
  } catch {
    throw new Error(
      "Cannot build transaction intent: operation is not a contract invocation."
    );
  }

  const contractId = Address.fromScAddress(invocation.contractAddress()).toString();
  const functionNameRaw = invocation.functionName();
  const method =
    typeof functionNameRaw === "string"
      ? functionNameRaw
      : Buffer.from(functionNameRaw).toString("utf-8");

  const labels = METHOD_ARG_LABELS[method] ?? [];
  const args: DecodedArg[] = invocation.args().map((scVal, index) => ({
    index,
    label: labels[index] ?? `arg_${index}`,
    value: sanitizeNativeValue(scValToNative(scVal)),
  }));

  return {
    method,
    contractId,
    networkPassphrase: tx.networkPassphrase,
    sourceAccount: tx.source,
    args,
  };
}

/**
 * Builds the *expected* intent for a `buy_artwork` call from the exact same
 * inputs `buyArtwork()` (lib/contract.ts) uses to construct its real
 * arguments. Used by the checkout confirmation UI so what the user sees is
 * derived from the identical construction logic used for the on-chain call
 * — not a separately hand-rolled display value.
 */
export function buildExpectedBuyArtworkIntent(
  listingId: number,
  buyerPublicKey: string,
  contractId: string = config.contractId,
  networkPassphrase: string = config.networkPassphrase
): TransactionIntent {
  return {
    method: "buy_artwork",
    contractId,
    networkPassphrase,
    sourceAccount: buyerPublicKey,
    args: [
      { index: 0, label: "buyer", value: buyerPublicKey },
      { index: 1, label: "listing_id", value: String(listingId) },
    ],
  };
}

// ── Comparison ────────────────────────────────────────────────────────────

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

/**
 * Compares two transaction intents field-by-field. Returns every mismatched
 * field path so a diagnostic event can report exactly what differed without
 * needing to include full argument values.
 */
export function intentsMatch(
  expected: TransactionIntent,
  actual: TransactionIntent
): IntentComparison {
  const mismatchedFields: string[] = [];

  if (expected.method !== actual.method) mismatchedFields.push("method");
  if (expected.contractId !== actual.contractId) mismatchedFields.push("contractId");
  if (expected.networkPassphrase !== actual.networkPassphrase) mismatchedFields.push("networkPassphrase");
  if (expected.sourceAccount !== actual.sourceAccount) mismatchedFields.push("sourceAccount");

  if (expected.args.length !== actual.args.length) {
    mismatchedFields.push("args.length");
  } else {
    for (let i = 0; i < expected.args.length; i++) {
      const e = expected.args[i];
      const a = actual.args[i];
      if (stableStringify(e.value) !== stableStringify(a.value)) {
        mismatchedFields.push(`args[${i}].${e.label ?? a.label ?? i}`);
      }
    }
  }

  return { matches: mismatchedFields.length === 0, mismatchedFields };
}

/**
 * Asserts that `expected` and `actual` describe the same transaction.
 * Throws `TxIntentMismatchError` on any mismatch — callers must treat this
 * as fatal and abort signing (never call the wallet adapter after this
 * throws).
 */
export function assertIntentsMatch(
  expected: TransactionIntent,
  actual: TransactionIntent,
  context: string
): void {
  const { matches, mismatchedFields } = intentsMatch(expected, actual);
  if (!matches) {
    throw new TxIntentMismatchError(
      `Transaction verification failed (${context}): the transaction about to be signed does not match ` +
        `what was displayed. For your safety, signing has been stopped before your wallet was asked to sign. ` +
        `Mismatched fields: ${mismatchedFields.join(", ")}.`,
      mismatchedFields
    );
  }
}
