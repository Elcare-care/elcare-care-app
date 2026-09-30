// ─────────────────────────────────────────────────────────────
// hooks/useLocale.ts — React hook for i18n locale management
//
// Hydrates from localStorage on mount and exposes a stable
// `setLocale` callback so consumer re-renders are minimal.
// ─────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import {
  type Locale,
  type TranslationKey,
  getLocale,
  setLocale as persistLocale,
  t as translate,
} from '@/lib/i18n';

export interface UseLocaleReturn {
  /** Currently active locale */
  locale: Locale;
  /** Switch the active locale (updates state + persists to localStorage) */
  setLocale: (locale: Locale) => void;
  /** Translate a key using the currently active locale */
  t: (key: TranslationKey) => string;
}

export function useLocale(): UseLocaleReturn {
  // Start with 'en' for SSR safety; hydrate on the client in useEffect
  const [locale, setLocaleState] = useState<Locale>('en');

  // Hydrate from localStorage (or browser lang) after mount
  useEffect(() => {
    setLocaleState(getLocale());
  }, []);

  const setLocale = useCallback((newLocale: Locale) => {
    persistLocale(newLocale);
    setLocaleState(newLocale);
  }, []);

  const t = useCallback(
    (key: TranslationKey) => translate(key, locale),
    [locale],
  );

  return { locale, setLocale, t };
}
