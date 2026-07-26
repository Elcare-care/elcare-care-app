/**
 * @elcarehub/contract-abi
 *
 * Versioned TypeScript types, error codes, event schemas, and compatibility
 * utilities for the ElcareHub Soroban smart contracts.
 *
 * Usage:
 *
 *   import {
 *     // Marketplace types
 *     Listing, Auction, Offer, Recipient,
 *     ListingStatus, AuctionStatus, OfferStatus,
 *     MarketplaceErrorCode, MarketplaceErrorName,
 *     MARKETPLACE_CONTRACT_VERSION,
 *     // Version compatibility
 *     checkCompatibility, assertCompatibility,
 *   } from '@elcarehub/contract-abi';
 *
 *   // Or import from sub-paths:
 *   import type { Listing } from '@elcarehub/contract-abi/marketplace';
 *   import { LAUNCHPAD_CONTRACT_VERSION } from '@elcarehub/contract-abi/launchpad';
 */

export * from './marketplace.js';
export * from './launchpad.js';
export * from './compatibility.js';
