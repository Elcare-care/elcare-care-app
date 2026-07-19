/**
 * event-schemas.ts
 *
 * Schema-driven typed event decoder for ELCARE-HUB Marketplace Soroban contracts.
 *
 * Each ContractEventSchema describes the expected structure of a decoded XDR event
 * (after scValToNative has been called). The schema is used to:
 *   1. Validate that all required fields are present and have the correct JS type.
 *   2. Return a strongly-typed event object or a DecodeError when validation fails.
 *
 * JS types after scValToNative:
 *   Soroban u64 / i128  → BigInt
 *   Soroban Address     → string
 *   Soroban Symbol      → string
 *   Soroban bool        → boolean
 *   Soroban Option<T>   → T | null | undefined
 */

// ── Field descriptor ──────────────────────────────────────────────────────────

export type XdrJsType = 'bigint' | 'string' | 'boolean' | 'number' | 'array' | 'object';

export interface SchemaField {
  /** Field name in the decoded native object */
  name: string;
  /** Expected JavaScript type after scValToNative */
  type: XdrJsType;
  /** When true the field may be absent or null/undefined without triggering a DecodeError */
  optional?: boolean;
}

export interface ContractEventSchema {
  /** Human-readable event type identifier (mirrors TOPIC_MAP values) */
  type: string;
  /** Expected fields on the decoded native data value */
  data: SchemaField[];
}

// ── Typed event payloads ──────────────────────────────────────────────────────

export interface ListingCreatedData {
  listing_id: bigint;
  artist: string;
  price: bigint;
  currency: string;
  collection: string;
  token_id: bigint;
  ledger_sequence?: bigint;
  recipients?: Array<{ address: string; percentage: bigint }>;
  token?: string;
}

export interface ArtworkSoldData {
  listing_id: bigint;
  artist?: string;
  buyer: string;
  price: bigint;
  currency?: string;
  ledger_sequence?: bigint;
}

export interface ListingCancelledData {
  listing_id: bigint;
  cancelled_by?: string;
  reason?: string | object;
  ledger_sequence?: bigint;
}

export interface ListingUpdatedData {
  listing_id: bigint;
  artist?: string;
  new_price: bigint;
  collection?: string;
  token_id?: bigint;
  ledger_sequence?: bigint;
}

export interface AuctionCreatedData {
  auction_id: bigint;
  creator: string;
  reserve_price: bigint;
  token: string;
  collection: string;
  token_id: bigint;
  end_time: bigint;
}

export interface BidPlacedData {
  auction_id: bigint;
  bidder: string;
  bid_amount: bigint;
}

export interface AuctionFinalizedData {
  auction_id: bigint;
  winner?: string | null;
  amount: bigint;
}

export interface AuctionCancelledData {
  auction_id: bigint;
  cancelled_by?: string;
}

export interface AuctionExtendedData {
  auction_id: bigint;
  new_end_time: bigint;
}

export interface OfferMadeData {
  offer_id: bigint;
  listing_id: bigint;
  offerer: string;
  amount: bigint;
  token: string;
}

export interface OfferAcceptedData {
  offer_id: bigint;
  listing_id: bigint;
  offerer: string;
  amount?: bigint;
}

export interface OfferRejectedData {
  offer_id: bigint;
  listing_id: bigint;
  offerer: string;
}

export interface OfferWithdrawnData {
  offer_id: bigint;
  listing_id: bigint;
  offerer: string;
}

export interface OfferReclaimedData {
  offer_id: bigint;
  listing_id: bigint;
  offerer: string;
  amount: bigint;
}

export interface ListingPriceUpdatedData {
  listing_id: bigint;
  old_price: bigint;
  new_price: bigint;
  updated_by: string;
}

export interface ListingExpiredData {
  listing_id: bigint;
  expired_at: bigint;
  ledger_sequence?: bigint;
}

export interface ProtocolFeeCollectedData {
  listing_id: bigint;
  amount: bigint;
  token: string;
  treasury: string;
}

export interface RoyaltyPaidData {
  listing_id?: bigint;
  recipient: string;
  amount: bigint;
}

export interface ArtistRevokedData {
  artist: string;
}

export interface ArtistReinstatedData {
  artist: string;
}

export interface AdminTransferProposedData {
  current_admin: string;
  proposed_admin: string;
}

export interface AdminTransferredData {
  old_admin: string;
  new_admin: string;
}

export interface ContractPausedData {
  paused_by?: string;
}

export interface ContractUnpausedData {
  unpaused_by?: string;
}

/** Deploy events emit a 2-tuple [creator_address, contract_address] */
export interface DeployData {
  0: string;
  1: string;
}

// ── Decode result types ───────────────────────────────────────────────────────

export interface TypedEvent<T> {
  ok: true;
  eventType: string;
  data: T;
}

export interface DecodeError {
  ok: false;
  eventType: string;
  reason: string;
  /** The raw native value that failed to decode */
  raw: unknown;
}

export type DecodeResult<T> = TypedEvent<T> | DecodeError;

// ── Schemas ───────────────────────────────────────────────────────────────────

export const LISTING_CREATED_SCHEMA: ContractEventSchema = {
  type: 'LISTING_CREATED',
  data: [
    { name: 'listing_id', type: 'bigint' },
    { name: 'artist', type: 'string' },
    { name: 'price', type: 'bigint' },
    { name: 'currency', type: 'string' },
    { name: 'collection', type: 'string' },
    { name: 'token_id', type: 'bigint' },
    { name: 'ledger_sequence', type: 'bigint', optional: true },
    { name: 'token', type: 'string', optional: true },
    { name: 'recipients', type: 'array', optional: true },
  ],
};

export const ARTWORK_SOLD_SCHEMA: ContractEventSchema = {
  type: 'ARTWORK_SOLD',
  data: [
    { name: 'listing_id', type: 'bigint' },
    { name: 'buyer', type: 'string' },
    { name: 'price', type: 'bigint' },
    { name: 'artist', type: 'string', optional: true },
    { name: 'currency', type: 'string', optional: true },
    { name: 'ledger_sequence', type: 'bigint', optional: true },
  ],
};

export const LISTING_CANCELLED_SCHEMA: ContractEventSchema = {
  type: 'LISTING_CANCELLED',
  data: [
    { name: 'listing_id', type: 'bigint' },
    { name: 'cancelled_by', type: 'string', optional: true },
    { name: 'reason', type: 'string', optional: true },
    { name: 'ledger_sequence', type: 'bigint', optional: true },
  ],
};

export const LISTING_UPDATED_SCHEMA: ContractEventSchema = {
  type: 'LISTING_UPDATED',
  data: [
    { name: 'listing_id', type: 'bigint' },
    { name: 'new_price', type: 'bigint' },
    { name: 'artist', type: 'string', optional: true },
    { name: 'collection', type: 'string', optional: true },
    { name: 'token_id', type: 'bigint', optional: true },
    { name: 'ledger_sequence', type: 'bigint', optional: true },
  ],
};

export const LISTING_PRICE_UPDATED_SCHEMA: ContractEventSchema = {
  type: 'LISTING_PRICE_UPDATED',
  data: [
    { name: 'listing_id', type: 'bigint' },
    { name: 'old_price', type: 'bigint' },
    { name: 'new_price', type: 'bigint' },
    { name: 'updated_by', type: 'string' },
  ],
};

export const LISTING_EXPIRED_SCHEMA: ContractEventSchema = {
  type: 'LISTING_EXPIRED',
  data: [
    { name: 'listing_id', type: 'bigint' },
    { name: 'expired_at', type: 'bigint' },
    { name: 'ledger_sequence', type: 'bigint', optional: true },
  ],
};

export const AUCTION_CREATED_SCHEMA: ContractEventSchema = {
  type: 'AUCTION_CREATED',
  data: [
    { name: 'auction_id', type: 'bigint' },
    { name: 'creator', type: 'string' },
    { name: 'reserve_price', type: 'bigint' },
    { name: 'token', type: 'string' },
    { name: 'collection', type: 'string' },
    { name: 'token_id', type: 'bigint' },
    { name: 'end_time', type: 'bigint' },
  ],
};

export const BID_PLACED_SCHEMA: ContractEventSchema = {
  type: 'BID_PLACED',
  data: [
    { name: 'auction_id', type: 'bigint' },
    { name: 'bidder', type: 'string' },
    { name: 'bid_amount', type: 'bigint' },
  ],
};

export const AUCTION_RESOLVED_SCHEMA: ContractEventSchema = {
  type: 'AUCTION_RESOLVED',
  data: [
    { name: 'auction_id', type: 'bigint' },
    { name: 'amount', type: 'bigint' },
    // winner is Option<Address> — null when no bids were placed
    { name: 'winner', type: 'string', optional: true },
  ],
};

export const AUCTION_CANCELLED_SCHEMA: ContractEventSchema = {
  type: 'AUCTION_CANCELLED',
  data: [
    { name: 'auction_id', type: 'bigint' },
    { name: 'cancelled_by', type: 'string', optional: true },
  ],
};

export const AUCTION_EXTENDED_SCHEMA: ContractEventSchema = {
  type: 'AUCTION_EXTENDED',
  data: [
    { name: 'auction_id', type: 'bigint' },
    { name: 'new_end_time', type: 'bigint' },
  ],
};

export const OFFER_MADE_SCHEMA: ContractEventSchema = {
  type: 'OFFER_MADE',
  data: [
    { name: 'offer_id', type: 'bigint' },
    { name: 'listing_id', type: 'bigint' },
    { name: 'offerer', type: 'string' },
    { name: 'amount', type: 'bigint' },
    { name: 'token', type: 'string' },
  ],
};

export const OFFER_ACCEPTED_SCHEMA: ContractEventSchema = {
  type: 'OFFER_ACCEPTED',
  data: [
    { name: 'offer_id', type: 'bigint' },
    { name: 'listing_id', type: 'bigint' },
    { name: 'offerer', type: 'string' },
    { name: 'amount', type: 'bigint', optional: true },
  ],
};

export const OFFER_REJECTED_SCHEMA: ContractEventSchema = {
  type: 'OFFER_REJECTED',
  data: [
    { name: 'offer_id', type: 'bigint' },
    { name: 'listing_id', type: 'bigint' },
    { name: 'offerer', type: 'string' },
  ],
};

export const OFFER_WITHDRAWN_SCHEMA: ContractEventSchema = {
  type: 'OFFER_WITHDRAWN',
  data: [
    { name: 'offer_id', type: 'bigint' },
    { name: 'listing_id', type: 'bigint' },
    { name: 'offerer', type: 'string' },
  ],
};

export const OFFER_RECLAIMED_SCHEMA: ContractEventSchema = {
  type: 'OFFER_RECLAIMED',
  data: [
    { name: 'offer_id', type: 'bigint' },
    { name: 'listing_id', type: 'bigint' },
    { name: 'offerer', type: 'string' },
    { name: 'amount', type: 'bigint' },
  ],
};

export const ROYALTY_PAID_SCHEMA: ContractEventSchema = {
  type: 'ROYALTY_PAID',
  data: [
    { name: 'recipient', type: 'string' },
    { name: 'amount', type: 'bigint' },
    { name: 'listing_id', type: 'bigint', optional: true },
  ],
};

export const PROTOCOL_FEE_COLLECTED_SCHEMA: ContractEventSchema = {
  type: 'PROTOCOL_FEE_COLLECTED',
  data: [
    { name: 'listing_id', type: 'bigint' },
    { name: 'amount', type: 'bigint' },
    { name: 'token', type: 'string' },
    { name: 'treasury', type: 'string' },
  ],
};

export const ARTIST_REVOKED_SCHEMA: ContractEventSchema = {
  type: 'ARTIST_REVOKED',
  data: [{ name: 'artist', type: 'string' }],
};

export const ARTIST_REINSTATED_SCHEMA: ContractEventSchema = {
  type: 'ARTIST_REINSTATED',
  data: [{ name: 'artist', type: 'string' }],
};

export const ADMIN_TRANSFER_PROPOSED_SCHEMA: ContractEventSchema = {
  type: 'ADMIN_TRANSFER_PROPOSED',
  data: [
    { name: 'current_admin', type: 'string' },
    { name: 'proposed_admin', type: 'string' },
  ],
};

export const ADMIN_TRANSFERRED_SCHEMA: ContractEventSchema = {
  type: 'ADMIN_TRANSFERRED',
  data: [
    { name: 'old_admin', type: 'string' },
    { name: 'new_admin', type: 'string' },
  ],
};

export const CONTRACT_PAUSED_SCHEMA: ContractEventSchema = {
  type: 'CONTRACT_PAUSED',
  data: [{ name: 'paused_by', type: 'string', optional: true }],
};

export const CONTRACT_UNPAUSED_SCHEMA: ContractEventSchema = {
  type: 'CONTRACT_UNPAUSED',
  data: [{ name: 'unpaused_by', type: 'string', optional: true }],
};

/**
 * Deploy events from the launchpad contract emit a 2-element tuple
 * [creator_address, deployed_contract_address].  scValToNative returns a plain
 * JS array; we validate by index rather than by field name.
 */
export const DEPLOY_SCHEMA: ContractEventSchema = {
  type: 'DEPLOY', // base — actual type is DEPLOY_NORMAL_721 etc., set by caller
  data: [
    // Positional tuple: index 0 = creator, index 1 = contract address
    // These are validated structurally in decodeWithSchema; array items don't carry names.
  ],
};

// ── Schema registry ───────────────────────────────────────────────────────────

export const SCHEMA_REGISTRY: Map<string, ContractEventSchema> = new Map([
  ['LISTING_CREATED', LISTING_CREATED_SCHEMA],
  ['ARTWORK_SOLD', ARTWORK_SOLD_SCHEMA],
  ['LISTING_CANCELLED', LISTING_CANCELLED_SCHEMA],
  ['LISTING_UPDATED', LISTING_UPDATED_SCHEMA],
  ['LISTING_PRICE_UPDATED', LISTING_PRICE_UPDATED_SCHEMA],
  ['LISTING_EXPIRED', LISTING_EXPIRED_SCHEMA],
  ['AUCTION_CREATED', AUCTION_CREATED_SCHEMA],
  ['BID_PLACED', BID_PLACED_SCHEMA],
  ['AUCTION_RESOLVED', AUCTION_RESOLVED_SCHEMA],
  ['AUCTION_CANCELLED', AUCTION_CANCELLED_SCHEMA],
  ['AUCTION_EXTENDED', AUCTION_EXTENDED_SCHEMA],
  ['OFFER_MADE', OFFER_MADE_SCHEMA],
  ['OFFER_ACCEPTED', OFFER_ACCEPTED_SCHEMA],
  ['OFFER_REJECTED', OFFER_REJECTED_SCHEMA],
  ['OFFER_WITHDRAWN', OFFER_WITHDRAWN_SCHEMA],
  ['OFFER_RECLAIMED', OFFER_RECLAIMED_SCHEMA],
  ['ROYALTY_PAID', ROYALTY_PAID_SCHEMA],
  ['PROTOCOL_FEE_COLLECTED', PROTOCOL_FEE_COLLECTED_SCHEMA],
  ['ARTIST_REVOKED', ARTIST_REVOKED_SCHEMA],
  ['ARTIST_REINSTATED', ARTIST_REINSTATED_SCHEMA],
  ['ADMIN_TRANSFER_PROPOSED', ADMIN_TRANSFER_PROPOSED_SCHEMA],
  ['ADMIN_TRANSFERRED', ADMIN_TRANSFERRED_SCHEMA],
  ['CONTRACT_PAUSED', CONTRACT_PAUSED_SCHEMA],
  ['CONTRACT_UNPAUSED', CONTRACT_UNPAUSED_SCHEMA],
  // Deploy events share a common tuple structure; each variant is registered separately.
  ['DEPLOY_NORMAL_721', DEPLOY_SCHEMA],
  ['DEPLOY_NORMAL_1155', DEPLOY_SCHEMA],
  ['DEPLOY_LAZY_721', DEPLOY_SCHEMA],
  ['DEPLOY_LAZY_1155', DEPLOY_SCHEMA],
]);

// ── Schema-driven decoder ─────────────────────────────────────────────────────

/**
 * Validates `nativeData` against the fields declared in `schema`.
 *
 * For regular (object) events, every required field must be present with the
 * declared JS type.  Optional fields are only type-checked when present.
 *
 * For deploy events (DEPLOY_* types), the native data is a 2-element array;
 * both elements must be strings.
 *
 * Returns `{ ok: true, data }` on success, or `{ ok: false, reason }` on any
 * structural mismatch.
 */
export function decodeWithSchema<T = unknown>(
  eventType: string,
  schema: ContractEventSchema,
  nativeData: unknown
): DecodeResult<T> {
  // ── Deploy tuple path ─────────────────────────────────────────────────────
  if (
    eventType === 'DEPLOY_NORMAL_721' ||
    eventType === 'DEPLOY_NORMAL_1155' ||
    eventType === 'DEPLOY_LAZY_721' ||
    eventType === 'DEPLOY_LAZY_1155'
  ) {
    if (!Array.isArray(nativeData)) {
      return {
        ok: false,
        eventType,
        reason: `Deploy event data must be an array, got ${typeof nativeData}`,
        raw: nativeData,
      };
    }
    if (nativeData.length < 2) {
      return {
        ok: false,
        eventType,
        reason: `Deploy event tuple requires at least 2 elements, got ${nativeData.length}`,
        raw: nativeData,
      };
    }
    if (typeof nativeData[0] !== 'string' || typeof nativeData[1] !== 'string') {
      return {
        ok: false,
        eventType,
        reason: `Deploy event tuple elements must be strings, got [${typeof nativeData[0]}, ${typeof nativeData[1]}]`,
        raw: nativeData,
      };
    }
    return { ok: true, eventType, data: nativeData as T };
  }

  // ── Object path ───────────────────────────────────────────────────────────
  if (nativeData === null || typeof nativeData !== 'object' || Array.isArray(nativeData)) {
    return {
      ok: false,
      eventType,
      reason: `Event data must be a plain object, got ${Array.isArray(nativeData) ? 'array' : String(nativeData === null ? 'null' : typeof nativeData)}`,
      raw: nativeData,
    };
  }

  const obj = nativeData as Record<string, unknown>;

  for (const field of schema.data) {
    const value = obj[field.name];
    const isAbsent = value === undefined || value === null;

    if (isAbsent) {
      if (!field.optional) {
        return {
          ok: false,
          eventType,
          reason: `Missing required field '${field.name}'`,
          raw: nativeData,
        };
      }
      // Optional and absent — skip type check
      continue;
    }

    // Validate type for present fields
    const actualType = typeof value;

    if (field.type === 'array') {
      if (!Array.isArray(value)) {
        return {
          ok: false,
          eventType,
          reason: `Field '${field.name}' must be an array, got ${actualType}`,
          raw: nativeData,
        };
      }
    } else if (field.type !== actualType) {
      return {
        ok: false,
        eventType,
        reason: `Field '${field.name}' must be ${field.type}, got ${actualType} (value: ${String(value)})`,
        raw: nativeData,
      };
    }
  }

  return { ok: true, eventType, data: nativeData as T };
}
