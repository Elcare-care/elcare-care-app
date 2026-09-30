/**
 * lib/support.ts
 *
 * Work item B — Support center types, validation, and client helpers.
 *
 * Design constraints:
 *  • Forms must NEVER accept private keys, seed phrases, or other secrets.
 *  • Support agents can read on-chain evidence but cannot alter ownership.
 *  • Every report has a visible status and estimated response time.
 *  • Resolution limits for immutable transfers are documented inline.
 */

// ── Categories ────────────────────────────────────────────────────────────────

export type SupportCategory =
  | 'UNAUTHORIZED_LISTING'   // Content listed without owner consent
  | 'METADATA_DISPUTE'       // Wrong or misleading title/description/image
  | 'FAILED_DISPLAY'         // Asset renders incorrectly or fails to load
  | 'TRANSACTION_CONFUSION'  // Purchase / bid / offer outcome unclear
  | 'IPFS_AVAILABILITY'      // Asset unreachable via IPFS gateway
  | 'SPAM_OR_SCAM'           // Fraudulent collection or listing
  | 'OTHER';                 // Catch-all for undefined issues

export interface SupportCategoryMeta {
  label: string;
  description: string;
  /** Evidence fields required for this category */
  requiredEvidence: SupportEvidenceField[];
  /** Estimated first-response SLA in business hours */
  responseSlaHours: number;
  /**
   * What the platform CAN and CANNOT do.
   * Shown to users before they submit to set expectations.
   */
  platformLimits: string;
}

export type SupportEvidenceField =
  | 'resource_id'
  | 'transaction_hash'
  | 'screenshot_url'
  | 'ipfs_cid'
  | 'description';

export const SUPPORT_CATEGORIES: Record<SupportCategory, SupportCategoryMeta> = {
  UNAUTHORIZED_LISTING: {
    label: 'Unauthorized Listing',
    description: 'An asset was listed for sale without the rights holder\'s consent.',
    requiredEvidence: ['resource_id', 'description'],
    responseSlaHours: 24,
    platformLimits:
      'We can hide the listing from our UI and prevent future marketplace interactions. ' +
      'We cannot reverse a completed on-chain sale or remove the asset from IPFS or third-party gateways.',
  },
  METADATA_DISPUTE: {
    label: 'Metadata Dispute',
    description: 'The title, description, artist attribution, or image linked to a listing is wrong.',
    requiredEvidence: ['resource_id', 'ipfs_cid', 'description'],
    responseSlaHours: 48,
    platformLimits:
      'IPFS metadata is content-addressed and immutable once pinned. We can add an on-platform ' +
      'correction notice, but the original CID will remain accessible on public gateways.',
  },
  FAILED_DISPLAY: {
    label: 'Failed or Incorrect Display',
    description: 'An asset image, countdown, or financial value is not rendering correctly.',
    requiredEvidence: ['resource_id', 'screenshot_url', 'description'],
    responseSlaHours: 8,
    platformLimits:
      'Display bugs are fully within our control to fix. On-chain values are authoritative; ' +
      'if the display disagrees with your wallet history, we will investigate the indexer.',
  },
  TRANSACTION_CONFUSION: {
    label: 'Transaction Confusion',
    description: 'A purchase, bid, offer, or royalty payment has an unclear or unexpected outcome.',
    requiredEvidence: ['transaction_hash', 'description'],
    responseSlaHours: 24,
    platformLimits:
      'Confirmed on-chain transactions are irreversible. We can verify the on-chain record, ' +
      'reconcile indexer state, and explain the outcome — but we cannot reverse a signed transaction.',
  },
  IPFS_AVAILABILITY: {
    label: 'IPFS Asset Unavailable',
    description: 'The artwork or metadata CID is not reachable via any known IPFS gateway.',
    requiredEvidence: ['ipfs_cid', 'description'],
    responseSlaHours: 48,
    platformLimits:
      'We can re-pin CIDs we originally uploaded to Pinata. Content pinned by third parties or ' +
      'unpinned from all nodes may be permanently unavailable; we cannot recreate lost IPFS data.',
  },
  SPAM_OR_SCAM: {
    label: 'Spam or Scam',
    description: 'A collection, listing, or user appears to be fraudulent.',
    requiredEvidence: ['resource_id', 'description'],
    responseSlaHours: 4,
    platformLimits:
      'We can remove content from our UI and block the associated address from future interactions. ' +
      'We cannot claw back funds already transferred on-chain.',
  },
  OTHER: {
    label: 'Other',
    description: 'An issue that does not fit the categories above.',
    requiredEvidence: ['description'],
    responseSlaHours: 72,
    platformLimits:
      'We review all reports but cannot guarantee action on requests outside our operational scope.',
  },
};

// ── Report status ─────────────────────────────────────────────────────────────

export type SupportReportStatus =
  | 'RECEIVED'     // Submitted, awaiting triage
  | 'IN_REVIEW'    // Assigned to support agent
  | 'RESOLVED'     // Actioned; details in resolution note
  | 'CLOSED'       // No action taken; reason provided
  | 'ESCALATED';   // Escalated to chain/legal team

// ── Report record ─────────────────────────────────────────────────────────────

export interface SupportReport {
  id: string;
  category: SupportCategory;
  /** Listing ID, auction ID, collection address, or tx hash */
  resourceId?: string;
  transactionHash?: string;
  screenshotUrl?: string;
  ipfsCid?: string;
  /** Reporter's wallet address — optional, never stored as secret */
  reporterAddress?: string;
  description: string;
  status: SupportReportStatus;
  /** ISO-8601 timestamps */
  createdAt: string;
  updatedAt: string;
  /** Public-facing resolution note */
  resolutionNote?: string;
}

// ── Secret-detection ──────────────────────────────────────────────────────────

/** Patterns that look like Stellar secret keys, BIP-39 phrases, or hex private keys. */
const SECRET_PATTERNS = [
  /\bS[A-Z2-7]{55}\b/,               // Stellar secret key (starts with S, 56 chars)
  /([a-z]+ ){11}[a-z]+/i,             // 12-word mnemonic phrase
  /([a-z]+ ){23}[a-z]+/i,             // 24-word mnemonic phrase
  /\b[0-9a-fA-F]{64}\b/,             // 32-byte hex private key
];

/**
 * Returns true if the text contains a pattern that looks like a secret.
 * Used to reject form submission before any network call is made.
 */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

// ── Validation ────────────────────────────────────────────────────────────────

export interface SupportFormErrors {
  category?: string;
  resourceId?: string;
  transactionHash?: string;
  ipfsCid?: string;
  screenshotUrl?: string;
  description?: string;
  reporterAddress?: string;
  _secret?: string;
}

export interface SupportFormInput {
  category: SupportCategory | '';
  resourceId: string;
  transactionHash: string;
  ipfsCid: string;
  screenshotUrl: string;
  description: string;
  reporterAddress: string;
}

export function validateSupportForm(input: SupportFormInput): SupportFormErrors {
  const errors: SupportFormErrors = {};

  if (!input.category) {
    errors.category = 'Please select a report category.';
    return errors; // No point validating further without a category
  }

  const meta = SUPPORT_CATEGORIES[input.category as SupportCategory];

  // Check all fields for secrets first
  const allText = [
    input.resourceId, input.transactionHash, input.ipfsCid,
    input.screenshotUrl, input.description, input.reporterAddress,
  ].join(' ');
  if (containsSecret(allText)) {
    errors._secret =
      'Your submission appears to contain a private key or seed phrase. ' +
      'Never share secret keys with support. Please remove it and resubmit.';
    return errors;
  }

  if (meta.requiredEvidence.includes('resource_id') && !input.resourceId.trim()) {
    errors.resourceId = 'A listing or collection ID is required for this category.';
  }

  if (meta.requiredEvidence.includes('transaction_hash') && !input.transactionHash.trim()) {
    errors.transactionHash = 'A transaction hash is required for this category.';
  } else if (input.transactionHash && !/^[0-9a-fA-F]{64}$/.test(input.transactionHash.trim())) {
    errors.transactionHash = 'Transaction hash must be a 64-character hex string.';
  }

  if (meta.requiredEvidence.includes('ipfs_cid') && !input.ipfsCid.trim()) {
    errors.ipfsCid = 'An IPFS CID is required for this category.';
  }

  if (input.screenshotUrl && !/^https?:\/\//.test(input.screenshotUrl.trim())) {
    errors.screenshotUrl = 'Screenshot URL must start with https://.';
  }

  if (!input.description.trim() || input.description.trim().length < 20) {
    errors.description = 'Description must be at least 20 characters.';
  }
  if (input.description.trim().length > 2000) {
    errors.description = 'Description must be 2000 characters or fewer.';
  }

  if (input.reporterAddress && !/^G[A-Z2-7]{55}$/.test(input.reporterAddress.trim())) {
    errors.reporterAddress = 'Enter a valid Stellar public address (starts with G, 56 characters).';
  }

  return errors;
}
