// ─────────────────────────────────────────────────────────────────────────────
// lib/listingWizardDraft.ts — sessionStorage-backed draft for the listing
// creation wizard (Issue #526)
//
// The wizard walks a creator through several steps (collection, ownership,
// quantity, pricing, royalties, expiry, review) before ever asking a wallet
// to sign. A page reload, an accidental back-navigation, or a failed
// transaction should never force the creator to re-enter all of that.
//
// This module persists exactly the fields needed to resume the form —
// nothing else. No private keys or wallet secrets ever pass through it:
// Freighter/Lobstr/Magic never expose those to the app in the first place,
// and the only "sensitive-ish" values here are public Stellar addresses
// (the collection address and recipient addresses), which are already
// public on-chain once a listing is created. Storage is scoped to
// `sessionStorage` (cleared when the tab closes) and keyed per connected
// wallet so switching wallets never leaks one creator's draft into
// another's session.
// ─────────────────────────────────────────────────────────────────────────────

export interface ListingDraftRecipient {
  address: string;
  /** Display percentage (0–100), NOT basis points. Converted at submit time. */
  percentage: number;
}

export type ExpiryOption = "none" | "1d" | "7d" | "30d" | "custom";

export interface ListingWizardDraft {
  step: number;
  collectionAddress: string;
  editionMode: "single" | "multi";
  nftTokenId: string;
  quantity: string;
  price: string;
  tokenAddress: string;
  recipients: ListingDraftRecipient[];
  expiryOption: ExpiryOption;
  customExpiry: string;
}

const DRAFT_KEY_PREFIX = "elcarehub:listing-wizard-draft";

function draftKey(publicKey: string): string {
  return `${DRAFT_KEY_PREFIX}:${publicKey}`;
}

function getSessionStorage(): Storage | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage;
  } catch {
    // Some environments (SSR, certain private-browsing modes) throw on access
    return null;
  }
}

export function loadListingWizardDraft(publicKey: string | null): ListingWizardDraft | null {
  const storage = getSessionStorage();
  if (!publicKey || !storage) return null;
  try {
    const raw = storage.getItem(draftKey(publicKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as ListingWizardDraft;
  } catch {
    return null;
  }
}

export function saveListingWizardDraft(publicKey: string, draft: ListingWizardDraft): void {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(draftKey(publicKey), JSON.stringify(draft));
  } catch {
    // Storage unavailable or quota exceeded — silently skip persistence,
    // the in-memory form state still works for the current page session.
  }
}

export function clearListingWizardDraft(publicKey: string | null): void {
  const storage = getSessionStorage();
  if (!publicKey || !storage) return;
  try {
    storage.removeItem(draftKey(publicKey));
  } catch {
    // ignore
  }
}
