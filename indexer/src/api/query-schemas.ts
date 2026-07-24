import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';
import { badRequest } from './errors.js';
import { isValidStellarAddress, STELLAR_ADDRESS_ERROR } from '../stellar-address.js';

// ── Reusable field schemas ────────────────────────────────────────────────────

/**
 * Coerces a query-string value to a positive integer capped at `max`.
 * Returns 400 when the value is not a non-negative integer or exceeds the cap.
 */
const positiveInt = (max: number) =>
  z.coerce.number().int().nonnegative().max(max);

const optionalString = z.string().optional();

/**
 * Optional Stellar G-address field.
 * Rejects strings that are not exactly 56 base32 characters starting with G.
 * Accepts `undefined` (field not supplied).
 */
const optionalStellarAddress = z
  .string()
  .refine(isValidStellarAddress, { message: STELLAR_ADDRESS_ERROR })
  .optional();

/**
 * Positive decimal string validator.
 * Accepts "0", "100", "1.5000000" etc.
 * Rejects empty strings, negative values, and non-numeric input.
 */
const positiveDecimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'Must be a non-negative decimal number string')
  .optional();

// ── Per-endpoint schemas ──────────────────────────────────────────────────────

export const listingsQuerySchema = z.object({
  // artist: must be a valid Stellar G-address when supplied.
  artist: optionalStellarAddress,
  // owner: Stellar G-address of the current holder.
  owner: optionalStellarAddress,
  // status: enum — only known values accepted.
  status: z.enum(['Active', 'Sold', 'Cancelled', 'Auction']).optional(),
  // search: free-text search; strip leading/trailing whitespace.
  search: z.string().trim().optional(),
  // Price range: positive decimal strings.
  minPrice: positiveDecimalString,
  maxPrice: positiveDecimalString,
  // Pagination: integers in [0, max].
  limit:  positiveInt(100).optional(),   // tightened from 1000 per spec
  offset: positiveInt(10_000).optional(),
});

export const auctionsQuerySchema = z.object({
  creator: optionalStellarAddress,
  status:  z.enum(['Active', 'Finalized', 'Cancelled']).optional(),
});

export const offersQuerySchema = z.object({
  listing_id: z
    .string()
    .regex(/^\d+$/, 'listing_id must be a non-negative integer')
    .optional(),
});

export const walletActivityQuerySchema = z.object({
  // limit: 1–200; default applied in route handler.
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const collectionsQuerySchema = z.object({
  kind:    z.enum(['normal_721', 'normal_1155', 'lazy_721', 'lazy_1155']).optional(),
  creator: optionalStellarAddress,
});

export const statsQuerySchema = z.object({
  range: z.enum(['day', 'week', 'month']).optional(),
  from:  z.string().optional(),
  to:    z.string().optional(),
});

export const syncGapsQuerySchema = z.object({
  status: z.enum(['Open', 'Repairing', 'Repaired', 'Failed']).optional(),
  source: z.enum(['rpc_window_skip', 'reorg', 'manual']).optional(),
  limit:  positiveInt(500).optional(),
  offset: positiveInt(10_000).optional(),
});

export const artistMetricsQuerySchema = z.object({
  range: z.enum(['day', 'week', 'month']).optional(),
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
