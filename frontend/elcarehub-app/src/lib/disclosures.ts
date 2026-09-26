/**
 * lib/disclosures.ts
 *
 * Work item C — Versioned action disclosures.
 *
 * Each financial action that triggers an irreversible on-chain transaction
 * (purchase, bid, offer, mint, collection deployment) has a disclosure
 * record that:
 *   1. Is versioned — bumping the version resets user acknowledgement.
 *   2. Is stored in localStorage under a stable key so acknowledgements
 *      survive navigation and page reloads within a session.
 *   3. Never stores private keys, seed phrases, or secrets.
 *   4. Is accessible — presented before signing, describable by screen readers.
 *
 * Usage:
 *   const disclosure = DISCLOSURES.purchase;
 *   const { acknowledged, acknowledge } = useDisclosure(disclosure.id);
 *   // Block signing until acknowledged === true
 */

export type DisclosureActionType =
  | 'purchase'         // Fixed-price buy
  | 'bid'              // Auction bid
  | 'offer'            // Make an offer
  | 'accept_offer'     // Seller accepts an offer
  | 'mint'             // Lazy-mint / collection-mint
  | 'collection_deploy'; // Deploy a new collection via launchpad

export interface DisclosureRecord {
  /** Stable identifier — also used as the localStorage key prefix. */
  id: DisclosureActionType;
  /**
   * Bump this integer whenever the text changes materially.
   * Users who acknowledged a prior version will be asked again.
   */
  version: number;
  /** Short title shown in the disclosure header. */
  title: string;
  /** Bullet-point risks. Keep each item ≤ 120 chars. */
  risks: string[];
  /**
   * Whether a checkbox acknowledgement is required before signing.
   * "optional" disclosures are shown as informational notices only.
   */
  requiresAcknowledgement: boolean;
  /** Link to the full policy page for this action type. */
  policyUrl: string;
}

/**
 * Canonical disclosure records.
 * Edit the `risks` array and bump `version` when material wording changes.
 */
export const DISCLOSURES: Record<DisclosureActionType, DisclosureRecord> = {
  purchase: {
    id: 'purchase',
    version: 1,
    title: 'Before you buy',
    requiresAcknowledgement: true,
    policyUrl: '/help#purchase-risks',
    risks: [
      'This transaction is irreversible once signed on-chain.',
      'You pay with your connected non-custodial wallet — the platform cannot access your funds.',
      'The total includes the item price, a protocol fee, and creator royalties shown in the breakdown.',
      'Prices are quoted in on-chain tokens; fiat equivalents are approximate and can change.',
      'The asset is stored on IPFS. Gateway availability is not guaranteed by the platform.',
      'If the indexer has not yet confirmed the transaction, the listing may appear unchanged briefly.',
    ],
  },
  bid: {
    id: 'bid',
    version: 1,
    title: 'Before you place a bid',
    requiresAcknowledgement: true,
    policyUrl: '/help#auction-risks',
    risks: [
      'Bids are binding — you cannot cancel a placed bid.',
      'If you are outbid, your locked funds are released by the contract.',
      'The auction end time is set on-chain and cannot be extended by the platform.',
      'Winning the auction requires the seller to finalize the transaction after it ends.',
      'You are responsible for any wallet fees charged by the network.',
    ],
  },
  offer: {
    id: 'offer',
    version: 1,
    title: 'Before you make an offer',
    requiresAcknowledgement: false,
    policyUrl: '/help#offer-risks',
    risks: [
      'Your offer amount is locked in escrow until it is accepted, rejected, or you withdraw it.',
      'Accepted offers trigger an irreversible on-chain transfer.',
      'Network fees apply regardless of whether the offer is accepted.',
    ],
  },
  accept_offer: {
    id: 'accept_offer',
    version: 1,
    title: 'Before you accept an offer',
    requiresAcknowledgement: true,
    policyUrl: '/help#offer-risks',
    risks: [
      'Accepting an offer is an irreversible on-chain action.',
      'The asset will be transferred to the buyer immediately upon confirmation.',
      'Royalties and protocol fees are deducted from the proceeds automatically.',
    ],
  },
  mint: {
    id: 'mint',
    version: 1,
    title: 'Before you mint',
    requiresAcknowledgement: true,
    policyUrl: '/help#mint-risks',
    risks: [
      'Minting records the token on-chain — it cannot be un-minted.',
      'Metadata is pinned to IPFS and is publicly visible; it cannot be deleted from all gateways.',
      'You are responsible for ensuring you hold the rights to the artwork before minting.',
      'Network fees apply and are non-refundable.',
    ],
  },
  collection_deploy: {
    id: 'collection_deploy',
    version: 1,
    title: 'Before you deploy a collection',
    requiresAcknowledgement: true,
    policyUrl: '/help#deploy-risks',
    risks: [
      'Contract deployment is irreversible — the contract address is permanent once created.',
      'Collection settings (name, symbol, royalty rate) are encoded at deployment time.',
      'You are responsible for ensuring the collection metadata does not infringe third-party rights.',
      'Deployment costs a network fee; there are no refunds if the deployment fails mid-flight.',
      'The launchpad admin can set WASM hashes for future upgrades, but cannot seize ownership.',
    ],
  },
};

// ── Consent storage ───────────────────────────────────────────────────────────

const STORAGE_PREFIX = 'elcarehub_disclosure_v';

/** Returns the localStorage key for a given disclosure id + version. */
function storageKey(id: DisclosureActionType, version: number): string {
  return `${STORAGE_PREFIX}${version}_${id}`;
}

/** Returns true if the user has acknowledged this disclosure at the current version. */
export function isAcknowledged(id: DisclosureActionType): boolean {
  if (typeof window === 'undefined') return false;
  const { version } = DISCLOSURES[id];
  try {
    return localStorage.getItem(storageKey(id, version)) === 'true';
  } catch {
    return false;
  }
}

/** Records the user's acknowledgement for this disclosure version. */
export function recordAcknowledgement(id: DisclosureActionType): void {
  if (typeof window === 'undefined') return;
  const { version } = DISCLOSURES[id];
  try {
    localStorage.setItem(storageKey(id, version), 'true');
  } catch {
    // Storage blocked — acknowledgement is session-only; not a security failure.
  }
}

/** Clears a stored acknowledgement (used when disclosure version changes). */
export function clearAcknowledgement(id: DisclosureActionType): void {
  if (typeof window === 'undefined') return;
  const { version } = DISCLOSURES[id];
  try {
    localStorage.removeItem(storageKey(id, version));
  } catch {
    // Ignore
  }
}
