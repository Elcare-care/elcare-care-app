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
