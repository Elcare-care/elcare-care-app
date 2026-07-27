// ─────────────────────────────────────────────────────────────
// lib/contractErrors/decodeContractError.ts
//
// Single entry point for turning a caught Soroban simulation/submission
// error, a wallet signing error, or a plain network failure into one
// normalized shape the UI can render consistently. Every marketplace,
// launchpad, and NFT client error should flow through here instead of
// components hand-rolling their own `.message.includes(...)` checks.
// ─────────────────────────────────────────────────────────────

import { isAxiosError } from "axios";
import { isUserRejectionError, getReadableErrorMessage } from "@/lib/errors";
import {
  CONTRACT_ERROR_CATALOG,
  ContractName,
  ClientErrorAction,
  getContractErrorDefinition,
  findContractErrorDefinition,
} from "./catalog";

export type ClientErrorKind =
  /** Decoded Soroban contract error with a catalog entry — the common case. */
  | "contract"
  /** Looks like `Error(Contract, #N)` but N isn't in our catalog yet — a new
   * contract error was shipped without a client mapping. Never silently
   * swallowed: surfaced distinctly so it gets reported instead of showing a
   * blank/generic failure. */
  | "unknown_contract"
  /** Wallet-side: user declined signing, or the wallet rejected the request. */
  | "auth"
  /** Simulation exceeded CPU/memory/footprint budget. */
  | "resource_limit"
  /** RPC/indexer unreachable, timed out, or a raw network failure. */
  | "network"
  /** Anything else — falls back to best-effort readable text. */
  | "unknown";

export interface DecodedClientError {
  kind: ClientErrorKind;
  message: string;
  retryable: boolean;
  action: ClientErrorAction;
  contract?: ContractName;
  code?: number;
  /** Raw error for logging/telemetry only — never render directly. */
  cause: unknown;
}

const CONTRACT_CODE_PATTERNS: RegExp[] = [
  /Error\(Contract,\s*#(\d+)\)/i,
  /Contract(?:Error)?[^\d#]*(?:#|code[:=\s])\s*(\d+)/i,
  /"contractCode"\s*:\s*(\d+)/i,
];

function extractContractCode(raw: string): number | null {
  for (const pattern of CONTRACT_CODE_PATTERNS) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

const RESOURCE_LIMIT_PATTERNS: RegExp[] = [
  /exceed(?:ed|s)?\s+(?:the\s+)?(?:cpu|memory|resource)/i,
  /resource limit exceeded/i,
  /footprint/i,
  /instructions? limit/i,
];

const NETWORK_PATTERNS: RegExp[] = [
  /network ?error/i,
  /failed to fetch/i,
  /timeout/i,
  /econnrefused/i,
  /getaddrinfo/i,
  /rpc (?:call )?failed/i,
  /could not (?:reach|connect)/i,
];

function rawMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error ?? {});
  } catch {
    return "";
  }
}

/**
 * Decodes any caught error from a marketplace/launchpad/NFT contract call
 * into a normalized, user-safe shape.
 *
 * @param error - The caught exception (simulation failure, submission
 *   failure, wallet error, or network error).
 * @param contract - Pass the contract that was called when known (most
 *   callers do) so cross-contract error-code collisions can't produce the
 *   wrong mapping. Omit only for call sites that genuinely don't know which
 *   contract raised the error.
 */
export function decodeContractError(
  error: unknown,
  contract?: ContractName
): DecodedClientError {
  if (isUserRejectionError(error)) {
    return {
      kind: "auth",
      message: "You declined the signature request in your wallet.",
      retryable: true,
      action: "retry",
      contract,
      cause: error,
    };
  }

  const raw = rawMessageOf(error);
  const code = extractContractCode(raw);

  if (code !== null) {
    const found = contract
      ? getContractErrorDefinition(contract, code)
      : findContractErrorDefinition(code)?.definition;
    const resolvedContract = contract ?? findContractErrorDefinition(code)?.contract;

    if (found) {
      return {
        kind: "contract",
        message: `${found.message} (code ${code})`,
        retryable: found.retryable,
        action: found.action,
        contract: resolvedContract,
        code,
        cause: error,
      };
    }

    // A Soroban contract error shape, but this exact code has no client
    // mapping — most likely a new error variant shipped without updating
    // this catalog. Distinct from "unknown" so callers/telemetry can tell
    // "we don't understand contracts" apart from "we understand contracts
    // but this one is new."
    return {
      kind: "unknown_contract",
      message:
        "The contract rejected this request in a way we don't recognize yet. Please try again, and contact support if this keeps happening.",
      retryable: false,
      action: "contact_support",
      contract: resolvedContract,
      code,
      cause: error,
    };
  }

  if (RESOURCE_LIMIT_PATTERNS.some((p) => p.test(raw))) {
    return {
      kind: "resource_limit",
      message:
        "This transaction is too complex to simulate right now. Try a smaller batch or fewer recipients.",
      retryable: true,
      action: "adjust_input",
      contract,
      cause: error,
    };
  }

  if (isAxiosError(error) || NETWORK_PATTERNS.some((p) => p.test(raw))) {
    return {
      kind: "network",
      message: "Could not reach the Stellar network. Check your connection and try again.",
      retryable: true,
      action: "retry",
      contract,
      cause: error,
    };
  }

  return {
    kind: "unknown",
    message: getReadableErrorMessage(error, "Something went wrong. Please try again."),
    retryable: true,
    action: "contact_support",
    contract,
    cause: error,
  };
}

/** Every contract name in the catalog, for iterating in tests/validation. */
export const ALL_CONTRACT_NAMES = Object.keys(CONTRACT_ERROR_CATALOG) as ContractName[];
