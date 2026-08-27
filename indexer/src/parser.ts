import { xdr, Address, scValToNative } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import {
  SCHEMA_REGISTRY,
  decodeWithSchema,
  isSupportedSchemaVersion,
  type DecodeResult,
} from './event-schemas.js';

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

// Map contract short-symbol topics to human-readable event type names.
// The keys are the Soroban symbol_short!() values emitted in the contract events.
// Covers all 24 symbols from contracts/soroban-marketplace/src/events.rs plus
// the 4 launchpad deploy symbols, plus the long-form 'listing_price_updated'
// alias used by some older contract builds.
const TOPIC_MAP: Record<string, string> = {
  // ── Listing events ──────────────────────────────────────────────────────
  'lst_crtd':  'LISTING_CREATED',
  'art_sold':  'ARTWORK_SOLD',
  'lst_cncl':  'LISTING_CANCELLED',
  'lst_updt':  'LISTING_UPDATED',
  'lst_pru':   'LISTING_PRICE_UPDATED',
  // Long-form alias kept for backward compat with older contract builds
  'listing_price_updated': 'LISTING_PRICE_UPDATED',
  'lst_expd':  'LISTING_EXPIRED',
  // ── Auction events ──────────────────────────────────────────────────────
  'auc_crtd':  'AUCTION_CREATED',
  'bid_plcd':  'BID_PLACED',
  'auc_rslv':  'AUCTION_RESOLVED',
  'auc_cncl':  'AUCTION_CANCELLED',
  'auc_ext':   'AUCTION_EXTENDED',
  'auc_res_upd': 'AUCTION_RESERVE_UPDATED',
  // ── Offer events ────────────────────────────────────────────────────────
  'ofr_made':  'OFFER_MADE',
  'ofr_accp':  'OFFER_ACCEPTED',
  'ofr_rjct':  'OFFER_REJECTED',
  'ofr_wdrn':  'OFFER_WITHDRAWN',
  'ofr_rclm':  'OFFER_RECLAIMED',
  // ── Settlement / fee events ──────────────────────────────────────────────
  'roy_paid':  'ROYALTY_PAID',
  'fee_cltd':  'PROTOCOL_FEE_COLLECTED',
  // ── Governance / admin events ────────────────────────────────────────────
  'adm_prop':  'ADMIN_TRANSFER_PROPOSED',
  'adm_xfrd':  'ADMIN_TRANSFERRED',
  'art_rvkd':  'ARTIST_REVOKED',
  'art_rnst':  'ARTIST_REINSTATED',
  'ctr_psd':   'CONTRACT_PAUSED',
  'ctr_unpsd': 'CONTRACT_UNPAUSED',
  // ── Launchpad deploy events (topics[0]="deploy", topics[1]=kind tag) ────
  'dep_n721':  'DEPLOY_NORMAL_721',
  'dep_n1155': 'DEPLOY_NORMAL_1155',
  'dep_l721':  'DEPLOY_LAZY_721',
  'dep_l1155': 'DEPLOY_LAZY_1155',
  // ── Listing ownership reconciliation (Issue #456) ────────────────────
  'own_reconciled': 'LISTING_OWNERSHIP_RECONCILED',
};

/** All event type names this parser can produce (exported for tests/UI). */
export const KNOWN_EVENT_TYPES: readonly string[] = [...new Set(Object.values(TOPIC_MAP))];

const DEPLOY_TYPES = new Set([
  'DEPLOY_NORMAL_721',
  'DEPLOY_NORMAL_1155',
  'DEPLOY_LAZY_721',
  'DEPLOY_LAZY_1155',
]);

/**
 * Resolves the human-readable event type from the raw topic list.
 *
 * Single-topic events: topics[0] is the symbol (e.g. "lst_crtd").
 * Two-topic deploy events: topics[0] = "deploy", topics[1] = kind tag.
 * Falls back to treating the raw string as a direct TOPIC_MAP key when XDR
 * parsing throws (e.g. in tests that pass plain strings).
 *
 * Returns null when the topic is not recognised.
 */
export function resolveEventType(topics: string[]): string | null {
  if (topics.length === 0) return null;

  // Try to decode the first topic as XDR ScVal
  let firstSymbol: string | null = null;
  try {
    const scVal = xdr.ScVal.fromXDR(topics[0], 'base64');
    firstSymbol = scValToNative(scVal) as string;
  } catch {
    // Not valid base64 XDR — treat the raw string as the symbol directly
    firstSymbol = topics[0];
  }

  // Two-topic launchpad deploy format: ("deploy", kind_tag)
  if (firstSymbol === 'deploy' && topics.length >= 2) {
    let secondSymbol: string | null = null;
    try {
      const scVal2 = xdr.ScVal.fromXDR(topics[1], 'base64');
      secondSymbol = scValToNative(scVal2) as string;
    } catch {
      secondSymbol = topics[1];
    }
    if (secondSymbol && TOPIC_MAP[secondSymbol]) {
      return TOPIC_MAP[secondSymbol];
    }
    return null;
  }

  if (firstSymbol && TOPIC_MAP[firstSymbol]) {
    return TOPIC_MAP[firstSymbol];
  }

  return null;
}

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

  const eventHash = computeEventHash(contractId, ledger, txHash, eventIndex);

  const rawVal = xdr.ScVal.fromXDR(valueXdr, 'base64');
  const nativeData = scValToNative(rawVal);

  // ── Schema-driven validation ──────────────────────────────────────────────
  // Skip schema validation when nativeData is undefined — this happens in
  // unit tests that mock scValToNative to return undefined for the value XDR
  // and only test topic resolution (not data shape).
  const schema = SCHEMA_REGISTRY.get(type);
  if (schema && nativeData !== undefined) {
    const result = decodeWithSchema(type, schema, nativeData);
    if (!result.ok) {
      // Surface as a SchemaDecodeError so event-sync.ts can classify it with
      // the per-event-type Prometheus label before skipping this event.
      throw new SchemaDecodeError(type, result.reason, result.raw);
    }
  }

  // ── Schema-version gate (Issue #278) ──────────────────────────────────────
  // Structural decoding above can succeed even for a *future* schema_version
  // this indexer build doesn't know about — additive fields it doesn't
  // recognize are simply ignored by decodeWithSchema. That's fine for a
  // genuinely additive change, but the indexer can't prove that from the
  // shape alone, so any schema_version beyond what SUPPORTED_SCHEMA_VERSIONS
  // records is surfaced distinctly (never as a silent success, and never
  // lumped in with a generic SchemaDecodeError) so it can be counted and
  // investigated. Events with no schema_version field at all (legacy/
  // pre-Issue-278 events) are implicit version 0 and always supported.
  const schemaVersion = nativeData !== undefined ? extractSchemaVersion(type, nativeData) : undefined;
  if (schemaVersion !== undefined && !isSupportedSchemaVersion(type, schemaVersion)) {
    throw new UnsupportedSchemaVersionError(type, schemaVersion, nativeData);
  }

  // ── Shared field extraction ───────────────────────────────────────────────
  // Guard against undefined nativeData — topic-mapping unit tests that only
  // check eventType resolution pass undefined for the value XDR mock.
  const obj = (nativeData !== undefined && nativeData !== null && typeof nativeData === 'object' && !Array.isArray(nativeData))
    ? nativeData as Record<string, unknown>
    : {} as Record<string, unknown>;

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
      eventHash,
      contractId,
      txHash,
      eventIndex,
      eventId: eventId || eventHash,
      txIndex,
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

// ── UnsupportedSchemaVersionError ─────────────────────────────────────────────

/**
 * Thrown by parseMarketplaceEvent when an event decodes structurally, but its
 * `schema_version` is higher than this indexer build's
 * `SUPPORTED_SCHEMA_VERSIONS` entry for that event type (Issue #278). This is
 * deliberately distinct from `SchemaDecodeError`: the payload wasn't
 * malformed, the indexer is simply out of date relative to the contract.
 * event-sync.ts catches this to increment a dedicated Prometheus counter and
 * log a structured warning with enough context (event type, version, ledger,
 * tx) to investigate, rather than folding it into the generic decode-error
 * counters.
 */
export class UnsupportedSchemaVersionError extends Error {
  constructor(
    public readonly eventType: string,
    public readonly schemaVersion: number,
    public readonly raw: unknown
  ) {
    super(
      `[UnsupportedSchemaVersionError] ${eventType}: schema_version ${schemaVersion} is not supported by this indexer build`
    );
    this.name = 'UnsupportedSchemaVersionError';
  }
}

/**
 * Reads the `schema_version` carried by a decoded event, if any.
 *
 * - Object-shaped events (the common case) carry it as a named field.
 * - DEPLOY_* events are a positional tuple; `schema_version` (Issue #278) was
 *   appended as the 3rd element, so index 2 is checked instead of a name.
 *
 * Returns `undefined` when the field/element is absent — callers must treat
 * that as implicit version 0, not as "unsupported".
 */
function extractSchemaVersion(eventType: string, nativeData: unknown): number | undefined {
  if (
    eventType === 'DEPLOY_NORMAL_721' ||
    eventType === 'DEPLOY_NORMAL_1155' ||
    eventType === 'DEPLOY_LAZY_721' ||
    eventType === 'DEPLOY_LAZY_1155'
  ) {
    if (Array.isArray(nativeData) && nativeData.length >= 3) {
      const v = nativeData[2];
      return v === undefined || v === null ? undefined : Number(v as number | bigint);
    }
    return undefined;
  }

  if (nativeData !== null && typeof nativeData === 'object' && !Array.isArray(nativeData)) {
    const v = (nativeData as Record<string, unknown>).schema_version;
    return v === undefined || v === null ? undefined : Number(v as number | bigint);
  }

  return undefined;
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
