import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

// ── Version negotiation ────────────────────────────────────────────────────────
// Clients may supply `Accept: application/vnd.elcarehub.v1+json` or
// `?version=1`.  When absent we default to the latest stable version.

export type ApiVersion = 1;

const VERSION_HEADER = 'X-API-Version';
const DEPRECATION_HEADER = 'Deprecation';

function parseApiVersion(req: Request): ApiVersion {
  const accept = req.headers.accept || '';
  const match = accept.match(/application\/vnd\.elcarehub\.v(\d+)\+json/);
  if (match) return Number(match[1]) as ApiVersion;

  const q = (req.query.version || req.headers['x-api-version']) as string | undefined;
  if (q) return Number(q) as ApiVersion;

  return 1;
}

export function versioningMiddleware(req: Request, res: Response, next: NextFunction) {
  const version = parseApiVersion(req);
  (req as any).apiVersion = version;
  res.setHeader(VERSION_HEADER, String(version));
  next();
}

// ── Response envelope ─────────────────────────────────────────────────────────
// All versioned responses use a stable envelope:
//   { "data": ..., "meta": { "version": 1, "deprecated": false } }
// Errors continue to use the existing `error` envelope.

export interface ApiEnvelope<T> {
  data: T;
  meta: {
    version: ApiVersion;
    deprecated: boolean;
    sunset?: string;
  };
}

export function ok<T>(res: Response, data: T, opts?: { deprecated?: boolean; sunset?: string }) {
  const body: ApiEnvelope<T> = {
    data,
    meta: {
      version: 1,
      deprecated: opts?.deprecated ?? false,
      sunset: opts?.sunset,
    },
  };
  if (opts?.deprecated) res.setHeader(DEPRECATION_HEADER, 'true');
  if (opts?.sunset) res.setHeader('Sunset', opts.sunset);
  res.json(body);
}

// ── Contract validation ───────────────────────────────────────────────────────
// Runtime schema validation at the API boundary.  Any mismatch is a 500 with
// structured log — never a silent field drop.

export function validateResponse<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.error('[API] Response contract validation failed:', result.error.format());
    throw new Error(`Response contract validation failed: ${result.error.message}`);
  }
  return result.data;
}

// ── V1 schemas ────────────────────────────────────────────────────────────────
// Typed subsets of listing, auction, offer, and collection responses.

export const ListingResponseV1 = z.object({
  listingId: z.string(),
  artist: z.string(),
  owner: z.string().nullable(),
  price: z.string(),
  currency: z.string(),
  collection: z.string().nullable(),
  status: z.string(),
  createdAtLedger: z.number(),
  updatedAtLedger: z.number(),
  // Moderation overlay (Issue #542) — null when no ModerationCase exists for
  // this listing. Never affects the underlying provenance fields above.
  moderationState: z.string().nullable().optional(),
});

export const AuctionResponseV1 = z.object({
  auctionId: z.string(),
  listingId: z.string(),
  reservePrice: z.string(),
  currentBid: z.string().nullable(),
  bidCount: z.number(),
  endsAtLedger: z.number(),
  status: z.string(),
  createdAtLedger: z.number(),
});

export const OfferResponseV1 = z.object({
  offerId: z.string(),
  listingId: z.string(),
  from: z.string(),
  amount: z.string(),
  currency: z.string(),
  status: z.string(),
  createdAtLedger: z.number(),
  // Issue #528: offer expiry + escrow/refund transaction provenance, and
  // groundwork for a future counter-offer relationship (always null today).
  expiresAt: z.string().nullable().optional(),
  escrowTxHash: z.string().nullable().optional(),
  refundTxHash: z.string().nullable().optional(),
  parentOfferId: z.string().nullable().optional(),
});

export const CollectionResponseV1 = z.object({
  contractAddress: z.string(),
  kind: z.string(),
  creator: z.string(),
  feeBpsOverride: z.number().nullable(),
  deployedAtLedger: z.number(),
});

export type ListingV1 = z.infer<typeof ListingResponseV1>;
export type AuctionV1 = z.infer<typeof AuctionResponseV1>;
export type OfferV1 = z.infer<typeof OfferResponseV1>;
export type CollectionV1 = z.infer<typeof CollectionResponseV1>;
