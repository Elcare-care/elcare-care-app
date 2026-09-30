/**
 * contract-client.ts
 *
 * Unified ABI-driven contract client for the marketplace and launchpad contracts.
 *
 * Encodes view-function payloads and decodes responses without hard-coding
 * fragile assumptions about event payloads.  Supports both getLedgerEntries
 * (listings, auctions, offers — direct DataKey access) and simulateTransaction
 * (collections — launchpad get_collection view call) modes, selected by
 * CHAIN_STATE_MODE env var for listings/auctions or always-simulate for
 * collections.
 *
 * Usage:
 *   const client = createContractClient(server, {
 *     marketplaceContractId: process.env.MARKETPLACE_CONTRACT_ID!,
 *     launchpadContractId:   process.env.LAUNCHPAD_CONTRACT_ID,
 *   });
 *   const listing = await client.fetchListing(42n);
 */

import { rpc } from '@stellar/stellar-sdk';
import {
  fetchListingsBatch,
  fetchAuctionsBatch,
  fetchOffersBatch,
  fetchCollectionOnChain,
  fetchCollectionFeeBpsFromMarketplace,
  getListingReader,
  getAuctionReader,
  getOfferReader,
} from './chain-state.js';
import type {
  ChainListingState,
  ChainAuctionState,
  ChainOfferState,
  ChainCollectionState,
} from './chain-state.js';
import { logger } from './logger.js';

// ── Public config ─────────────────────────────────────────────────────────────

export interface ContractClientConfig {
  marketplaceContractId: string;
  /** Optional — required only for collection state reads via the launchpad. */
  launchpadContractId?: string;
}

// ── Re-export chain-state types so callers need only import from here ─────────

export type {
  ChainListingState,
  ChainAuctionState,
  ChainOfferState,
  ChainCollectionState,
};

// ── ContractClient ────────────────────────────────────────────────────────────

export class ContractClient {
  private readonly listingReader: (
    server: rpc.Server, contractId: string, id: bigint
  ) => Promise<ChainListingState | null>;

  private readonly auctionReader: (
    server: rpc.Server, contractId: string, id: bigint
  ) => Promise<ChainAuctionState | null>;

  private readonly offerReader: (
    server: rpc.Server, contractId: string, id: bigint
  ) => Promise<ChainOfferState | null>;

  constructor(
    private readonly server: rpc.Server,
    private readonly config: ContractClientConfig,
  ) {
    this.listingReader = getListingReader();
    this.auctionReader = getAuctionReader();
    this.offerReader   = getOfferReader();
  }

  // ── Single-entity reads ─────────────────────────────────────────────────────

  async fetchListing(listingId: bigint): Promise<ChainListingState | null> {
    try {
      return await this.listingReader(this.server, this.config.marketplaceContractId, listingId);
    } catch (err) {
      logger.warn('[ContractClient] fetchListing failed', {
        listingId: listingId.toString(),
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async fetchAuction(auctionId: bigint): Promise<ChainAuctionState | null> {
    try {
      return await this.auctionReader(this.server, this.config.marketplaceContractId, auctionId);
    } catch (err) {
      logger.warn('[ContractClient] fetchAuction failed', {
        auctionId: auctionId.toString(),
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async fetchOffer(offerId: bigint): Promise<ChainOfferState | null> {
    try {
      return await this.offerReader(this.server, this.config.marketplaceContractId, offerId);
    } catch (err) {
      logger.warn('[ContractClient] fetchOffer failed', {
        offerId: offerId.toString(),
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Fetches collection state from the launchpad contract (get_collection).
   * Returns null when launchpadContractId is not configured or the call fails.
   */
  async fetchCollection(address: string): Promise<ChainCollectionState | null> {
    if (!this.config.launchpadContractId) return null;
    try {
      return await fetchCollectionOnChain(
        this.server, this.config.launchpadContractId, address
      );
    } catch (err) {
      logger.warn('[ContractClient] fetchCollection failed', {
        address,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Fetches the per-collection fee override from the marketplace contract
   * (get_collection_fee_bps).  Returns null when no override is set or on
   * error.
   */
  async fetchCollectionFeeBps(address: string): Promise<number | null> {
    try {
      return await fetchCollectionFeeBpsFromMarketplace(
        this.server, this.config.marketplaceContractId, address
      );
    } catch (err) {
      logger.warn('[ContractClient] fetchCollectionFeeBps failed', {
        address,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ── Batch reads (more efficient for reconciler sweeps) ──────────────────────

  /**
   * Fetches many listings in a single getLedgerEntries call.
   * Any RPC failure maps all ids to null (caller counts them as skipped).
   */
  async fetchListingsBatch(ids: bigint[]): Promise<Map<string, ChainListingState | null>> {
    try {
      return await fetchListingsBatch(this.server, this.config.marketplaceContractId, ids);
    } catch (err) {
      logger.error('[ContractClient] fetchListingsBatch failed', {
        count: ids.length,
        error: err instanceof Error ? err.message : String(err),
      });
      const result = new Map<string, ChainListingState | null>();
      for (const id of ids) result.set(id.toString(), null);
      return result;
    }
  }

  async fetchAuctionsBatch(ids: bigint[]): Promise<Map<string, ChainAuctionState | null>> {
    try {
      return await fetchAuctionsBatch(this.server, this.config.marketplaceContractId, ids);
    } catch (err) {
      logger.error('[ContractClient] fetchAuctionsBatch failed', {
        count: ids.length,
        error: err instanceof Error ? err.message : String(err),
      });
      const result = new Map<string, ChainAuctionState | null>();
      for (const id of ids) result.set(id.toString(), null);
      return result;
    }
  }

  async fetchOffersBatch(ids: bigint[]): Promise<Map<string, ChainOfferState | null>> {
    try {
      return await fetchOffersBatch(this.server, this.config.marketplaceContractId, ids);
    } catch (err) {
      logger.error('[ContractClient] fetchOffersBatch failed', {
        count: ids.length,
        error: err instanceof Error ? err.message : String(err),
      });
      const result = new Map<string, ChainOfferState | null>();
      for (const id of ids) result.set(id.toString(), null);
      return result;
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createContractClient(
  server: rpc.Server,
  config: ContractClientConfig,
): ContractClient {
  return new ContractClient(server, config);
}
