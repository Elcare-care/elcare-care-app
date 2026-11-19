// ─────────────────────────────────────────────────────────────
// lib/i18n.ts — Lightweight i18n utility (no middleware required)
//
// A custom translation layer that works cleanly with the existing
// Next.js 14 App Router setup without touching routing or middleware.
// Locale is persisted in localStorage and falls back to the browser
// language, then the default 'en' locale.
// ─────────────────────────────────────────────────────────────

// ── Supported locales ─────────────────────────────────────────

export type Locale = 'en' | 'sw';
export const DEFAULT_LOCALE: Locale = 'en';
export const SUPPORTED_LOCALES: Locale[] = ['en', 'sw'];

const LOCALE_STORAGE_KEY = 'elcarehub_locale';

// ── Translation catalog ───────────────────────────────────────

export const translations = {
  en: {
    // navigation
    nav_home: 'Home',
    nav_explore: 'Explore',
    nav_auctions: 'Auctions',
    nav_launchpad: 'Launchpad',
    nav_profile: 'Profile',
    nav_admin: 'Admin',
    nav_help: 'Help',

    // actions
    connect_wallet: 'Connect Wallet',
    disconnect: 'Disconnect',
    buy_now: 'Buy Now',
    place_bid: 'Place Bid',
    create_listing: 'Create Listing',
    cancel: 'Cancel',
    save: 'Save',
    edit: 'Edit',

    // status
    loading: 'Loading…',
    error: 'Error',
    success: 'Success',
    pending: 'Pending',
    approved: 'Approved',
    rejected: 'Rejected',

    // marketplace
    listings: 'Listings',
    collections: 'Collections',
    auctions: 'Auctions',
    offers: 'Offers',
    price: 'Price',
    royalties: 'Royalties',

    // profile
    bio: 'Bio',
    display_name: 'Display Name',
    social_links: 'Social Links',
    earnings: 'Earnings',
    activity: 'Activity',
    purchased: 'Purchased',
    sold: 'Sold',

    // common
    search: 'Search',
    filter: 'Filter',
    sort: 'Sort',
    empty_state_no_items: 'No items found',
    view_details: 'View Details',
    back: 'Back',

    // wizard
    wizard_step: 'Step',
    wizard_of: 'of',
    wizard_current_step: 'Current step',
    wizard_step_complete: 'completed',
    wizard_step_current: 'current',
    wizard_step_remaining: 'remaining',

    // transaction pending states — {action} is replaced with the localized
    // operation label (see tx_action_* keys)
    tx_action_transaction: 'transaction',
    tx_action_bid: 'your bid',
    tx_action_finalize_auction: 'the auction finalization',
    tx_action_create_auction: 'your new auction',
    tx_action_create_listing: 'your new listing',
    tx_action_purchase: 'your purchase',
    tx_action_listing: 'the listing',
    tx_action_auction: 'the auction',
    tx_action_offer: 'the offer',
    tx_action_place_offer: 'your offer',
    tx_action_accept_offer: 'the offer acceptance',
    tx_action_reject_offer: 'the offer rejection',
    tx_action_withdraw_offer: 'the offer withdrawal',
    tx_action_reclaim_offer: 'the offer fund reclaim',
    tx_action_cancel_auction: 'the auction cancellation',
    tx_action_claim_refund: 'your refund claim',
    tx_action_cancel_listing: 'the listing cancellation',
    tx_action_cancel_listings: 'the listings cancellation',
    tx_action_update_listing: 'the listing update',
    tx_action_deploy_collection: 'the collection deployment',
    tx_action_mint: 'the mint',
    tx_action_redeem: 'the voucher redemption',
    tx_action_transfer: 'the transfer',
    tx_state_idle: 'Ready',
    tx_state_simulating: 'Preparing {action}…',
    tx_state_signing: 'Waiting for your wallet signature for {action}…',
    tx_state_broadcasting: 'Submitting {action} to the network — this page will update once the ledger confirms…',
    tx_state_confirming: 'Confirming {action} on-chain — this page will update once the ledger confirms…',
    tx_state_indexer_pending: 'Ledger confirmation received for {action} — waiting for the indexer to update this page…',
    tx_state_success: 'Success — {action} confirmed!',
    tx_state_failed: 'Failed',
    tx_short_simulating: 'Preparing {action}…',
    tx_short_signing: 'Awaiting signature for {action}…',
    tx_short_broadcasting: 'Submitting {action}…',
    tx_short_confirming: 'Confirming {action}…',
    tx_short_indexer_pending: 'Waiting for indexer…',
    tx_short_success: 'Confirmed!',
    tx_short_failed: 'Failed',
    tx_short_idle: 'Ready',

    // offer submission pending states
    offer_pending_status: 'Placing your offer — check your wallet for a signature request. This page will update once the ledger confirms.',
    offer_pending_button: 'Placing offer…',

    // listing / auction creation progress
    progress_validating_token: 'Validating payment token…',
    progress_creating_listing: 'Creating on-chain listing — this page will update once the ledger confirms…',
    progress_listing_created: 'Listing created successfully!',
    progress_updating_listing: 'Updating on-chain listing — this page will update once the ledger confirms…',
    progress_listing_updated: 'Listing updated successfully!',
    progress_uploading_new_image: 'Uploading new image to IPFS…',
    progress_uploading_new_metadata: 'Uploading new metadata to IPFS…',
    progress_uploading_image: 'Uploading image to IPFS…',
    progress_uploading_metadata: 'Uploading metadata to IPFS…',
    progress_creating_auction: 'Creating on-chain auction — this page will update once the ledger confirms…',
    progress_auction_created: 'Auction created successfully!',

    // launchpad pending states
    launchpad_deploy_pending_status: 'Deploying your collection — check your wallet for a signature request. This page will update once the ledger confirms.',
    launchpad_deploy_pending_button: 'Deploying collection…',
    launchpad_mint_pending: 'Minting — check your wallet for a signature request. This page will update once the ledger confirms.',
    launchpad_redeem_pending: 'Redeeming voucher — check your wallet for a signature request. This page will update once the ledger confirms.',
    launchpad_pending_checking: 'Checking…',
    launchpad_pending_signing: 'Awaiting wallet signature…',
    launchpad_admin_pending: 'Processing admin action — this page will update once the ledger confirms.',

    // provisional / pending-confirmation badge
    provisional_pending_label: 'Pending confirmation',
    provisional_pending_title: 'This transaction was just submitted and is shown optimistically. It has not yet been confirmed by the indexer — the UI will update after ledger confirmation.',
    provisional_stale_label: 'Confirmation delayed',
    provisional_stale_title: 'This transaction is taking longer than expected to confirm. The value shown may not reflect the latest on-chain state.',
    provisional_rejected_label: 'Update reverted',
    provisional_rejected_title: 'This transaction failed or was rolled back — showing the last confirmed value.',

    // success notifications — outcome-specific next-action guidance
    tx_guidance_purchase: 'Next: find it under Profile → Purchased, or share it with collectors.',
    tx_guidance_listing: 'Next: share your listing link or track it from your profile.',
    tx_guidance_auction_create: 'Next: share your auction link — bids will appear here as they arrive.',
    tx_guidance_bid: 'Next: the auction updates automatically — check the highest bid above.',
    tx_guidance_offer: 'Next: track the response under Offers — the owner can accept or reject.',
    tx_guidance_offer_response: 'Next: the offer status updates automatically once the indexer confirms.',
    tx_guidance_finalize: 'Next: the sale is settling on-chain — the winner and payout appear shortly.',
    tx_guidance_cancel: 'Next: escrowed funds and the NFT are returning to their owners on-chain.',
    tx_guidance_refund: 'Next: your refund is returning to your wallet on-chain.',
    tx_guidance_generic: 'Next: refresh the page to see the latest on-chain state.',
    tx_success_view_explorer: 'View on explorer',
    bid_success_status: 'Bid placed! Next: the auction updates automatically — check the highest bid above.',
    finalize_success_status: 'Auction finalized! Next: the sale is settling on-chain — the winner and payout appear shortly.',
    offer_success_status: 'Offer placed! Next: track the response under Offers — the owner can accept or reject.',
    offer_placed_button: 'Offer placed!',
    offer_withdrawn_success: 'Offer withdrawn! Next: the escrowed funds return to your wallet on-chain.',
    offer_reclaimed_success: 'Funds reclaimed! Next: the refund is settling on-chain.',
    offer_accepted_success: 'Offer accepted! Next: the sale is settling on-chain — payout appears shortly.',
    offer_rejected_success: 'Offer rejected! Next: the offer status updates automatically once the indexer confirms.',
    purchase_success_status: 'Purchase successful! Next: find it under Profile → Purchased, or share it with collectors.',
    launchpad_deploy_success: 'Collection deployed! Next: share your collection link or start minting.',
  },
  sw: {
    // navigation — Swahili
    nav_home: 'Nyumbani',
    nav_explore: 'Gundua',
    nav_auctions: 'Minada',
    nav_launchpad: 'Uzinduzi',
    nav_profile: 'Wasifu',
    nav_admin: 'Msimamizi',
    nav_help: 'Msaada',

    // actions
    connect_wallet: 'Unganisha Pochi',
    disconnect: 'Tenganisha',
    buy_now: 'Nunua Sasa',
    place_bid: 'Weka Zabuni',
    create_listing: 'Unda Tangazo',
    cancel: 'Ghairi',
    save: 'Hifadhi',
    edit: 'Hariri',

    // status
    loading: 'Inapakia…',
    error: 'Hitilafu',
    success: 'Imefanikishwa',
    pending: 'Inasubiri',
    approved: 'Imeidhinishwa',
    rejected: 'Imekataliwa',

    // marketplace
    listings: 'Matangazo',
    collections: 'Makusanyo',
    auctions: 'Minada',
    offers: 'Mapendekezo',
    price: 'Bei',
    royalties: 'Mrabaha',

    // profile
    bio: 'Wasifu Mfupi',
    display_name: 'Jina la Kuonyesha',
    social_links: 'Viungo vya Mtandao',
    earnings: 'Mapato',
    activity: 'Shughuli',
    purchased: 'Vilivyonunuliwa',
    sold: 'Vilivyouzwa',

    // common
    search: 'Tafuta',
    filter: 'Chuja',
    sort: 'Panga',
    empty_state_no_items: 'Hakuna vitu vilivyopatikana',
    view_details: 'Angalia Maelezo',
    back: 'Rudi',

    // wizard
    wizard_step: 'Hatua',
    wizard_of: 'ya',
    wizard_current_step: 'Hatua ya sasa',
    wizard_step_complete: 'imekamilika',
    wizard_step_current: 'ya sasa',
    wizard_step_remaining: 'zinazobaki',

    // transaction pending states — {action} hubadilishwa na lebo ya kitendo
    // iliyotafsiriwa (tazama funguo za tx_action_*)
    tx_action_transaction: 'muamala',
    tx_action_bid: 'zabuni yako',
    tx_action_finalize_auction: 'ukamilishaji wa mnada',
    tx_action_create_auction: 'mnada wako mpya',
    tx_action_create_listing: 'tangazo lako jipya',
    tx_action_purchase: 'ununuzi wako',
    tx_action_listing: 'tangazo',
    tx_action_auction: 'mnada',
    tx_action_offer: 'ofa',
    tx_action_place_offer: 'ofa yako',
    tx_action_accept_offer: 'kukubali ofa',
    tx_action_reject_offer: 'kukataa ofa',
    tx_action_withdraw_offer: 'kutoa ofa',
    tx_action_reclaim_offer: 'kurejesha fedha za ofa',
    tx_action_cancel_auction: 'kughairi mnada',
    tx_action_claim_refund: 'dai lako la marejesho',
    tx_action_cancel_listing: 'kughairi tangazo',
    tx_action_cancel_listings: 'kughairi matangazo',
    tx_action_update_listing: 'sasisho la tangazo',
    tx_action_deploy_collection: 'usambazaji wa makusanyo',
    tx_action_mint: 'utoaji',
    tx_action_redeem: 'ukombozi wa vocha',
    tx_action_transfer: 'uhamisho',
    tx_state_idle: 'Tayari',
    tx_state_simulating: 'Inaandaa {action}…',
    tx_state_signing: 'Inasubiri saini yako ya pochi kwa {action}…',
    tx_state_broadcasting: 'Inawasilisha {action} kwenye mtandao — ukurasa huu utasasishwa baada ya ledger kuthibitisha…',
    tx_state_confirming: 'Inathibitisha {action} — ukurasa huu utasasishwa baada ya ledger kuthibitisha…',
    tx_state_indexer_pending: 'Uthibitisho wa ledger umepokelewa kwa {action} — inasubiri indexer kusasisha ukurasa huu…',
    tx_state_success: 'Imekamilika — {action} imethibitishwa!',
    tx_state_failed: 'Imeshindikana',
    tx_short_simulating: 'Inaandaa {action}…',
    tx_short_signing: 'Inasubiri saini kwa {action}…',
    tx_short_broadcasting: 'Inawasilisha {action}…',
    tx_short_confirming: 'Inathibitisha {action}…',
    tx_short_indexer_pending: 'Inasubiri indexer…',
    tx_short_success: 'Imethibitishwa!',
    tx_short_failed: 'Imeshindikana',
    tx_short_idle: 'Tayari',

    // offer submission pending states
    offer_pending_status: 'Inaweka ofa yako — angalia pochi yako kwa ombi la saini. Ukurasa huu utasasishwa baada ya ledger kuthibitisha.',
    offer_pending_button: 'Inaweka ofa…',

    // listing / auction creation progress
    progress_validating_token: 'Inaidhinisha token ya malipo…',
    progress_creating_listing: 'Inaunda tangazo kwenye chain — ukurasa huu utasasishwa baada ya ledger kuthibitisha…',
    progress_listing_created: 'Tangazo limeundwa!',
    progress_updating_listing: 'Inasasisha tangazo kwenye chain — ukurasa huu utasasishwa baada ya ledger kuthibitisha…',
    progress_listing_updated: 'Tangazo limesasishwa!',
    progress_uploading_new_image: 'Inapakia picha mpya kwenye IPFS…',
    progress_uploading_new_metadata: 'Inapakia metadata mpya kwenye IPFS…',
    progress_uploading_image: 'Inapakia picha kwenye IPFS…',
    progress_uploading_metadata: 'Inapakia metadata kwenye IPFS…',
    progress_creating_auction: 'Inaunda mnada kwenye chain — ukurasa huu utasasishwa baada ya ledger kuthibitisha…',
    progress_auction_created: 'Mnada umeundwa!',

    // launchpad pending states
    launchpad_deploy_pending_status: 'Inasambaza mkusanyo wako — angalia pochi yako kwa ombi la saini. Ukurasa huu utasasishwa baada ya ledger kuthibitisha.',
    launchpad_deploy_pending_button: 'Inasambaza mkusanyo…',
    launchpad_mint_pending: 'Inatoa NFT — angalia pochi yako kwa ombi la saini. Ukurasa huu utasasishwa baada ya ledger kuthibitisha.',
    launchpad_redeem_pending: 'Inakomboa vocha — angalia pochi yako kwa ombi la saini. Ukurasa huu utasasishwa baada ya ledger kuthibitisha.',
    launchpad_pending_checking: 'Inakagua…',
    launchpad_pending_signing: 'Inasubiri saini ya pochi…',
    launchpad_admin_pending: 'Inachakata kitendo cha msimamizi — ukurasa huu utasasishwa baada ya ledger kuthibitisha.',

    // provisional / pending-confirmation badge
    provisional_pending_label: 'Inasubiri uthibitisho',
    provisional_pending_title: 'Muamala huu umewasilishwa hivi punde na unaonyeshwa kwa mpangilio wa kimatathabu. Bado haujathibitishwa na indexer — UI itasasishwa baada ya ledger kuthibitisha.',
    provisional_stale_label: 'Uthibitisho umcheleweshwa',
    provisional_stale_title: 'Muamala huu unachukua muda mrefu kuliko kawaida kuthibitishwa. Thamani iliyoonyeshwa huenda isilingane na hali ya hivi karibuni kwenye chain.',
    provisional_rejected_label: 'Sasisho limebatilishwa',
    provisional_rejected_title: 'Muamala huu umeshindwa au umeirudishwa — inaonyesha thamani ya mwisho iliyothibitishwa.',

    // success notifications — outcome-specific next-action guidance
    tx_guidance_purchase: 'Inayofuata: ipate chini ya Wasifu → Vilivyonunuliwa, au ishiriki na wakusanyaji.',
    tx_guidance_listing: 'Inayofuata: shiriki kiungo cha tangazo lako au kufuatilia kutoka wasifu wako.',
    tx_guidance_auction_create: 'Inayofuata: shiriki kiungo cha mnada wako — zabuni zitaonekana hapa zinapofika.',
    tx_guidance_bid: 'Inayofuata: mnada husasishwa kiotomatiki — kagua zabuni ya juu hapo juu.',
    tx_guidance_offer: 'Inayofuata: fuatilia jibu chini ya Ofa — mmiliki anaweza kukubali au kukataa.',
    tx_guidance_offer_response: 'Inayofuata: hali ya ofa husasishwa kiotomatiki indexer inapothibitisha.',
    tx_guidance_finalize: 'Inayofuata: mauzo yanaisha kwenye chain — mshindi na malipo yataonekana hivi karibuni.',
    tx_guidance_cancel: 'Inayofuata: fedha zilizowekwa na NFT zinarudi kwa wamiliki wao kwenye chain.',
    tx_guidance_refund: 'Inayofuata: marejesho yako yanarudi kwenye pochi yako kwenye chain.',
    tx_guidance_generic: 'Inayofuata: onyesha upya ukurasa kuona hali ya hivi karibuni kwenye chain.',
    tx_success_view_explorer: 'Tazama kwenye explorer',
    bid_success_status: 'Zabuni imewekwa! Inayofuata: mnada husasishwa kiotomatiki — kagua zabuni ya juu hapo juu.',
    finalize_success_status: 'Mnada umekamilishwa! Inayofuata: mauzo yanaisha kwenye chain — mshindi na malipo yataonekana hivi karibuni.',
    offer_success_status: 'Ofa imewekwa! Inayofuata: fuatilia jibu chini ya Ofa — mmiliki anaweza kukubali au kukataa.',
    offer_placed_button: 'Ofa imewekwa!',
    offer_withdrawn_success: 'Ofa imeondolewa! Inayofuata: fedha zilizowekwa zinarudi kwenye pochi yako kwenye chain.',
    offer_reclaimed_success: 'Fedha zimerudishwa! Inayofuata: marejesho yanaisha kwenye chain.',
    offer_accepted_success: 'Ofa imekubaliwa! Inayofuata: mauzo yanaisha kwenye chain — malipo yataonekana hivi karibuni.',
    offer_rejected_success: 'Ofa imekataliwa! Inayofuata: hali ya ofa husasishwa kiotomatiki indexer inapothibitisha.',
    purchase_success_status: 'Ununuzi umefanikiwa! Inayofuata: ipate chini ya Wasifu → Vilivyonunuliwa, au ishiriki na wakusanyaji.',
    launchpad_deploy_success: 'Mkusanyo umetumwa! Inayofuata: shiriki kiungo cha mkusanyo wako au anza kutoa NFT.',
  },
} as const;

// ── Type helpers ──────────────────────────────────────────────

export type TranslationKey = keyof typeof translations.en;

// ── Locale persistence ────────────────────────────────────────

/**
 * Returns the active locale. Priority order:
 *   1. localStorage value (user explicit choice)
 *   2. Browser language header (first matching supported locale)
 *   3. DEFAULT_LOCALE ('en')
 *
 * Guards against SSR — returns DEFAULT_LOCALE when window is unavailable.
 */
export function getLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;

  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY) as Locale | null;
    if (stored && SUPPORTED_LOCALES.includes(stored)) return stored;
  } catch {
    // localStorage may be blocked (private mode, security policy, etc.)
  }

  // Fallback: match browser language
  const browserLang = navigator.language?.split('-')[0] as Locale;
  if (SUPPORTED_LOCALES.includes(browserLang)) return browserLang;

  return DEFAULT_LOCALE;
}

/**
 * Persists the chosen locale to localStorage.
 * No-op on the server.
 */
export function setLocale(locale: Locale): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Silently ignore storage errors
  }
}

// ── Core translate function ───────────────────────────────────

/**
 * Returns the translated string for `key` in the given `locale`.
 * Falls back to English if the key is missing in the requested locale.
 * Falls back to the key itself if even English is missing.
 *
 * @example
 *   t('buy_now')          // uses getLocale() — e.g. 'Nunua Sasa' in sw
 *   t('buy_now', 'en')    // always 'Buy Now'
 */
export function t(key: TranslationKey, locale?: Locale): string {
  const resolvedLocale = locale ?? getLocale();
  const localeMap = translations[resolvedLocale] as Record<string, string>;
  if (localeMap[key] !== undefined) return localeMap[key];

  // Fallback to English
  const enMap = translations.en as Record<string, string>;
  if (enMap[key] !== undefined) return enMap[key];

  // Last resort: return the key itself
  return key;
}
