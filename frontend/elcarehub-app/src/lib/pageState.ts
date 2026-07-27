// ─────────────────────────────────────────────────────────────
// lib/pageState.ts — Shared page-state contract
//
// Every resource page (listings, auctions, profiles, collections,
// offers, history, admin) goes through the same lifecycle:
//
//   loading → ready | empty | unavailable | unauthorized | not-found
//
// plus an orthogonal `stale` signal that can overlay `ready` (data is
// present but past its freshness threshold — see lib/indexer.ts).
//
// Without a shared contract, each page invents its own copy and
// conflates "the indexer is down" with "there is nothing here," which
// is exactly the failure mode this module exists to prevent: a blank
// page or a generic error must never look identical to a real 404 or
// an empty result set.
// ─────────────────────────────────────────────────────────────

import { isAxiosError } from "axios";
import { getReadableErrorMessage } from "@/lib/errors";

/** The blocking states a resource page can be in. `stale` is intentionally
 * excluded — it is a non-blocking overlay on `ready`, not a replacement for
 * content (see StaleBanner). */
export type PageStateCategory =
  | "loading"
  | "empty"
  | "ready"
  | "unavailable"
  | "unauthorized"
  | "not-found";

/** The subset of categories that originate from a caught error. */
export type PageErrorCategory = Extract<
  PageStateCategory,
  "unavailable" | "unauthorized" | "not-found"
>;

export interface PageStateError {
  category: PageErrorCategory;
  /** User-safe, already-localized-in-tone message. Never render `cause` directly. */
  message: string;
  /** Whether pressing "Try again" is likely to help (network/backend hiccup vs. permanent). */
  retryable: boolean;
  /** Raw error for logging/telemetry only. */
  cause?: unknown;
}

export interface CategorizeOptions {
  /** e.g. "listing", "auction", "collection" — used in default copy. */
  resourceLabel?: string;
  /** Override the default not-found copy. */
  notFoundMessage?: string;
  /** Override the default unauthorized copy. */
  unauthorizedMessage?: string;
}

const NOT_FOUND_PHRASES = [
  "not found",
  "does not exist",
  "no such",
  "unknown listing",
  "unknown auction",
  "unknown offer",
  "unknown collection",
];

const UNAUTHORIZED_PHRASES = [
  "unauthorized",
  "not authorized",
  "wrong network",
  "wallet not connected",
  "requires wallet",
  "forbidden",
  "permission denied",
  "access denied",
];

/**
 * Maps an indexer HTTP error, a Soroban read/simulation error, or any other
 * caught exception into one of the three error-shaped page states. Falls
 * back to `unavailable` (retryable) rather than ever surfacing a raw stack
 * trace or a silently blank page.
 */
export function categorizePageError(
  error: unknown,
  options: CategorizeOptions = {}
): PageStateError {
  const resourceLabel = options.resourceLabel ?? "resource";
  const notFoundMessage =
    options.notFoundMessage ?? `This ${resourceLabel} could not be found. It may have been removed.`;
  const unauthorizedMessage =
    options.unauthorizedMessage ??
    "You don't have permission to view this. Connect the correct wallet and try again.";

  // HTTP-shaped errors from the indexer carry the clearest signal.
  if (isAxiosError(error)) {
    const status = error.response?.status;

    if (status === 404) {
      return { category: "not-found", message: notFoundMessage, retryable: false, cause: error };
    }
    if (status === 401 || status === 403) {
      return { category: "unauthorized", message: unauthorizedMessage, retryable: false, cause: error };
    }
    if (status === 429) {
      return {
        category: "unavailable",
        message: "Too many requests right now. Please wait a moment and try again.",
        retryable: true,
        cause: error,
      };
    }
    if (status && status >= 500) {
      return {
        category: "unavailable",
        message: "The indexer is temporarily unavailable. Your data is safe on-chain — please try again shortly.",
        retryable: true,
        cause: error,
      };
    }
    if (!error.response) {
      return {
        category: "unavailable",
        message: "Could not reach the indexer. Check your connection and try again.",
        retryable: true,
        cause: error,
      };
    }
  }

  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const lower = raw.toLowerCase();

  if (NOT_FOUND_PHRASES.some((p) => lower.includes(p))) {
    return { category: "not-found", message: notFoundMessage, retryable: false, cause: error };
  }
  if (UNAUTHORIZED_PHRASES.some((p) => lower.includes(p))) {
    return { category: "unauthorized", message: unauthorizedMessage, retryable: false, cause: error };
  }

  return {
    category: "unavailable",
    message: getReadableErrorMessage(error, `We couldn't load this ${resourceLabel}. Please try again.`),
    retryable: true,
    cause: error,
  };
}

/** Convenience for deriving the blocking category from loading/data/error inputs. */
export function resolvePageStateCategory(input: {
  isLoading: boolean;
  error: PageStateError | null;
  isEmpty: boolean;
}): PageStateCategory {
  if (input.isLoading) return "loading";
  if (input.error) return input.error.category;
  if (input.isEmpty) return "empty";
  return "ready";
}
