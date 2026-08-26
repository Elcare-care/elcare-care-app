// ─────────────────────────────────────────────────────────────
// lib/contractErrors/catalog.ts
//
// Authoritative client-side mapping for every `#[contracterror]` /
// `pub enum Error` exported by the on-chain contracts. Each entry's
// `code` + `name` must match the Rust enum discriminant/variant 1:1 —
// `scripts/contract-errors/validate-error-coverage.mjs` diffs this file
// against the actual contract source and fails CI when they drift.
//
// Source of truth for each contract (checked by the validator):
//   marketplace              contracts/soroban-marketplace/src/types.rs   (MarketplaceError)
//   launchpad                contracts/launchpad/src/types.rs             (Error)
//   collection_nft_erc721    contracts/collection_nft_erc721/src/lib.rs   (Error)
//   collection_nft_erc1155   contracts/collection_nft_erc1155/src/lib.rs  (Error)
//   lazy_mint_erc721         contracts/lazy_mint_erc721/src/lib.rs        (Error)
//   lazy_mint_erc1155        contracts/lazy_mint_erc1155/src/lib.rs       (Error)
// ─────────────────────────────────────────────────────────────

export type ContractName =
  | "marketplace"
  | "launchpad"
  | "collection_nft_erc721"
  | "collection_nft_erc1155"
  | "lazy_mint_erc721"
  | "lazy_mint_erc1155";

/** What the user can actually do about this error. */
export type ClientErrorAction =
  /** Transient — safe to retry the exact same call unmodified. */
  | "retry"
  /** The user must change an amount/date/token/recipient list and resubmit. */
  | "adjust_input"
  /** Wrong wallet/account connected, or the wallet needs to re-authorize. */
  | "reconnect_wallet"
  /** Local view is stale (something else changed the on-chain state) — refresh, then decide. */
  | "refresh_and_retry"
  /** Nothing the user can self-serve; needs an admin/creator/voucher they don't control. */
  | "none"
  /** Unexpected / internal condition — surfaced so it gets reported. */
  | "contact_support";

export interface ContractErrorDefinition {
  code: number;
  /** Must match the Rust enum variant name exactly (validated). */
  name: string;
  message: string;
  retryable: boolean;
  action: ClientErrorAction;
}

const MARKETPLACE_ERRORS: ContractErrorDefinition[] = [
  { code: 1, name: "InvalidCid", message: "Invalid metadata provided for this artwork.", retryable: false, action: "adjust_input" },
  { code: 2, name: "InvalidPrice", message: "The price is invalid. Please enter a positive value.", retryable: false, action: "adjust_input" },
  { code: 3, name: "ListingNotFound", message: "This listing was not found on-chain.", retryable: false, action: "refresh_and_retry" },
  { code: 4, name: "ListingNotActive", message: "This listing is no longer active.", retryable: false, action: "refresh_and_retry" },
  { code: 5, name: "Unauthorized", message: "You are not authorized to perform this action.", retryable: false, action: "reconnect_wallet" },
  { code: 6, name: "CannotBuyOwnListing", message: "You cannot buy your own listing.", retryable: false, action: "none" },
  { code: 7, name: "InvalidSplit", message: "Revenue split configuration is invalid.", retryable: false, action: "adjust_input" },
  { code: 8, name: "TooManyRecipients", message: "Too many recipients were supplied for this listing.", retryable: false, action: "adjust_input" },
  { code: 9, name: "AuctionNotFound", message: "This auction was not found on-chain.", retryable: false, action: "refresh_and_retry" },
  { code: 10, name: "AuctionNotActive", message: "This auction is no longer active.", retryable: false, action: "refresh_and_retry" },
  { code: 11, name: "BidTooLow", message: "Your bid is too low for this auction.", retryable: false, action: "adjust_input" },
  { code: 12, name: "AuctionExpired", message: "This auction has already expired.", retryable: false, action: "refresh_and_retry" },
  { code: 13, name: "AuctionNotExpired", message: "This auction has not expired yet.", retryable: false, action: "refresh_and_retry" },
  { code: 14, name: "AuctionAlreadyFinalized", message: "This auction is already finalized.", retryable: false, action: "refresh_and_retry" },
  { code: 15, name: "ArtistRevoked", message: "This artist account is currently revoked.", retryable: false, action: "none" },
  { code: 16, name: "OfferNotFound", message: "This offer was not found on-chain.", retryable: false, action: "refresh_and_retry" },
  { code: 17, name: "CannotOfferOwnListing", message: "You cannot make an offer on your own listing.", retryable: false, action: "none" },
  { code: 18, name: "OfferNotPending", message: "This offer is no longer pending.", retryable: false, action: "refresh_and_retry" },
  { code: 19, name: "InsufficientOfferAmount", message: "Offer amount is too low.", retryable: false, action: "adjust_input" },
  { code: 20, name: "ListingSold", message: "This listing has already been sold.", retryable: false, action: "refresh_and_retry" },
  { code: 21, name: "ListingCancelled", message: "This listing has been cancelled.", retryable: false, action: "refresh_and_retry" },
  { code: 22, name: "ReentrancyGuard", message: "The contract rejected this request for safety reasons. Please try again.", retryable: true, action: "retry" },
  { code: 23, name: "ContractPaused", message: "The marketplace is temporarily paused for maintenance. Please try again shortly.", retryable: true, action: "retry" },
  { code: 24, name: "InvalidRoyalty", message: "The royalty percentage is invalid.", retryable: false, action: "adjust_input" },
  { code: 25, name: "TokenNotWhitelisted", message: "This payment token is no longer supported for this listing.", retryable: false, action: "adjust_input" },
  { code: 26, name: "RoyaltyExceedsLimit", message: "Royalties plus protocol fee exceed 100%. Reduce the recipient shares.", retryable: false, action: "adjust_input" },
  { code: 27, name: "ListingExpired", message: "This listing has passed its expiry and can no longer be purchased.", retryable: false, action: "refresh_and_retry" },
  { code: 28, name: "ListingNotExpired", message: "This listing has not expired yet.", retryable: false, action: "refresh_and_retry" },
  { code: 29, name: "AuctionNotEnded", message: "This auction cannot be finalized until it ends.", retryable: false, action: "refresh_and_retry" },
  { code: 30, name: "AuctionHasBids", message: "This auction already has a bid and can no longer be cancelled.", retryable: false, action: "none" },
  { code: 31, name: "InvalidAuctionDuration", message: "The auction duration is too short or in the past.", retryable: false, action: "adjust_input" },
  { code: 32, name: "SelfBidNotAllowed", message: "You cannot bid on your own auction.", retryable: false, action: "none" },
  { code: 33, name: "InvalidOfferState", message: "This offer can no longer be modified in its current state.", retryable: false, action: "refresh_and_retry" },
  { code: 34, name: "OfferExpired", message: "This offer has expired.", retryable: false, action: "refresh_and_retry" },
  { code: 35, name: "OfferLimitReached", message: "This listing has reached its maximum number of active offers.", retryable: false, action: "adjust_input" },
  { code: 36, name: "BatchTooLarge", message: "Too many items in one batch. Please split this into smaller batches.", retryable: false, action: "adjust_input" },
  { code: 37, name: "AlreadyMigrated", message: "This contract has already been migrated to the current version.", retryable: false, action: "none" },
  { code: 38, name: "SelfPurchaseNotAllowed", message: "You cannot purchase your own listing.", retryable: false, action: "none" },
  { code: 39, name: "PriceOutOfBounds", message: "The price falls outside the allowed range.", retryable: false, action: "adjust_input" },
  { code: 40, name: "ArithmeticOverflow", message: "This transaction's numbers are too large to process safely.", retryable: false, action: "contact_support" },
  { code: 41, name: "AdminProposalExpired", message: "The pending admin proposal has expired and must be re-issued.", retryable: false, action: "refresh_and_retry" },
  { code: 42, name: "NoAdminProposalPending", message: "There is no admin proposal currently pending.", retryable: false, action: "refresh_and_retry" },
  { code: 43, name: "ZeroRecipientBps", message: "Every recipient must have a non-zero share.", retryable: false, action: "adjust_input" },
  { code: 44, name: "DuplicateRecipient", message: "The recipient list contains a duplicate address.", retryable: false, action: "adjust_input" },
  { code: 45, name: "InvalidAuctionState", message: "This action isn't valid for the auction's current state.", retryable: false, action: "refresh_and_retry" },
  { code: 46, name: "NoBidToRefund", message: "There is no losing bid available to refund for this account.", retryable: false, action: "none" },
  { code: 47, name: "InvalidExtensionWindow", message: "The anti-sniping extension window is invalid.", retryable: false, action: "contact_support" },
  { code: 48, name: "MaxExtensionsReached", message: "This auction has reached its maximum number of extensions.", retryable: false, action: "none" },
  { code: 49, name: "NotTokenOwner", message: "You do not own this token.", retryable: false, action: "reconnect_wallet" },
  { code: 50, name: "TokenAlreadyEscrowed", message: "This token is already listed or in an active auction.", retryable: false, action: "refresh_and_retry" },
];

const LAUNCHPAD_ERRORS: ContractErrorDefinition[] = [
  { code: 1, name: "AlreadyInitialized", message: "This launchpad contract has already been initialized.", retryable: false, action: "none" },
  { code: 2, name: "NotInitialized", message: "The launchpad has not been initialized yet.", retryable: false, action: "contact_support" },
  { code: 3, name: "NotAdmin", message: "You are not authorized to perform this admin action.", retryable: false, action: "reconnect_wallet" },
  { code: 4, name: "WasmHashNotSet", message: "This collection type isn't deployable yet — its contract code hasn't been registered.", retryable: false, action: "contact_support" },
  { code: 5, name: "InvalidFeeBps", message: "The platform fee percentage is invalid.", retryable: false, action: "adjust_input" },
  { code: 6, name: "ContractPaused", message: "Collection deployment is temporarily paused. Please try again shortly.", retryable: true, action: "retry" },
  { code: 7, name: "InvalidDeployFee", message: "The deployment fee configuration is invalid.", retryable: false, action: "contact_support" },
  { code: 8, name: "NoPendingAdmin", message: "There is no pending admin transfer to accept or cancel.", retryable: false, action: "refresh_and_retry" },
  { code: 9, name: "NotPendingAdmin", message: "You are not the proposed pending admin for this transfer.", retryable: false, action: "reconnect_wallet" },
  { code: 10, name: "DuplicateSalt", message: "A collection has already been deployed with this creator/salt pair. Choose a different salt.", retryable: false, action: "adjust_input" },
  { code: 11, name: "InvalidRoyaltyBps", message: "The royalty percentage exceeds 100%.", retryable: false, action: "adjust_input" },
  { code: 12, name: "EmptyName", message: "The collection name cannot be empty.", retryable: false, action: "adjust_input" },
  { code: 13, name: "EmptySymbol", message: "The collection symbol cannot be empty.", retryable: false, action: "adjust_input" },
  { code: 14, name: "InvalidMaxSupply", message: "Max supply must be greater than zero.", retryable: false, action: "adjust_input" },
  { code: 15, name: "InsufficientFee", message: "Your balance is insufficient to cover the deployment fee.", retryable: false, action: "adjust_input" },
];

const COLLECTION_NFT_ERC721_ERRORS: ContractErrorDefinition[] = [
  { code: 1, name: "AlreadyInitialized", message: "This collection has already been initialized.", retryable: false, action: "none" },
  { code: 2, name: "NotInitialized", message: "This collection has not been initialized yet.", retryable: false, action: "contact_support" },
  { code: 3, name: "NotOwner", message: "You do not own this token.", retryable: false, action: "reconnect_wallet" },
  { code: 4, name: "NotApproved", message: "You are not approved to transfer this token.", retryable: false, action: "none" },
  { code: 5, name: "TokenNotFound", message: "This token was not found in this collection.", retryable: false, action: "refresh_and_retry" },
  { code: 6, name: "MaxSupplyReached", message: "This collection has reached its maximum supply.", retryable: false, action: "none" },
  { code: 7, name: "NotCreator", message: "Only the collection creator can perform this action.", retryable: false, action: "reconnect_wallet" },
  { code: 8, name: "InsufficientBalance", message: "Insufficient token balance to complete this transaction.", retryable: false, action: "adjust_input" },
  { code: 9, name: "MetadataFrozen", message: "This collection's metadata has been permanently frozen and can no longer change.", retryable: false, action: "none" },
  { code: 10, name: "AlreadyFrozen", message: "This collection's metadata is already frozen.", retryable: false, action: "refresh_and_retry" },
  { code: 11, name: "InvalidBps", message: "The royalty basis-points value is invalid.", retryable: false, action: "adjust_input" },
  { code: 12, name: "CollectionPaused", message: "This collection is currently paused by its creator.", retryable: true, action: "retry" },
  { code: 13, name: "ApprovalExpired", message: "This approval has expired. Please request a new one.", retryable: false, action: "refresh_and_retry" },
  { code: 14, name: "AlreadyMigrated", message: "This collection has already been migrated to the current version.", retryable: false, action: "none" },
  { code: 15, name: "UnsupportedMigration", message: "This migration path isn't supported — upgrades must be sequential.", retryable: false, action: "contact_support" },
];

const COLLECTION_NFT_ERC1155_ERRORS: ContractErrorDefinition[] = [
  { code: 1, name: "AlreadyInitialized", message: "This collection has already been initialized.", retryable: false, action: "none" },
  { code: 2, name: "NotInitialized", message: "This collection has not been initialized yet.", retryable: false, action: "contact_support" },
  { code: 3, name: "NotApproved", message: "You are not approved to transfer these tokens.", retryable: false, action: "none" },
  { code: 4, name: "InsufficientBalance", message: "Insufficient token balance to complete this transaction.", retryable: false, action: "adjust_input" },
  { code: 5, name: "LengthMismatch", message: "The provided lists don't have matching lengths.", retryable: false, action: "adjust_input" },
  { code: 6, name: "NotCreator", message: "Only the collection creator can perform this action.", retryable: false, action: "reconnect_wallet" },
  { code: 7, name: "MaxSupplyReached", message: "This token has reached its maximum supply.", retryable: false, action: "none" },
  { code: 8, name: "WalletLimitReached", message: "You have reached the per-wallet mint limit for this token.", retryable: false, action: "none" },
  { code: 9, name: "CollectionPaused", message: "This collection is currently paused by its creator.", retryable: true, action: "retry" },
  { code: 10, name: "MetadataFrozen", message: "This collection's metadata has been permanently frozen and can no longer change.", retryable: false, action: "none" },
  { code: 11, name: "AlreadyFrozen", message: "This collection's metadata is already frozen.", retryable: false, action: "refresh_and_retry" },
  { code: 12, name: "InvalidBps", message: "The royalty basis-points value is invalid.", retryable: false, action: "adjust_input" },
  { code: 13, name: "AlreadyMigrated", message: "This collection has already been migrated to the current version.", retryable: false, action: "none" },
  { code: 14, name: "UnsupportedMigration", message: "This migration path isn't supported — upgrades must be sequential.", retryable: false, action: "contact_support" },
  { code: 15, name: "EmptyUri", message: "A token URI cannot be empty.", retryable: false, action: "adjust_input" },
  { code: 16, name: "UriTooLong", message: "The token URI exceeds the maximum allowed length.", retryable: false, action: "adjust_input" },
  { code: 17, name: "ZeroAmount", message: "Amount must be greater than zero.", retryable: false, action: "adjust_input" },
  { code: 18, name: "EmptyBatch", message: "Batch cannot be empty.", retryable: false, action: "adjust_input" },
  { code: 19, name: "BatchTooLarge", message: "Batch exceeds the maximum allowed size. Please split into smaller batches.", retryable: false, action: "adjust_input" },
  { code: 20, name: "TokenNotFound", message: "This token was not found in this collection.", retryable: false, action: "refresh_and_retry" },
];

const LAZY_MINT_ERC721_ERRORS: ContractErrorDefinition[] = [
  { code: 1, name: "AlreadyInitialized", message: "This collection has already been initialized.", retryable: false, action: "none" },
  { code: 2, name: "NotInitialized", message: "This collection has not been initialized yet.", retryable: false, action: "contact_support" },
  { code: 3, name: "NotOwner", message: "You do not own this token.", retryable: false, action: "reconnect_wallet" },
  { code: 4, name: "NotApproved", message: "You are not approved to transfer this token.", retryable: false, action: "none" },
  { code: 5, name: "TokenNotFound", message: "This token was not found in this collection.", retryable: false, action: "refresh_and_retry" },
  { code: 6, name: "MaxSupplyReached", message: "This collection has reached its maximum supply.", retryable: false, action: "none" },
  { code: 7, name: "VoucherExpired", message: "This mint voucher has expired.", retryable: false, action: "none" },
  { code: 8, name: "VoucherAlreadyRedeemed", message: "This mint voucher has already been redeemed.", retryable: false, action: "refresh_and_retry" },
  { code: 9, name: "NotCreator", message: "Only the collection creator can perform this action.", retryable: false, action: "reconnect_wallet" },
  { code: 10, name: "InvalidSignature", message: "This voucher's signature could not be verified.", retryable: false, action: "none" },
  { code: 11, name: "NotAllowlisted", message: "Your wallet is not on the allowlist for this mint.", retryable: false, action: "none" },
  { code: 12, name: "InvalidMerkleProof", message: "The allowlist proof provided is invalid.", retryable: false, action: "none" },
  { code: 13, name: "VoucherRevoked", message: "This mint voucher has been revoked by the creator.", retryable: false, action: "none" },
  { code: 14, name: "AlreadyMigrated", message: "This collection has already been migrated to the current version.", retryable: false, action: "none" },
  { code: 15, name: "UnsupportedMigration", message: "This migration path isn't supported — upgrades must be sequential.", retryable: false, action: "contact_support" },
];

const LAZY_MINT_ERC1155_ERRORS: ContractErrorDefinition[] = [
  { code: 1, name: "AlreadyInitialized", message: "This collection has already been initialized.", retryable: false, action: "none" },
  { code: 2, name: "NotInitialized", message: "This collection has not been initialized yet.", retryable: false, action: "contact_support" },
  { code: 3, name: "NotApproved", message: "You are not approved to transfer these tokens.", retryable: false, action: "none" },
  { code: 4, name: "InsufficientBalance", message: "Insufficient token balance to complete this transaction.", retryable: false, action: "adjust_input" },
  { code: 5, name: "LengthMismatch", message: "The provided lists don't have matching lengths.", retryable: false, action: "adjust_input" },
  { code: 6, name: "VoucherExpired", message: "This mint voucher has expired.", retryable: false, action: "none" },
  { code: 7, name: "ExceedsVoucherMax", message: "This mint would exceed the voucher's maximum allocation.", retryable: false, action: "adjust_input" },
  { code: 8, name: "NotCreator", message: "Only the collection creator can perform this action.", retryable: false, action: "reconnect_wallet" },
  { code: 9, name: "EditionNotRegistered", message: "This edition has not been registered on this collection.", retryable: false, action: "refresh_and_retry" },
  { code: 10, name: "EditionAlreadyRegistered", message: "This edition has already been registered.", retryable: false, action: "refresh_and_retry" },
  { code: 11, name: "InvalidSignature", message: "This voucher's signature could not be verified.", retryable: false, action: "none" },
  { code: 12, name: "MaxSupplyReached", message: "This edition has reached its maximum supply.", retryable: false, action: "none" },
  { code: 13, name: "VoucherAlreadyRedeemed", message: "This mint voucher has already been redeemed.", retryable: false, action: "refresh_and_retry" },
  { code: 14, name: "NotAllowlisted", message: "Your wallet is not on the allowlist for this mint.", retryable: false, action: "none" },
  { code: 15, name: "InvalidMerkleProof", message: "The allowlist proof provided is invalid.", retryable: false, action: "none" },
  { code: 16, name: "VoucherRevoked", message: "This mint voucher has been revoked by the creator.", retryable: false, action: "none" },
  { code: 17, name: "AlreadyMigrated", message: "This collection has already been migrated to the current version.", retryable: false, action: "none" },
  { code: 18, name: "UnsupportedMigration", message: "This migration path isn't supported — upgrades must be sequential.", retryable: false, action: "contact_support" },
];

export const CONTRACT_ERROR_CATALOG: Record<ContractName, ContractErrorDefinition[]> = {
  marketplace: MARKETPLACE_ERRORS,
  launchpad: LAUNCHPAD_ERRORS,
  collection_nft_erc721: COLLECTION_NFT_ERC721_ERRORS,
  collection_nft_erc1155: COLLECTION_NFT_ERC1155_ERRORS,
  lazy_mint_erc721: LAZY_MINT_ERC721_ERRORS,
  lazy_mint_erc1155: LAZY_MINT_ERC1155_ERRORS,
};

export function getContractErrorDefinition(
  contract: ContractName,
  code: number
): ContractErrorDefinition | undefined {
  return CONTRACT_ERROR_CATALOG[contract].find((e) => e.code === code);
}

/** Searches every contract's catalog for a code when the caller doesn't know
 * which contract raised it (e.g. a generic simulation failure). Returns the
 * first match — callers that know the contract should prefer
 * `getContractErrorDefinition` to avoid cross-contract code collisions. */
export function findContractErrorDefinition(
  code: number
): { contract: ContractName; definition: ContractErrorDefinition } | undefined {
  for (const contract of Object.keys(CONTRACT_ERROR_CATALOG) as ContractName[]) {
    const definition = CONTRACT_ERROR_CATALOG[contract].find((e) => e.code === code);
    if (definition) return { contract, definition };
  }
  return undefined;
}
