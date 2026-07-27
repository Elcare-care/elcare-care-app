import { xdr, Address, scValToNative } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { SCHEMA_REGISTRY, decodeWithSchema, type DecodeResult } from './event-schemas.js';

export interface DecodedEvent {
  eventType: string;
  listingId: bigint | null;
  actor: string;
  ledgerSequence: number;
  data: any;
  // Idempotency fields — populated by event-sync, used as upsert key
  eventHash: string;
  contractId: string;
  txHash: string;
  eventIndex: number;
  // Globally unique RPC event id; falls back to eventHash when the RPC omits it
  eventId: string;
  // Transaction application order within the ledger — with eventIndex this
  // gives a total intra-ledger order: (ledgerSequence, txIndex, eventIndex)
  txIndex: number;
}

/**
 * Computes a globally unique, stable identity for an on-chain event.
 * SHA256(contractId + ledgerSequence + txHash + eventIndex)
 */
export function computeEventHash(
  contractId: string,
  ledgerSequence: number,
  txHash: string,
  eventIndex: number
): string {
  return createHash('sha256')
    .update(`${contractId}:${ledgerSequence}:${txHash}:${eventIndex}`)
    .digest('hex');
}

// Map contract symbols to human-readable types.
// Covers all 24 symbols in contracts/soroban-marketplace/src/events.rs plus
// the 4 launchpad deploy symbols.
const TOPIC_MAP: Record<string, string> = {
  'listing_created':  'LISTING_CREATED',
  'artwork_sold':  'ARTWORK_SOLD',
  'listing_cancelled':  'LISTING_CANCELLED',
  'listing_updated':  'LISTING_UPDATED',
  'listing_price_updated':   'LISTING_PRICE_UPDATED',
  'listing_expired':  'LISTING_EXPIRED',
  'bid_placed':  'BID_PLACED',
  'auction_resolved':  'AUCTION_RESOLVED',
  'auction_cancelled':  'AUCTION_CANCELLED',
  'auction_created':  'AUCTION_CREATED',
  'auction_extended':   'AUCTION_EXTENDED',
  'offer_made':  'OFFER_MADE',
  'offer_accepted':  'OFFER_ACCEPTED',
  'offer_rejected':  'OFFER_REJECTED',
  'offer_withdrawn':  'OFFER_WITHDRAWN',
  'offer_reclaimed':  'OFFER_RECLAIMED',
  'royalty_paid':  'ROYALTY_PAID',
  'protocol_fee_collected':  'PROTOCOL_FEE_COLLECTED',
  // Royalty settlement snapshot (Issue #270); backs accounting reconciliation
  // (Issue #279) — previously unmapped, so these events were silently
  // dropped by resolveEventType() and never reached the database.
  'royalty_settlement':  'ROYALTY_SETTLEMENT',
  'artist_revoked':  'ARTIST_REVOKED',
  'artist_reinstated':  'ARTIST_REINSTATED',
  'admin_transfer_proposed':  'ADMIN_TRANSFER_PROPOSED',
  'admin_transferred':  'ADMIN_TRANSFERRED',
  'admin_proposal_cancelled':  'ADMIN_PROPOSAL_CANCELLED',
  'contract_paused':   'CONTRACT_PAUSED',
  'contract_unpaused': 'CONTRACT_UNPAUSED',
  // Granular pause events (Issue #205)
  'collection_paused':   'COLLECTION_PAUSED',
  'collection_unpaused': 'COLLECTION_UNPAUSED',
  'function_paused':     'FUNCTION_PAUSED',
  'function_unpaused':   'FUNCTION_UNPAUSED',
  // Launchpad deploy events (topics[0] = "deploy", topics[1] = kind tag)
  'dep_n721':  'DEPLOY_NORMAL_721',
  'dep_n1155': 'DEPLOY_NORMAL_1155',
  'dep_l721':  'DEPLOY_LAZY_721',
  'dep_l1155': 'DEPLOY_LAZY_1155',
};

/** All event type names this parser can produce (exported for tests/UI). */
export const KNOWN_EVENT_TYPES: readonly string[] = Object.values(TOPIC_MAP);

const DEPLOY_TYPES = new Set([
  'DEPLOY_NORMAL_721',
  'DEPLOY_NORMAL_1155',
  'DEPLOY_LAZY_721',
  'DEPLOY_LAZY_1155',
]);

// The first key present in the payload wins. The first five preserve the
// legacy precedence (e.g. art_sold carries both artist and buyer — artist
// remains the recorded actor); the rest cover the newly mapped topics per
// their structs in events.rs.
const ACTOR_KEYS = [
  'artist',
  'creator',
  'offerer',
  'bidder',
  'buyer',
  'cancelled_by',    // lst_cncl / auc_cncl
  'updated_by',      // lst_pru
  'new_admin',       // adm_xfrd: the accepting admin performed the transfer
  'current_admin',   // adm_prop: the proposing admin
  'admin',           // ctr_psd / ctr_unpsd (payload shape depends on contract)
] as const;

function extractActor(eventType: string, nativeData: any): string {
  if (DEPLOY_TYPES.has(eventType)) {
    // Deploy events publish a (creator, collection_address) tuple
    if (Array.isArray(nativeData) && nativeData.length >= 1 && nativeData[0] != null) {
      return nativeData[0].toString();
    }
    return '';
  }
  if (nativeData === null || typeof nativeData !== 'object' || Array.isArray(nativeData)) {
    return '';
  }
  for (const key of ACTOR_KEYS) {
    const value = nativeData[key];
    if (value !== undefined && value !== null) return value.toString();
  }
  return '';
}

function extractListingId(nativeData: any): bigint | null {
  if (nativeData === null || typeof nativeData !== 'object' || Array.isArray(nativeData)) {
    return null;
  }
  if (nativeData.listing_id !== undefined) return BigInt(nativeData.listing_id);
  // Auction events carry auction_id; it shares the marketplace id space
  if (nativeData.auction_id !== undefined) return BigInt(nativeData.auction_id);
  return null;
}

export function parseMarketplaceEvent(
  topics: string[],
  valueXdr: string,
  ledger: number,
  contractId: string = '',
  txHash: string = '',
  eventIndex: number = 0,
  eventId: string = '',
  txIndex: number = 0
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
  } else if (obj.id !== undefined && obj.id !== null) {
    // Dual-purpose `id` field (listing_id or auction_id depending on which
    // settlement path fired) used by RoyaltySettlementEvent (Issue #270/#279).
    listingId = BigInt(obj.id as bigint | number | string);
  }

  let actor = '';
  if (obj.artist)   actor = String(obj.artist);
  else if (obj.creator)  actor = String(obj.creator);
  else if (obj.offerer)  actor = String(obj.offerer);
  else if (obj.bidder)   actor = String(obj.bidder);
  else if (obj.buyer)    actor = String(obj.buyer);
  // Collection fee events carry no personal actor — use the collection address
  // as a stable identifier so the MarketplaceEvent.actor column is never empty.
  else if (obj.collection) actor = String(obj.collection);

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
    // Coalesce void payloads (e.g. ctr_psd) so the required Json column
    // always receives a value.
    data: convertBigInts(nativeData) ?? {},
    eventHash,
    contractId,
    txHash,
    eventIndex,
    eventId: eventId || eventHash,
    txIndex,
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
 * Helper to convert BigInts in an object to strings for JSON storage if needed,
 * though Prisma handles BigInt natively in some cases.
 * For 'Json' field in Prisma, we should convert them to strings or numbers.
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
