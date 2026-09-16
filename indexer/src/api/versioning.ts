import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

// ── Version negotiation ────────────────────────────────────────────────────────
// Clients may supply `Accept: application/vnd.elcarehub.v2+json`, `Accept: application/vnd.elcarehub.v1+json`,
// or `?version=2`. When absent we default to the latest stable version (2).
export type ApiVersion = 1 | 2;

const VERSION_HEADER = 'X-API-Version';
const DEPRECATION_HEADER = 'Deprecation';

function parseApiVersion(req: Request): ApiVersion {
  const accept = req.headers.accept || '';
  const match = accept.match(/application\/vnd\.elcarehub\.v(\d+)\+json/);
  if (match) {
    const v = Number(match[1]);
    if (v === 1 || v === 2) return v;
  }
  const q = (req.query.version || req.headers['x-api-version']) as string | undefined;
  if (q) {
    const v = Number(q);
    if (v === 1 || v === 2) return v;
  }
  return 1;
}

export function versioningMiddleware(req: Request, res: Response, next: NextFunction) {
  const version = parseApiVersion(req);
  (req as any).apiVersion = version;
  res.setHeader(VERSION_HEADER, String(version));
  if (version === 1) {
    res.setHeader(DEPRECATION_HEADER, '@deprecated Use version 2 for normalized timestamp and metadata envelope');
  }
  next();
}

// ── Response envelope ─────────────────────────────────────────────────────────
export interface ApiEnvelope<T> {
  data: T;
  meta: {
    version: ApiVersion;
    deprecated: boolean;
    sunset?: string;
  };
}

export function envelope<T>(data: T, version: ApiVersion, deprecated = false, sunset?: string): ApiEnvelope<T> {
  return {
    data,
    meta: {
      version,
      deprecated,
      ...(sunset ? { sunset } : {})
    }
  };
}

// ── Schema-First Entity Definitions ───────────────────────────────────────────

// V1 Legacy Listing Schema
export const listingV1Schema = z.object({
  listingId: z.string(),
  artist: z.string(),
  owner: z.string().nullable().optional(),
  price: z.string(),
  priceDecimal: z.string().optional(),
  currency: z.string(),
  collection: z.string().nullable().optional(),
  nftTokenId: z.string(),
  token: z.string(),
  status: z.string(),
  createdAt: z.string(),
  moderationState: z.string().nullable().optional()
}).passthrough();

export type ListingV1 = z.infer<typeof listingV1Schema>;

// V2 Modernized Listing Schema
export const listingV2Schema = z.object({
  id: z.string(),
  sellerAddress: z.string(),
  ownerAddress: z.string().nullable().optional(),
  pricing: z.object({
    amountRaw: z.string(),
    symbol: z.string(),
    decimals: z.number().default(7)
  }),
  tokenStandard: z.string().default('SOROBAN_NFT'),
  assetId: z.string(),
  contractAddress: z.string().nullable().optional(),
  lifecycleStatus: z.string(),
  timestamps: z.object({
    createdIso: z.string(),
    updatedIso: z.string()
  }),
  metadata: z.record(z.unknown()).optional()
}).passthrough();

export type ListingV2 = z.infer<typeof listingV2Schema>;

// ── Bidirectional Migration Adapters ──────────────────────────────────────────

export interface VersionMigrationAdapter<T1, T2> {
  toV2(v1: T1): T2;
  toV1(v2: T2): T1;
}

export const listingMigrationAdapter: VersionMigrationAdapter<ListingV1, ListingV2> = {
  toV2(v1: ListingV1): ListingV2 {
    const clean = listingV1Schema.parse(v1);
    return {
      id: clean.listingId,
      sellerAddress: clean.artist,
      ownerAddress: clean.owner,
      pricing: {
        amountRaw: clean.price,
        symbol: clean.currency,
        decimals: 7
      },
      tokenStandard: 'SOROBAN_NFT',
      assetId: clean.nftTokenId,
      contractAddress: clean.collection,
      lifecycleStatus: clean.status.toUpperCase(),
      timestamps: {
        createdIso: clean.createdAt,
        updatedIso: clean.createdAt
      },
      metadata: clean.moderationState ? { moderationState: clean.moderationState } : undefined
    };
  },

  toV1(v2: ListingV2): ListingV1 {
    const clean = listingV2Schema.parse(v2);
    const decimalDivisor = Math.pow(10, clean.pricing.decimals || 7);
    const decimalPrice = (Number(clean.pricing.amountRaw) / decimalDivisor).toFixed(7);

    return {
      listingId: clean.id,
      artist: clean.sellerAddress,
      owner: clean.ownerAddress || null,
      price: clean.pricing.amountRaw,
      priceDecimal: decimalPrice,
      currency: clean.pricing.symbol,
      collection: clean.contractAddress || null,
      nftTokenId: clean.assetId,
      token: clean.contractAddress || 'NATIVE_XLM',
      status: clean.lifecycleStatus.charAt(0).toUpperCase() + clean.lifecycleStatus.slice(1).toLowerCase(),
      createdAt: clean.timestamps.createdIso,
      moderationState: (clean.metadata?.moderationState as string) || null
    };
  }
};
