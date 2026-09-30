// ─────────────────────────────────────────────────────────────
// lib/contractErrors/__fixtures__/errorFixtures.ts
//
// Representative payloads shaped like what Freighter/LOBSTR/Magic and the
// Soroban RPC actually throw, grouped by failure class. Used by
// decodeContractError.test.ts and available to any component test that
// wants to simulate a specific on-chain failure without hand-rolling a
// one-off error string.
// ─────────────────────────────────────────────────────────────

import { ContractName } from "../catalog";

/** A Soroban simulation failure shaped like the real `sorobanClient` throw. */
export function simulationErrorFixture(code: number): Error {
  return new Error(
    `Error(Contract, #${code})\nsimulation failed: HostError: Error(Contract, #${code})`
  );
}

/** A submission (post-signing, on-ledger) failure — same code shape, different envelope text. */
export function submissionErrorFixture(code: number): Error {
  return new Error(
    `transaction submission failed: Error(Contract, #${code})`
  );
}

/** One simulation-shaped fixture per contract, covering a real named error. */
export const SIMULATION_FIXTURES: Record<ContractName, { code: number; name: string; error: Error }> = {
  marketplace: { code: 4, name: "ListingNotActive", error: simulationErrorFixture(4) },
  launchpad: { code: 10, name: "DuplicateSalt", error: simulationErrorFixture(10) },
  collection_nft_erc721: { code: 9, name: "MetadataFrozen", error: simulationErrorFixture(9) },
  collection_nft_erc1155: { code: 8, name: "WalletLimitReached", error: simulationErrorFixture(8) },
  lazy_mint_erc721: { code: 11, name: "NotAllowlisted", error: simulationErrorFixture(11) },
  lazy_mint_erc1155: { code: 15, name: "InvalidMerkleProof", error: simulationErrorFixture(15) },
};

/** A code with a valid `Error(Contract, #N)` shape but not present in any catalog —
 * simulates a new contract error shipped before the client mapping was updated. */
export const UNKNOWN_CONTRACT_CODE_FIXTURE = simulationErrorFixture(9999);

/** Wallet/authorization failures — phrases lifted from real Freighter/LOBSTR rejections. */
export const AUTH_FIXTURES: Error[] = [
  new Error("User rejected the request."),
  new Error("The user declined access, request rejected."),
  new Error("Transaction was rejected by the user."),
];

/** Soroban preflight/simulation resource-budget failures. */
export const RESOURCE_LIMIT_FIXTURES: Error[] = [
  new Error("simulation error: transaction resources exceed resource limits"),
  new Error("Instructions limit exceeded during contract call"),
  new Error("read/write footprint exceeds the allowed ledger entry count"),
];

/** RPC/indexer network-shaped failures. */
export const NETWORK_FIXTURES: Error[] = [
  new Error("Network Error"),
  new Error("Failed to fetch"),
  new Error("timeout of 12000ms exceeded"),
  new Error("getaddrinfo ENOTFOUND rpc.example.com"),
];

/** Not a Soroban error, not auth/network/resource-shaped — must fall back safely. */
export const UNKNOWN_FIXTURE = new Error("Unexpected condition in signer plugin");
