// ─────────────────────────────────────────────────────────────
// __tests__/i18n.test.ts — Unit tests for the i18n utility
// ─────────────────────────────────────────────────────────────

import {
  t,
  getLocale,
  setLocale,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  translations,
  type TranslationKey,
} from '@/lib/i18n';

// ── localStorage helpers ──────────────────────────────────────

const LOCALE_KEY = 'elcarehub_locale';

beforeEach(() => {
  localStorage.clear();
});

// ── Test: t() — English translations ─────────────────────────

describe('t() — core translation function', () => {
  it('returns an English string when locale is "en"', () => {
    expect(t('buy_now', 'en')).toBe('Buy Now');
    expect(t('nav_home', 'en')).toBe('Home');
    expect(t('connect_wallet', 'en')).toBe('Connect Wallet');
  });

  it('returns a Swahili string when locale is "sw"', () => {
    expect(t('buy_now', 'sw')).toBe('Nunua Sasa');
    expect(t('nav_home', 'sw')).toBe('Nyumbani');
    expect(t('connect_wallet', 'sw')).toBe('Unganisha Pochi');
  });

  it('falls back to English when the Swahili key is missing', () => {
    // Temporarily monkey-patch the sw translations to remove a key
    const swTranslations = translations.sw as Record<string, string>;
    const original = swTranslations['back'];
    delete swTranslations['back'];

    expect(t('back' as TranslationKey, 'sw')).toBe('Back'); // English fallback

    // Restore
    swTranslations['back'] = original;
  });

  it('uses getLocale() when no locale argument is supplied', () => {
    localStorage.setItem(LOCALE_KEY, 'sw');
    expect(t('buy_now')).toBe('Nunua Sasa');

    localStorage.setItem(LOCALE_KEY, 'en');
    expect(t('buy_now')).toBe('Buy Now');
  });
});

// ── Test: getLocale() ─────────────────────────────────────────

describe('getLocale()', () => {
  it('returns DEFAULT_LOCALE when localStorage is empty', () => {
    expect(getLocale()).toBe(DEFAULT_LOCALE);
  });

  it('returns the locale previously stored in localStorage', () => {
    localStorage.setItem(LOCALE_KEY, 'sw');
    expect(getLocale()).toBe('sw');
  });

  it('ignores an invalid locale value in localStorage and falls back to default', () => {
    localStorage.setItem(LOCALE_KEY, 'fr'); // unsupported
    expect(getLocale()).toBe(DEFAULT_LOCALE);
  });
});

// ── Test: setLocale() ─────────────────────────────────────────

describe('setLocale()', () => {
  it('stores the chosen locale in localStorage', () => {
    setLocale('sw');
    expect(localStorage.getItem(LOCALE_KEY)).toBe('sw');
  });

  it('can switch back to English', () => {
    setLocale('sw');
    setLocale('en');
    expect(localStorage.getItem(LOCALE_KEY)).toBe('en');
  });
});

// ── Test: catalog completeness ────────────────────────────────

describe('translation catalog completeness', () => {
  const enKeys = Object.keys(translations.en) as TranslationKey[];

  it('has at least 30 keys in the English catalog', () => {
    expect(enKeys.length).toBeGreaterThanOrEqual(30);
  });

  it('has matching keys in the Swahili catalog', () => {
    const swKeys = Object.keys(translations.sw);
    // Every English key should exist in Swahili
    for (const key of enKeys) {
      expect(swKeys).toContain(key);
    }
  });

  it('has non-empty strings for every key in both locales', () => {
    for (const loc of SUPPORTED_LOCALES) {
      const map = translations[loc] as Record<string, string>;
      for (const key of enKeys) {
        expect(typeof map[key]).toBe('string');
        expect(map[key].length).toBeGreaterThan(0);
      }
    }
  });

  it('contains all required navigation keys', () => {
    const navKeys = ['nav_home', 'nav_explore', 'nav_auctions', 'nav_launchpad', 'nav_profile', 'nav_admin', 'nav_help'];
    for (const key of navKeys) {
      expect(enKeys).toContain(key as TranslationKey);
    }
  });

  it('contains all required action keys', () => {
    const actionKeys = ['connect_wallet', 'disconnect', 'buy_now', 'place_bid', 'create_listing', 'cancel', 'save', 'edit'];
    for (const key of actionKeys) {
      expect(enKeys).toContain(key as TranslationKey);
    }
  });

  it('contains all required common/profile keys', () => {
    const miscKeys = ['search', 'filter', 'sort', 'empty_state_no_items', 'view_details', 'back', 'bio', 'display_name', 'earnings'];
    for (const key of miscKeys) {
      expect(enKeys).toContain(key as TranslationKey);
    }
  });
});
