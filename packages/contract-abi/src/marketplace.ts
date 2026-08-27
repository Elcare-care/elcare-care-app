/**
 * marketplace.ts — Generated TypeScript types for the ElcareHub marketplace contract.
 *
 * These types mirror the Rust contract types in:
 *   contracts/soroban-marketplace/src/types.rs
 *   contracts/soroban-marketplace/src/events.rs
 *
 * CONTRACT_VERSION must match the `CONTRACT_VERSION` constant in contract.rs.
 * Any change to method signatures, event shapes, or error codes that is not
 * backward-compatible MUST increment this version and the package version.
 */

// ── Contract version ──────────────────────────────────────────────────────────

/** Semantic version of the deployed marketplace contract this package was built against. */
export const MARKETPLACE_CONTRACT_VERSION = '1.1.0' as const;

// ── Shared types ──────────────────────────────────────────────────────────────

/** A royalty recipient with a basis-point share (0–10 000). */
export interface Recipient {
  address: string;
  /** Basis points (0–10 000). Total across all recipients + protocol fee must not exceed 10 000. */
  percentage: number;
}

// ── Domain types ──────────────────────────────────────────────────────────────

export type ListingStatus = 'Active' | 'Sold' | 'Cancelled';
export type AuctionStatus = 'Active' | 'Finalized' | 'Cancelled';
export type OfferStatus   = 'Pending' | 'Accepted' | 'Rejected' | 'Withdrawn';
export type CancelReason  = 'Owner' | 'Expired' | 'AdminRevoked';

export interface Listing {
  listing_id: bigint;
  artist: string;
  price: bigint;
  currency: string;
  token: string;
  collection: string;
  token_id: bigint;
  recipients: Recipient[];
  status: ListingStatus;
  owner: string | null;
  created_at: number;
  protocol_fee_bps: number;
  expires_at: bigint | null;
}

export interface Auction {
  auction_id: bigint;
  creator: string;
  token: string;
  collection: string;
  token_id: bigint;
  reserve_price: bigint;
  highest_bid: bigint;
  highest_bidder: string | null;
  end_time: bigint;
  status: AuctionStatus;
  recipients: Recipient[];
  min_increment: bigint;
  extension_window: bigint;
  extension_trigger: bigint;
  protocol_fee_bps: number;
  bid_history_cap: number;
  max_extensions: number;
  extension_count: number;
  /** Original end time set at auction creation — the extension cap is
   *  original_end_time + MAX_TOTAL_AUCTION_DURATION. */
  original_end_time: bigint;
}

export interface Offer {
  offer_id: bigint;
  listing_id: bigint;
  offerer: string;
  amount: bigint;
  token: string;
  status: OfferStatus;
  created_at: number;
  expires_at: bigint | null;
}

export interface BidRecord {
  bidder: string;
  amount: bigint;
  ledger: number;
}

// ── Error codes ───────────────────────────────────────────────────────────────

/**
 * Numeric error codes emitted by the marketplace contract.
 * Mirrors MarketplaceError in types.rs exactly.
 */
export const MarketplaceErrorCode = {
  InvalidCid:               1,
  InvalidPrice:             2,
  ListingNotFound:          3,
  ListingNotActive:         4,
  Unauthorized:             5,
  CannotBuyOwnListing:      6,
  InvalidSplit:             7,
  TooManyRecipients:        8,
  AuctionNotFound:          9,
  AuctionNotActive:         10,
  BidTooLow:                11,
  AuctionExpired:           12,
  AuctionNotExpired:        13,
  AuctionAlreadyFinalized:  14,
  ArtistRevoked:            15,
  OfferNotFound:            16,
  CannotOfferOwnListing:    17,
  OfferNotPending:          18,
  InsufficientOfferAmount:  19,
  ListingSold:              20,
  ListingCancelled:         21,
  ReentrancyGuard:          22,
  ContractPaused:           23,
  InvalidRoyalty:           24,
  TokenNotWhitelisted:      25,
  RoyaltyExceedsLimit:      26,
  ListingExpired:           27,
  ListingNotExpired:        28,
  AuctionNotEnded:          29,
  AuctionHasBids:           30,
  InvalidAuctionDuration:   31,
  SelfBidNotAllowed:        32,
  InvalidOfferState:        33,
  OfferExpired:             34,
  OfferLimitReached:        35,
  BatchTooLarge:            36,
  AlreadyMigrated:          37,
  SelfPurchaseNotAllowed:   38,
  PriceOutOfBounds:         39,
  ArithmeticOverflow:       40,
  AdminProposalExpired:     41,
  NoAdminProposalPending:   42,
  ZeroRecipientBps:         43,
  DuplicateRecipient:       44,
  InvalidAuctionState:      45,
  NoBidToRefund:            46,
  InvalidExtensionWindow:   47,
  MaxExtensionsReached:     48,
  NotTokenOwner:            49,
  TokenAlreadyEscrowed:     50,
  AuctionDurationLimitReached: 51,
  NoRoleProposalPending:    52,
  RoleProposalExpired:      53,
  RoleTransferToSelf:       54,
  RoleTransferToContract:   55,
  TreasuryProposalExpired:  56,
  NoTreasuryProposalPending: 57,
  TreasuryProposalSelf:     58,
  InvalidListingDuration:   59,
  CollectionIncompatible:   60,
  BatchItemInvalid:         61,
  OwnershipMismatch:        62,
  RoyaltyAlreadyClaimed:    63,
  RoyaltyClaimNotFound:     64,
  ReservationWindowActive:  65,
  InvalidReservationWindow: 66,
} as const;

export type MarketplaceErrorCode = typeof MarketplaceErrorCode[keyof typeof MarketplaceErrorCode];

/** Reverse-lookup: numeric code → human-readable name. */
export const MarketplaceErrorName: Record<number, string> = Object.fromEntries(
  Object.entries(MarketplaceErrorCode).map(([name, code]) => [code, name])
);

// ── Event payload types ───────────────────────────────────────────────────────

export interface ListingCreatedEvent {
  listing_id: bigint;
  artist: string;
  price: bigint;
  currency: string;
  collection: string;
  token_id: bigint;
  ledger_sequence?: bigint;
}

export interface ArtworkSoldEvent {
  listing_id: bigint;
  artist: string;
  buyer: string;
  price: bigint;
  currency: string;
  ledger_sequence?: bigint;
}

export interface ListingCancelledEvent {
  listing_id: bigint;
  cancelled_by: string;
  reason: CancelReason;
  ledger_sequence?: bigint;
}

export interface ListingUpdatedEvent {
  listing_id: bigint;
  artist: string;
  new_price: bigint;
  collection: string;
  token_id: bigint;
  ledger_sequence?: bigint;
}

export interface ListingPriceUpdatedEvent {
  listing_id: bigint;
  old_price: bigint;
  new_price: bigint;
  updated_by: string;
}

export interface ListingExpiredEvent {
  listing_id: bigint;
  expired_at: bigint;
  ledger_sequence?: bigint;
}

export interface AuctionCreatedEvent {
  auction_id: bigint;
  creator: string;
  reserve_price: bigint;
  token: string;
  collection: string;
  token_id: bigint;
  end_time: bigint;
}

export interface BidPlacedEvent {
  auction_id: bigint;
  bidder: string;
  bid_amount: bigint;
}

export interface AuctionResolvedEvent {
  auction_id: bigint;
  winner: string | null;
  amount: bigint;
}

export interface AuctionCancelledEvent {
  auction_id: bigint;
  cancelled_by: string;
  reason: string;
}

export interface AuctionExtendedEvent {
  auction_id: bigint;
  prev_end_time: bigint;
  new_end_time: bigint;
  extension_count: number;
}

export interface AuctionBidRefundedEvent {
  auction_id: bigint;
  bidder: string;
  amount: bigint;
  token: string;
  reason: string;
  ledger_sequence?: bigint;
}

export interface AuctionAdminCancelledEvent {
  auction_id: bigint;
  cancelled_by: string;
  refunded_amount: bigint;
  token: string;
  ledger_sequence?: bigint;
}

export interface OfferMadeEvent {
  offer_id: bigint;
  listing_id: bigint;
  offerer: string;
  amount: bigint;
  token: string;
  expires_at: bigint | null;
}

export interface OfferAcceptedEvent {
  offer_id: bigint;
  listing_id: bigint;
  offerer: string;
  amount: bigint;
}

export interface OfferRejectedEvent {
  offer_id: bigint;
  listing_id: bigint;
  offerer: string;
}

export interface OfferWithdrawnEvent {
  offer_id: bigint;
  listing_id: bigint;
  offerer: string;
}

export interface OfferReclaimedEvent {
  offer_id: bigint;
  listing_id: bigint;
  offerer: string;
  amount: bigint;
}

export interface RoyaltySettlementEvent {
  id: bigint;
  recipients: Recipient[];
  total_amount: bigint;
  token: string;
  ledger_sequence?: bigint;
}

export interface AdminTransferProposedEvent {
  current_admin: string;
  proposed_admin: string;
  expires_at: bigint;
}

export interface AdminTransferredEvent {
  old_admin: string;
  new_admin: string;
}

export interface AdminProposalCancelledEvent {
  current_admin: string;
  cancelled_candidate: string;
}

export interface NftEscrowedEvent {
  id: bigint;
  collection: string;
  token_id: bigint;
  seller: string;
  ledger_sequence?: bigint;
}

export interface NftReleasedEvent {
  id: bigint;
  collection: string;
  token_id: bigint;
  recipient: string;
  ledger_sequence?: bigint;
}

export interface ProtocolFeeCollectedEvent {
  listing_id: bigint;
  amount: bigint;
  token: string;
  treasury: string;
}

/** Union of all marketplace event payload types keyed by their topic string. */
export type MarketplaceEventPayload =
  | { type: 'LISTING_CREATED';          data: ListingCreatedEvent }
  | { type: 'ARTWORK_SOLD';             data: ArtworkSoldEvent }
  | { type: 'LISTING_CANCELLED';        data: ListingCancelledEvent }
  | { type: 'LISTING_UPDATED';          data: ListingUpdatedEvent }
  | { type: 'LISTING_PRICE_UPDATED';    data: ListingPriceUpdatedEvent }
  | { type: 'LISTING_EXPIRED';          data: ListingExpiredEvent }
  | { type: 'AUCTION_CREATED';          data: AuctionCreatedEvent }
  | { type: 'BID_PLACED';              data: BidPlacedEvent }
  | { type: 'AUCTION_RESOLVED';         data: AuctionResolvedEvent }
  | { type: 'AUCTION_CANCELLED';        data: AuctionCancelledEvent }
  | { type: 'AUCTION_EXTENDED';         data: AuctionExtendedEvent }
  | { type: 'AUCTION_BID_REFUNDED';     data: AuctionBidRefundedEvent }
  | { type: 'AUCTION_ADMIN_CANCELLED';  data: AuctionAdminCancelledEvent }
  | { type: 'OFFER_MADE';               data: OfferMadeEvent }
  | { type: 'OFFER_ACCEPTED';           data: OfferAcceptedEvent }
  | { type: 'OFFER_REJECTED';           data: OfferRejectedEvent }
  | { type: 'OFFER_WITHDRAWN';          data: OfferWithdrawnEvent }
  | { type: 'OFFER_RECLAIMED';          data: OfferReclaimedEvent }
  | { type: 'ROYALTY_SETTLEMENT';       data: RoyaltySettlementEvent }
  | { type: 'ADMIN_TRANSFER_PROPOSED';  data: AdminTransferProposedEvent }
  | { type: 'ADMIN_TRANSFERRED';        data: AdminTransferredEvent }
  | { type: 'ADMIN_PROPOSAL_CANCELLED'; data: AdminProposalCancelledEvent }
  | { type: 'NFT_ESCROWED';             data: NftEscrowedEvent }
  | { type: 'NFT_RELEASED';             data: NftReleasedEvent }
  | { type: 'PROTOCOL_FEE_COLLECTED';   data: ProtocolFeeCollectedEvent }
  | { type: 'CONTRACT_PAUSED';          data: Record<string, never> }
  | { type: 'CONTRACT_UNPAUSED';        data: Record<string, never> }
  | { type: 'COLLECTION_PAUSED';        data: { collection: string } }
  | { type: 'COLLECTION_UNPAUSED';      data: { collection: string } }
  | { type: 'FUNCTION_PAUSED';          data: { function_name: string } }
  | { type: 'FUNCTION_UNPAUSED';        data: { function_name: string } }
  | { type: 'ARTIST_REVOKED';           data: { artist: string } }
  | { type: 'ARTIST_REINSTATED';        data: { artist: string } };
