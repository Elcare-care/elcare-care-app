import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';
import { badRequest } from './errors.js';
import { isValidStellarAddress, STELLAR_ADDRESS_ERROR } from '../stellar-address.js';

// ── Reusable field schemas ────────────────────────────────────────────────────

const positiveInt = (max: number) =>
  z.coerce.number().int().nonnegative().max(max);

const optionalString = z.string().optional();

const optionalStellarAddress = z
  .string()
  .refine(isValidStellarAddress, STELLAR_ADDRESS_ERROR)
  .optional();

const optionalIsoDate = z
  .string()
  .refine((v) => !isNaN(Date.parse(v)), 'Must be a valid ISO 8601 date string')
  .optional();

// ── Cursor pagination fields (shared across list endpoints) ───────────────────
//
// cursor_ledger    : ledgerSequence value to paginate from (exclusive boundary).
// cursor_direction : "desc" (default, newest-first) | "asc" (oldest-first).
//
// When cursor_ledger is provided the endpoint uses:
//   DESC → WHERE updatedAtLedger < cursor_ledger  (next older page)
//   ASC  → WHERE updatedAtLedger > cursor_ledger  (next newer page)
//
// Responses include:
//   X-Next-Cursor  : ledgerSequence of the last item returned, or "" when exhausted.
//   X-Total-Count  : total matching rows (independent COUNT query).

const cursorFields = {
  cursor_ledger:    z.coerce.number().int().min(0).optional(),
  cursor_direction: z.enum(['asc', 'desc']).optional().default('desc'),
};

// ── Per-endpoint schemas ──────────────────────────────────────────────────────

export const listingsQuerySchema = z.object({
  artist:   optionalStellarAddress,
  owner:    optionalStellarAddress,
  status:   z.enum(['Active', 'Sold', 'Cancelled', 'Auction']).optional(),
  search:   optionalString,
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().nonnegative().optional(),
  limit:    positiveInt(100).optional(),
  offset:   positiveInt(10_000).optional(),
  ...cursorFields,
}).refine(
  (d) => d.minPrice === undefined || d.maxPrice === undefined || d.minPrice <= d.maxPrice,
  { message: 'minPrice must be ≤ maxPrice', path: ['minPrice'] }
);

export const auctionsQuerySchema = z.object({
  creator: optionalStellarAddress,
  status:  z.enum(['Active', 'Finalized', 'Cancelled']).optional(),
  limit:   positiveInt(100).optional(),
  offset:  positiveInt(10_000).optional(),
  ...cursorFields,
});

export const offersQuerySchema = z.object({
  listing_id: z
    .string()
    .regex(/^\d+$/, 'listing_id must be a non-negative integer')
    .optional(),
  limit:  positiveInt(100).optional(),
  offset: positiveInt(10_000).optional(),
  ...cursorFields,
});

export const walletActivityQuerySchema = z.object({
  limit:  positiveInt(200).optional(),
  offset: positiveInt(10_000).optional(),
  ...cursorFields,
});

export const collectionsQuerySchema = z.object({
  kind:    z.enum(['normal_721', 'normal_1155', 'lazy_721', 'lazy_1155']).optional(),
  creator: optionalStellarAddress,
  limit:   positiveInt(100).optional(),
  offset:  positiveInt(10_000).optional(),
  ...cursorFields,
});

export const creatorCollectionsQuerySchema = z.object({
  limit:  positiveInt(100).optional(),
  offset: positiveInt(10_000).optional(),
  ...cursorFields,
});

export const statsQuerySchema = z.object({
  range: z.enum(['day', 'week', 'month']).optional(),
  from:  optionalIsoDate,
  to:    optionalIsoDate,
}).refine(
  (d) => {
    if (d.from && d.to) return new Date(d.from) <= new Date(d.to);
    return true;
  },
  { message: 'from must be before or equal to to', path: ['from'] }
);

export const syncGapsQuerySchema = z.object({
  status: z.enum(['Open', 'Repairing', 'Repaired', 'Failed']).optional(),
  source: z.enum(['rpc_window_skip', 'reorg', 'manual']).optional(),
  limit:  positiveInt(500).optional(),
  offset: positiveInt(10_000).optional(),
});

export const royaltyBreakdownQuerySchema = z.object({
  /** Inclusive lower ledger-sequence bound. */
  from:   z.coerce.number().int().min(0).optional(),
  /** Inclusive upper ledger-sequence bound. */
  to:     z.coerce.number().int().min(0).optional(),
  limit:  positiveInt(1000).optional(),
  offset: positiveInt(10_000).optional(),
});

export const artistMetricsQuerySchema = z.object({
  range: z.enum(['day', 'week', 'month']).optional(),
});

// ── /search cross-entity query schema ────────────────────────────────────────

export const searchQuerySchema = z.object({
  /** The search term. Required. Minimum 1 character. */
  q: z.string().min(1, 'q must be at least 1 character'),
  /**
   * Which entity types to include.
   * Accepts a comma-separated string or a repeated query param.
   * Defaults to all: listings, auctions, collections.
   */
  types: z
    .union([
      z.string().transform((s) => s.split(',').map((t) => t.trim())),
      z.array(z.string()),
    ])
    .optional()
    .default('listings,auctions,collections')
    .transform((v) =>
      (typeof v === 'string' ? v.split(',').map((t) => t.trim()) : v).filter(Boolean)
    )
    .pipe(
      z.array(z.enum(['listings', 'auctions', 'collections'])).min(1)
    ),
  /** Max results per entity type (1–50). */
  limit: positiveInt(50).optional().default(10),
});

// ── validateQuery middleware factory ─────────────────────────────────────────

/**
 * Returns an Express middleware that validates `req.query` against `schema`.
 *
 * On success, attaches the coerced + validated values to `req.validatedQuery`.
 * On failure, calls `next(badRequest(...))` with all Zod issues joined into
 * a human-readable message — no stack traces are leaked.
 */
export function validateQuery<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const message = result.error.issues
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ');
      return next(badRequest(message));
    }
    (req as any).validatedQuery = result.data;
    next();
  };
}
