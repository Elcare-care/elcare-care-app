# Issue #1055 — Locale-aware locale switcher confirmation

**Category:** Frontend UX and Accessibility
**Affected:** `Navbar` → `LocaleSwitcher` (every route)

## Goal

Switching between English and Kiswahili:

- applies immediately,
- keeps the user on the same route, with the same query, hash and scroll position,
- is confirmed to assistive tech in the **new** language, and
- falls back to English for any missing key, never to a raw key.

## How locale works today

The issue text mentions Next Intl, but **this app does not use `next-intl`**.
Localization is a custom lightweight layer:

| Piece | File | Role |
|-------|------|------|
| Catalog + `t()` | `src/lib/i18n.ts` | `translations.en` / `translations.sw`, `getLocale`, `setLocale`, `t(key, locale)` with English then key fallback |
| Hook | `src/hooks/useLocale.ts` | React state hydrated from `localStorage` (`elcarehub_locale`) or the browser language; exposes `{ locale, setLocale, t }` |
| Switcher | `src/components/LocaleSwitcher.tsx` | `role="radiogroup"` with two `role="radio"` buttons (EN / SW), rendered in `Navbar.tsx` |
| JSON mirrors | `messages/en.json`, `messages/sw.json` | Not imported at runtime. Keep them in sync with `i18n.ts`. |

The locale is not part of the URL; there is no `/sw/...` segment and no
middleware. That makes route persistence easy: switching never navigates.
Use this existing state. Do **not** introduce `next-intl`, a context store,
or locale-prefixed routes for this issue.

## Current behavior (audit)

1. **Each component has its own locale state.** `useLocale()` keeps its own
   `useState`, so the switcher updates only its own instance. Other
   components that call `useLocale()` (and anything calling `t()` directly)
   keep the old language until they remount or the page reloads. This is
   the main reason switching doesn't feel immediate.
2. **English-only accessible name.** The group label is the hard-coded
   string `` `Language selector, current language: ${language}` ``, which
   stays English even after switching to Kiswahili.
3. **No confirmation.** After switching, nothing is announced. Sighted users
   see the pill change; screen-reader users get only the `aria-checked`
   change on the button they pressed.
4. **Radio group keyboard pattern is incomplete.** Both buttons are in the
   Tab order, and arrow keys do nothing. The WAI-ARIA radio group pattern
   expects a roving `tabIndex` (only the checked radio is tabbable) and
   Arrow Left/Right/Up/Down to move and select.
5. **`<html lang>` is not updated**, so screen readers keep using the English
   voice for Kiswahili text.

## Implementation plan

1. **Shared locale state (minimal).** Make `useLocale` subscribe to a single
   module-level source, using `useSyncExternalStore` over a small listener
   set in `src/lib/i18n.ts`, with `setLocale` notifying listeners. Also
   listen to the `storage` event so other tabs follow. This keeps the
   existing API (`{ locale, setLocale, t }`) and adds no provider.
2. **Same route.** `setLocale` must only update state and `localStorage`. It
   must not call `router.push`, `router.refresh` or `location.reload`, so the
   pathname, query, hash, scroll position, form inputs and wallet
   connection all survive. Add a test that guards this.
3. **Document language.** On locale change, set
   `document.documentElement.lang = locale` (`en` / `sw`).
4. **Accessible names (localized).**
   - Group: `aria-label={t('locale_switcher_label')}`, for example
     "Language" / "Lugha".
   - Each radio: the language's **own** name ("English", "Kiswahili") with
     `lang` set on the element, so it is pronounced correctly in either UI
     language.
   - Active state: keep `aria-checked`. Visible active styling must not rely
     on colour alone; keep the filled pill and ensure ≥ 4.5:1 text contrast
     on the dark navbar (`text-white/45` on the inactive item is borderline,
     so check it).
5. **Confirmation.** Mount one `StatusAnnouncer`
   (`src/components/a11y/StatusAnnouncer.tsx`, polite) inside the switcher.
   After a change, set its message to `t('locale_switched', newLocale)`,
   for example "Language changed to English" / "Lugha imebadilishwa kuwa
   Kiswahili". Don't announce on the initial hydration.
6. **Keyboard.** Use a roving `tabIndex` (`0` on the checked radio, `-1` on
   the other). Arrow keys move focus and select. Home/End jump to the first
   or last radio. Focus stays on the switcher after selection; it must not
   jump to the top of the page. Escape has no role here and must not be
   swallowed (it should still close any open navbar menu).
7. **Fallback copy.** Keep `t()`'s English fallback. Add a dev-only
   `console.warn` when a key is missing in `sw` so gaps are visible. Add a
   unit test that asserts the `en` and `sw` key sets match, so a raw key
   never reaches the UI.

### New locale keys (en / sw)

| Key | en | sw |
|-----|----|----|
| `locale_switcher_label` | Language | Lugha |
| `locale_current` | Current language: {language} | Lugha ya sasa: {language} |
| `locale_switched` | Language changed to {language} | Lugha imebadilishwa kuwa {language} |

Have a Kiswahili speaker review the `sw` copy before merge.

## Tests

| Kind | File | Cases |
|------|------|-------|
| Unit | `src/__tests__/LocaleSwitcher.test.tsx` (extend) | Localized group label in en and sw; radios carry their own `lang`; roving tabIndex; ArrowRight/Left/Home/End select and move focus; announcer message after a switch but not on mount; `document.documentElement.lang` updates |
| Unit | `src/__tests__/i18n.test.ts` (extend) | `en` and `sw` key sets match; missing-key fallback returns English, not the key; a second `useLocale()` consumer re-renders on switch |
| a11y | `npm run test:a11y` | jest-axe on `LocaleSwitcher` in both locales |
| E2E | `tests/e2e/a11y-keyboard.spec.ts` (or a new `locale-switch.spec.ts`) | On `/auctions/[id]?tab=bids`, switch to SW: URL unchanged, nav text is Kiswahili, `html[lang="sw"]`, reload keeps SW; keyboard-only switch |

```bash
cd frontend/elcarehub-app
npx jest src/__tests__/LocaleSwitcher.test.tsx src/__tests__/i18n.test.ts
npm run test:a11y
npx playwright test tests/e2e/a11y-keyboard.spec.ts
```

## Acceptance checklist

- [ ] Switching updates every visible translated string immediately, with no reload or navigation.
- [ ] Route, query, hash, scroll position and wallet state persist. The choice survives a reload.
- [ ] The switcher's accessible name and confirmation are localized. `<html lang>` follows the locale.
- [ ] Radio-group keyboard pattern works. Focus stays on the switcher. Escape behavior is unchanged.
- [ ] No raw keys, placeholders or `undefined` appear in either locale.
- [ ] The tests above pass. No other route behavior changes.
