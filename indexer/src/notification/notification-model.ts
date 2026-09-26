/**
 * notification-model.ts
 *
 * Typed notification payload model for the indexer notification stream.
 * The /wallets/:address/notifications endpoint returns these payloads.
 * The /notifications/stream SSE endpoint emits them as JSON.
 */

import { EventClassification, EventPriority, EventDomain } from './event-priority.js';

// ── Core notification type ────────────────────────────────────────────────────

export interface IndexerNotification {
  /** Stable dedup key: domain:resourceId:eventType:ledgerSequence */
  id: string;
  eventType: string;
  domain: EventDomain;
  priority: EventPriority;
  /** Short human-readable description, e.g. "Auction #42 finalized — winning bid 10 XLM" */
  summary: string;
  /** Wallet address this notification is targeted at, or null for global events */
  targetWallet: string | null;
  /** The resource identifier (listingId, auctionId, contract address, etc.) */
  resourceId: string | null;
  /** Resource type — drives the deep-link in the frontend */
  resourceType: 'listing' | 'auction' | 'offer' | 'collection' | 'admin' | null;
  /** Amount in raw base units (stroops), as a string to avoid BigInt JSON issues */
  amount: string | null;
  /** Token contract address for the amount field */
  token: string | null;
  ledgerSequence: number;
  ledgerTimestamp: string | null;
  /** Original raw event data — forwarded so the frontend can render rich detail */
  data: Record<string, unknown>;
}

// ── Builder helpers ───────────────────────────────────────────────────────────

function rawId(
  eventType: string,
  resourceId: string | null,
  ledgerSequence: number
): string {
  return `${eventType}:${resourceId ?? 'global'}:${ledgerSequence}`;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function bigintStrOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  return s !== '0' && s !== '' ? s : null;
}

/**
 * Produces a human-readable summary string for an indexer event row.
 * Mirrors the frontend `summariseSSEEvent` helper but runs server-side
 * so the REST /notifications endpoint carries pre-rendered summaries.
 */
export function buildSummary(
  eventType: string,
  data: Record<string, unknown>
): string {
  const fmtXlm = (v: unknown): string => {
    const n = Number(String(v ?? 0));
    if (!Number.isFinite(n) || n === 0) return '';
    return `${(n / 1e7).toFixed(4)} XLM`;
  };

  const lid = data.listing_id ?? data.listingId;
  const aid = data.auction_id ?? data.auctionId;

  switch (eventType) {
    case 'LISTING_CREATED':     return `New listing #${lid} at ${fmtXlm(data.price)}`.trimEnd();
    case 'LISTING_CANCELLED':   return `Listing #${lid} cancelled`;
    case 'LISTING_EXPIRED':     return `Listing #${lid} expired`;
    case 'LISTING_PRICE_UPDATED': return `Listing #${lid} price → ${fmtXlm(data.new_price)}`.trimEnd();
    case 'ARTWORK_SOLD':        return `Listing #${lid} sold${data.price ? ` for ${fmtXlm(data.price)}` : ''}`;
    case 'AUCTION_CREATED':     return `Auction #${aid} started — reserve ${fmtXlm(data.reserve_price)}`.trimEnd();
    case 'BID_PLACED':          return `Bid of ${fmtXlm(data.bid_amount)} on auction #${aid}`;
    case 'AUCTION_RESOLVED':
    case 'AUCTION_FINALIZED':
      return data.winner
        ? `Auction #${aid} finalized — winning bid ${fmtXlm(data.amount)}`
        : `Auction #${aid} ended with no bids`;
    case 'AUCTION_EXTENDED':    return `Auction #${aid} deadline extended`;
    case 'AUCTION_CANCELLED':   return `Auction #${aid} cancelled`;
    case 'AUCTION_ADMIN_CANCELLED': return `Auction #${aid} force-cancelled by admin`;
    case 'AUCTION_BID_REFUNDED': return `Bid refund of ${fmtXlm(data.amount)} on auction #${aid}`;
    case 'OFFER_MADE':          return `Offer of ${fmtXlm(data.amount)} on listing #${lid}`;
    case 'OFFER_ACCEPTED':      return `Offer accepted on listing #${lid}`;
    case 'OFFER_REJECTED':      return `Offer rejected on listing #${lid}`;
    case 'OFFER_WITHDRAWN':     return `Offer withdrawn on listing #${lid}`;
    case 'OFFER_RECLAIMED':     return `Offer reclaimed on listing #${lid}`;
    case 'DEPLOY_NORMAL_721':   return 'New ERC-721 collection deployed';
    case 'DEPLOY_NORMAL_1155':  return 'New ERC-1155 collection deployed';
    case 'DEPLOY_LAZY_721':     return 'New lazy-mint ERC-721 collection deployed';
    case 'DEPLOY_LAZY_1155':    return 'New lazy-mint ERC-1155 collection deployed';
    case 'CONTRACT_PAUSED':     return 'Marketplace paused';
    case 'CONTRACT_UNPAUSED':   return 'Marketplace resumed';
    case 'ARTIST_REVOKED':      return `Artist ${data.artist} revoked`;
    case 'ARTIST_REINSTATED':   return `Artist ${data.artist} reinstated`;
    case 'REORG':               return `Chain reorg detected`;
    case 'CRITICAL_REORG':      return `Critical chain reorg`;
    default:                    return `Marketplace event: ${eventType}`;
  }
}

/**
 * Convert an indexed MarketplaceEvent row into an IndexerNotification.
 * Returns null when the event is not notifiable and `onlyNotifiable` is true.
 */
export function buildNotification(
  row: {
    id: number;
    eventType: string;
    listingId: string | bigint | null;
    actor: string;
    data: Record<string, unknown>;
    ledgerSequence: number;
    ledgerTimestamp: Date | string | null;
  },
  classification: EventClassification,
  targetWallet: string | null = null
): IndexerNotification {
  const lid = row.listingId != null ? String(row.listingId) : null;
  const aid = row.data?.auction_id != null ? String(row.data.auction_id) : null;

  const resourceId = lid ?? aid ?? null;
  const resourceType: IndexerNotification['resourceType'] =
    lid ? 'listing' :
    aid ? 'auction' :
    classification.domain === 'deploy' ? 'collection' :
    classification.domain === 'admin' ? 'admin' :
    null;

  const amountField =
    row.data?.bid_amount ?? row.data?.amount ?? row.data?.price ?? row.data?.new_price ?? null;

  return {
    id: rawId(row.eventType, resourceId, row.ledgerSequence),
    eventType: row.eventType,
    domain: classification.domain,
    priority: classification.priority,
    summary: buildSummary(row.eventType, row.data),
    targetWallet,
    resourceId,
    resourceType,
    amount: bigintStrOrNull(amountField),
    token: strOrNull(row.data?.token) ?? strOrNull(row.data?.currency),
    ledgerSequence: row.ledgerSequence,
    ledgerTimestamp:
      row.ledgerTimestamp instanceof Date
        ? row.ledgerTimestamp.toISOString()
        : typeof row.ledgerTimestamp === 'string'
        ? row.ledgerTimestamp
        : null,
    data: row.data,
  };
}
