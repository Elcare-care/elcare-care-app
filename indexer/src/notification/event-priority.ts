/**
 * event-priority.ts
 *
 * Domain classification and priority model for marketplace SSE events.
 * Used by the notification service to route, filter, and rank events
 * so the frontend receives HIGH-priority items (bid outbid, offer accepted,
 * auction finalized) immediately while LOW-priority admin events are
 * rate-limited or suppressed for non-operator subscribers.
 */

// ── Domain categories ─────────────────────────────────────────────────────────

export type EventDomain =
  | 'auction'   // bidding, finalization, extension, cancellation
  | 'offer'     // make, accept, reject, withdraw, reclaim
  | 'listing'   // create, update, cancel, expire, price change, sale
  | 'deploy'    // collection deployment via launchpad
  | 'admin'     // pause, unpause, role changes, token whitelist
  | 'system';   // reorg, health

// ── Priority levels ───────────────────────────────────────────────────────────

export type EventPriority = 'HIGH' | 'MEDIUM' | 'LOW';

// ── Per-event classification ──────────────────────────────────────────────────

export interface EventClassification {
  domain: EventDomain;
  priority: EventPriority;
  /**
   * When true, this event type is always sent to the wallet-scoped
   * notification stream if the wallet is directly involved (actor, buyer,
   * bidder, offerer, artist, winner). When false the event is only visible
   * in the global activity feed.
   */
  notifiable: boolean;
}

export const EVENT_CLASSIFICATIONS: Record<string, EventClassification> = {
  // ── Listing ────────────────────────────────────────────────────────────────
  LISTING_CREATED:       { domain: 'listing', priority: 'MEDIUM', notifiable: true  },
  LISTING_UPDATED:       { domain: 'listing', priority: 'LOW',    notifiable: false },
  LISTING_PRICE_UPDATED: { domain: 'listing', priority: 'LOW',    notifiable: true  },
  LISTING_CANCELLED:     { domain: 'listing', priority: 'MEDIUM', notifiable: true  },
  LISTING_EXPIRED:       { domain: 'listing', priority: 'LOW',    notifiable: true  },
  ARTWORK_SOLD:          { domain: 'listing', priority: 'HIGH',   notifiable: true  },
  // ── Auction ────────────────────────────────────────────────────────────────
  AUCTION_CREATED:       { domain: 'auction', priority: 'MEDIUM', notifiable: true  },
  BID_PLACED:            { domain: 'auction', priority: 'MEDIUM', notifiable: true  },
  AUCTION_EXTENDED:      { domain: 'auction', priority: 'HIGH',   notifiable: true  },
  AUCTION_RESOLVED:      { domain: 'auction', priority: 'HIGH',   notifiable: true  },
  AUCTION_FINALIZED:     { domain: 'auction', priority: 'HIGH',   notifiable: true  },
  AUCTION_CANCELLED:     { domain: 'auction', priority: 'MEDIUM', notifiable: true  },
  AUCTION_BID_REFUNDED:  { domain: 'auction', priority: 'HIGH',   notifiable: true  },
  AUCTION_ADMIN_CANCELLED: { domain: 'auction', priority: 'HIGH', notifiable: true  },
  // ── Offer ──────────────────────────────────────────────────────────────────
  OFFER_MADE:            { domain: 'offer',   priority: 'MEDIUM', notifiable: true  },
  OFFER_ACCEPTED:        { domain: 'offer',   priority: 'HIGH',   notifiable: true  },
  OFFER_REJECTED:        { domain: 'offer',   priority: 'MEDIUM', notifiable: true  },
  OFFER_WITHDRAWN:       { domain: 'offer',   priority: 'MEDIUM', notifiable: true  },
  OFFER_RECLAIMED:       { domain: 'offer',   priority: 'LOW',    notifiable: true  },
  // ── Deploy ─────────────────────────────────────────────────────────────────
  DEPLOY_NORMAL_721:     { domain: 'deploy',  priority: 'LOW',    notifiable: true  },
  DEPLOY_NORMAL_1155:    { domain: 'deploy',  priority: 'LOW',    notifiable: true  },
  DEPLOY_LAZY_721:       { domain: 'deploy',  priority: 'LOW',    notifiable: true  },
  DEPLOY_LAZY_1155:      { domain: 'deploy',  priority: 'LOW',    notifiable: true  },
  LAUNCHPAD_WASM_UPDATED:       { domain: 'deploy', priority: 'LOW', notifiable: false },
  LAUNCHPAD_COLLECTION_UPGRADED:{ domain: 'deploy', priority: 'LOW', notifiable: false },
  // ── Admin ──────────────────────────────────────────────────────────────────
  CONTRACT_PAUSED:       { domain: 'admin',   priority: 'HIGH',   notifiable: false },
  CONTRACT_UNPAUSED:     { domain: 'admin',   priority: 'HIGH',   notifiable: false },
  COLLECTION_PAUSED:     { domain: 'admin',   priority: 'HIGH',   notifiable: false },
  COLLECTION_UNPAUSED:   { domain: 'admin',   priority: 'HIGH',   notifiable: false },
  FUNCTION_PAUSED:       { domain: 'admin',   priority: 'HIGH',   notifiable: false },
  FUNCTION_UNPAUSED:     { domain: 'admin',   priority: 'HIGH',   notifiable: false },
  ADMIN_TRANSFER_PROPOSED:  { domain: 'admin', priority: 'HIGH',  notifiable: false },
  ADMIN_TRANSFERRED:        { domain: 'admin', priority: 'HIGH',  notifiable: false },
  ADMIN_PROPOSAL_CANCELLED: { domain: 'admin', priority: 'LOW',   notifiable: false },
  ARTIST_REVOKED:        { domain: 'admin',   priority: 'HIGH',   notifiable: true  },
  ARTIST_REINSTATED:     { domain: 'admin',   priority: 'MEDIUM', notifiable: true  },
  TOKEN_WHITELISTED:     { domain: 'admin',   priority: 'LOW',    notifiable: false },
  TOKEN_REMOVED:         { domain: 'admin',   priority: 'LOW',    notifiable: false },
  ROYALTY_PAID:          { domain: 'listing', priority: 'LOW',    notifiable: false },
  ROYALTY_SETTLEMENT:    { domain: 'listing', priority: 'LOW',    notifiable: false },
  PROTOCOL_FEE_COLLECTED:{ domain: 'admin',   priority: 'LOW',    notifiable: false },
  // ── System ─────────────────────────────────────────────────────────────────
  REORG:                 { domain: 'system',  priority: 'HIGH',   notifiable: false },
  CRITICAL_REORG:        { domain: 'system',  priority: 'HIGH',   notifiable: false },
};

/**
 * Classify an event type, returning a default LOW/system classification
 * for unknown types rather than throwing.
 */
export function classifyEvent(eventType: string): EventClassification {
  return (
    EVENT_CLASSIFICATIONS[eventType] ?? {
      domain: 'system',
      priority: 'LOW',
      notifiable: false,
    }
  );
}

/**
 * Returns true when an event should be included in a notification stream
 * for a given wallet address. The wallet is considered "involved" when it
 * appears as any of the primary actors in the event data.
 */
export function isWalletInvolved(
  walletAddress: string,
  eventData: Record<string, unknown>
): boolean {
  const ACTOR_FIELDS = [
    'actor', 'artist', 'buyer', 'bidder', 'offerer', 'winner',
    'creator', 'cancelled_by', 'updated_by', 'current_admin',
  ] as const;
  for (const field of ACTOR_FIELDS) {
    if (
      typeof eventData[field] === 'string' &&
      (eventData[field] as string).toLowerCase() === walletAddress.toLowerCase()
    ) {
      return true;
    }
  }
  return false;
}
