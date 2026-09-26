// ─────────────────────────────────────────────────────────────
// components/LocaleSwitcher.tsx — Language toggle for the Navbar
//
// Renders a compact accessible toggle between 🇬🇧 EN and 🇰🇪 SW.
// Uses a radio group pattern for full keyboard and screen-reader
// accessibility. Styled to fit the dark navbar theme.
// ─────────────────────────────────────────────────────────────

'use client';

import { useLocale } from '@/hooks/useLocale';
import { type Locale, SUPPORTED_LOCALES } from '@/lib/i18n';

const LOCALE_META: Record<Locale, { flag: string; label: string }> = {
  en: { flag: '🇬🇧', label: 'EN' },
  sw: { flag: '🇰🇪', label: 'SW' },
};

export function LocaleSwitcher() {
  const { locale, setLocale } = useLocale();

  return (
    <div
      role="radiogroup"
      aria-label="Language selector"
      className="flex items-center gap-0.5 rounded-lg bg-white/5 border border-white/10 p-0.5"
    >
      {SUPPORTED_LOCALES.map((loc) => {
        const { flag, label } = LOCALE_META[loc];
        const isActive = locale === loc;

        return (
          <button
            key={loc}
            role="radio"
            aria-checked={isActive}
            aria-label={`Switch language to ${label}`}
            onClick={() => setLocale(loc)}
            data-testid={`locale-${loc}`}
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold transition-all duration-200 ${
              isActive
                ? 'bg-brand-500/30 text-white shadow-sm'
                : 'text-white/45 hover:text-white/80 hover:bg-white/5'
            }`}
          >
            <span aria-hidden="true">{flag}</span>
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
