import { xdr, Address, scValToNative } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';

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
  'lst_crtd': 'LISTING_CREATED',
  'art_sold': 'ARTWORK_SOLD',
  'lst_cncl': 'LISTING_CANCELLED',
  'lst_updt': 'LISTING_UPDATED',
  'lst_pru': 'LISTING_PRICE_UPDATED',
  'lst_expd': 'LISTING_EXPIRED',
  'bid_plcd': 'BID_PLACED',
  'auc_rslv': 'AUCTION_RESOLVED',
  'auc_cncl': 'AUCTION_CANCELLED',
  'auc_ext': 'AUCTION_EXTENDED',
  'ofr_made': 'OFFER_MADE',
  'ofr_accp': 'OFFER_ACCEPTED',
  'ofr_rjct': 'OFFER_REJECTED',
  'ofr_wdrn': 'OFFER_WITHDRAWN',
  'ofr_rclm': 'OFFER_RECLAIMED',
  'roy_paid': 'ROYALTY_PAID',
  'fee_cltd': 'PROTOCOL_FEE_COLLECTED',
  'adm_prop': 'ADMIN_TRANSFER_PROPOSED',
  'adm_xfrd': 'ADMIN_TRANSFERRED',
  'art_rvkd': 'ARTIST_REVOKED',
  'art_rnst': 'ARTIST_REINSTATED',
  'ctr_psd': 'CONTRACT_PAUSED',
  'ctr_unpsd': 'CONTRACT_UNPAUSED',
  'auc_crtd': 'AUCTION_CREATED',
  'dep_n721': 'DEPLOY_NORMAL_721',
  'dep_n1155': 'DEPLOY_NORMAL_1155',
  'dep_l721': 'DEPLOY_LAZY_721',
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
  // Topics might be XDR base64 strings or decoded symbols
  let topic = '';
  try {
    const rawTopic = xdr.ScVal.fromXDR(topics[0], 'base64');
    topic = scValToNative(rawTopic);
  } catch {
    topic = topics[0]; // Fallback if already decoded
  }

  const type = TOPIC_MAP[topic];
  if (!type) return null;

  const rawVal = xdr.ScVal.fromXDR(valueXdr, 'base64');
  const nativeData = scValToNative(rawVal);

  const listingId = extractListingId(nativeData);
  const actor = extractActor(type, nativeData);
  const eventHash = computeEventHash(contractId, ledger, txHash, eventIndex);

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

/**
 * Helper to convert BigInts in an object to strings for JSON storage if needed,
 * though Prisma handles BigInt natively in some cases.
 * For 'Json' field in Prisma, we should convert them to strings or numbers.
 */
function convertBigInts(obj: any): any {
  if (typeof obj === 'bigint') return obj.toString();
  if (Array.isArray(obj)) return obj.map(convertBigInts);
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, convertBigInts(v)])
    );
  }
  return obj;
}
