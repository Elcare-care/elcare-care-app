import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';
import { badRequest } from './errors.js';

// ── Reusable field schemas ────────────────────────────────────────────────────

const positiveInt = (max: number) =>
  z.coerce
    .number()
    .int()
    .nonnegative()
    .max(max);

const optionalString = z.string().optional();

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
  artist:   optionalString,
  owner:    optionalString,
  status:   optionalString,
  search:   optionalString,
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().nonnegative().optional(),
  limit:    positiveInt(1000).optional(),
  offset:   positiveInt(10_000).optional(),
  ...cursorFields,
});

export const auctionsQuerySchema = z.object({
  creator: optionalString,
  status:  optionalString,
  limit:   positiveInt(1000).optional(),
  offset:  positiveInt(10_000).optional(),
  ...cursorFields,
});

export const offersQuerySchema = z.object({
  listing_id: z
    .string()
    .regex(/^\d+$/, 'listing_id must be a non-negative integer')
    .optional(),
  limit:  positiveInt(1000).optional(),
  offset: positiveInt(10_000).optional(),
  ...cursorFields,
});

export const walletActivityQuerySchema = z.object({
  limit:  positiveInt(200).optional(),
  offset: positiveInt(10_000).optional(),
  ...cursorFields,
});

export const collectionsQuerySchema = z.object({
  kind:    optionalString,
  creator: optionalString,
  limit:   positiveInt(1000).optional(),
  offset:  positiveInt(10_000).optional(),
  ...cursorFields,
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

export function validateQuery<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const message = result.error.issues
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ');
      return next(badRequest(message));
    }
    // Replace raw query with coerced, validated values
    (req as any).validatedQuery = result.data;
    next();
  };
}
