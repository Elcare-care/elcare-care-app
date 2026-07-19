import { xdr, scValToNative } from '@stellar/stellar-sdk';
import { SCHEMA_REGISTRY, decodeWithSchema, type DecodeResult } from './event-schemas.js';

export interface DecodedEvent {
  eventType: string;
  listingId: bigint | null;
  actor: string;
  ledgerSequence: number;
  data: any;
}

/** Re-exported for callers that want to inspect decode failures directly. */
export type { DecodeResult };

// Map contract symbols to human-readable types
const TOPIC_MAP: Record<string, string> = {
  'lst_crtd':  'LISTING_CREATED',
  'art_sold':  'ARTWORK_SOLD',
  'lst_cncl':  'LISTING_CANCELLED',
  'lst_updt':  'LISTING_UPDATED',
  'lst_pru':   'LISTING_PRICE_UPDATED',
  'lst_expd':  'LISTING_EXPIRED',
  'bid_plcd':  'BID_PLACED',
  'auc_rslv':  'AUCTION_RESOLVED',
  'auc_cncl':  'AUCTION_CANCELLED',
  'auc_crtd':  'AUCTION_CREATED',
  'auc_ext':   'AUCTION_EXTENDED',
  'ofr_made':  'OFFER_MADE',
  'ofr_accp':  'OFFER_ACCEPTED',
  'ofr_rjct':  'OFFER_REJECTED',
  'ofr_wdrn':  'OFFER_WITHDRAWN',
  'ofr_rclm':  'OFFER_RECLAIMED',
  'roy_paid':  'ROYALTY_PAID',
  'fee_cltd':  'PROTOCOL_FEE_COLLECTED',
  'art_rvkd':  'ARTIST_REVOKED',
  'art_rnst':  'ARTIST_REINSTATED',
  'adm_prop':  'ADMIN_TRANSFER_PROPOSED',
  'adm_xfrd':  'ADMIN_TRANSFERRED',
  'ctr_psd':   'CONTRACT_PAUSED',
  'ctr_unpsd': 'CONTRACT_UNPAUSED',
  // Launchpad deploy events (topics[0] = "deploy", topics[1] = kind tag)
  'dep_n721':  'DEPLOY_NORMAL_721',
  'dep_n1155': 'DEPLOY_NORMAL_1155',
  'dep_l721':  'DEPLOY_LAZY_721',
  'dep_l1155': 'DEPLOY_LAZY_1155',
};

/**
 * Decode a single raw topic XDR string to its native symbol string.
 * Falls back to the raw string value when XDR parsing throws.
 */
function decodeTopic(raw: string): string {
  try {
    const scVal = xdr.ScVal.fromXDR(raw, 'base64');
    return scValToNative(scVal) as string;
  } catch {
    return raw;
  }
}

/**
 * Resolve the human-readable event type from the topics array.
 *
 * Marketplace contract: topics = [kind_symbol]
 * Launchpad contract:   topics = ["deploy", kind_tag_symbol]
 *
 * Returns null when the topic does not map to any known event type.
 */
function resolveEventType(topics: string[]): string | null {
  if (topics.length === 0) return null;

  const first = decodeTopic(topics[0]);

  // Launchpad deploy events use a 2-topic layout: ("deploy", tag)
  if (first === 'deploy' && topics.length >= 2) {
    const tag = decodeTopic(topics[1]);
    return TOPIC_MAP[tag] ?? null;
  }

  return TOPIC_MAP[first] ?? null;
}

export function parseMarketplaceEvent(
  topics: string[],
  valueXdr: string,
  ledger: number
): DecodedEvent | null {
  const type = resolveEventType(topics);
  if (!type) return null;

  const rawVal = xdr.ScVal.fromXDR(valueXdr, 'base64');
  const nativeData = scValToNative(rawVal);

  // ── Schema-driven validation ──────────────────────────────────────────────
  const schema = SCHEMA_REGISTRY.get(type);
  if (schema) {
    const result = decodeWithSchema(type, schema, nativeData);
    if (!result.ok) {
      // Surface as a SchemaDecodeError so event-sync.ts can classify it with
      // the per-event-type Prometheus label before skipping this event.
      throw new SchemaDecodeError(type, result.reason, result.raw);
    }
  }

  // ── Shared field extraction ───────────────────────────────────────────────
  const obj = nativeData as Record<string, unknown>;

  let listingId: bigint | null = null;
  if (obj.listing_id !== undefined && obj.listing_id !== null) {
    listingId = BigInt(obj.listing_id as bigint | number | string);
  } else if (obj.auction_id !== undefined && obj.auction_id !== null) {
    listingId = BigInt(obj.auction_id as bigint | number | string);
  }

  let actor = '';
  if (obj.artist)   actor = String(obj.artist);
  else if (obj.creator)  actor = String(obj.creator);
  else if (obj.offerer)  actor = String(obj.offerer);
  else if (obj.bidder)   actor = String(obj.bidder);
  else if (obj.buyer)    actor = String(obj.buyer);

  // For deploy events the value is a 2-tuple [creator, contract_address]
  if (
    type === 'DEPLOY_NORMAL_721' ||
    type === 'DEPLOY_NORMAL_1155' ||
    type === 'DEPLOY_LAZY_721' ||
    type === 'DEPLOY_LAZY_1155'
  ) {
    if (Array.isArray(nativeData) && nativeData.length >= 2) {
      actor = String(nativeData[0]);
    }
    return {
      eventType: type,
      listingId: null,
      actor,
      ledgerSequence: ledger,
      data: convertBigInts(nativeData),
    };
  }

  return {
    eventType: type,
    listingId,
    actor,
    ledgerSequence: ledger,
    data: convertBigInts(nativeData),
  };
}

// ── SchemaDecodeError ─────────────────────────────────────────────────────────

/**
 * Thrown by parseMarketplaceEvent when a decoded event fails schema validation.
 * event-sync.ts catches this to increment the per-event-type Prometheus counter
 * and continue processing without crashing the batch.
 */
export class SchemaDecodeError extends Error {
  constructor(
    public readonly eventType: string,
    public readonly reason: string,
    public readonly raw: unknown
  ) {
    super(`[SchemaDecodeError] ${eventType}: ${reason}`);
    this.name = 'SchemaDecodeError';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Recursively converts BigInt values to strings so the data payload is safe
 * for JSON storage (Prisma Json column).
 */
function convertBigInts(obj: unknown): unknown {
  if (typeof obj === 'bigint') return obj.toString();
  if (Array.isArray(obj)) return obj.map(convertBigInts);
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, convertBigInts(v)])
    );
  }
  return obj;
}
