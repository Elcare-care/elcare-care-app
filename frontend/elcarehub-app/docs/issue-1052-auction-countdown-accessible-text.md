# Issue #1052 — Auction countdown accessible text

**Category:** Frontend UX and Accessibility
**Affected routes:** `/auctions`, `/auctions/[id]`

## Goal

Every visual auction countdown needs a stable text equivalent for screen
readers. The live region must announce only at meaningful thresholds, never
once per second.

## Current behavior (audit)

The app has three countdown implementations:

| Location | Implementation | Screen-reader output today |
|----------|----------------|----------------------------|
| `src/app/auctions/[id]/page.tsx` | `useAuctionCountdown` + `Countdown` (drift-corrected via `useServerClock`, absorbs SSE extensions) | Four separate digit boxes ("05", "Days", "03", "Hours"…). There is no combined label and no live region. |
| `src/components/BiddingPanel.tsx` | Local `useCountdown` hook | Same box layout plus a compact `HH:MM:SS` string. There is no label and no live region. |
| `src/app/auctions/page.tsx` | `TimeRemaining` (local clock only, no server offset) | A raw `1d 03:12:44` string with no label. |

Problems found:

1. **Unclear text.** A screen reader reads the digit boxes as unrelated
   numbers. Assistive tech gets no single string like "2 days, 3 hours
   remaining".
2. **No threshold announcements.** A screen-reader user is never told when an
   auction is about to end or has ended. The "Auction Ended" badge appears
   without being announced.
3. **BiddingPanel countdown visibility bug.** The countdown in
   `BiddingPanel.tsx` renders only when `isActive && !isExpired`. Here
   `isActive` is the **transaction-lifecycle** flag from `useTxLifecycle`,
   not the auction status. So the countdown shows only while a bid or
   finalize transaction is in flight. The condition should use
   `isAuctionActive`. Fix this as part of the issue, because the accessible
   text depends on the countdown actually rendering.
4. **Duplicated logic.** Three countdown hooks drift apart. For example,
   `TimeRemaining` ignores the server clock offset.
5. **Hard-coded English labels.** "Days", "Hours", "Min", "Sec", "Auction
   Ended" and "Expired" are not in the locale catalog.

## Implementation plan

Reuse what exists. Do not add a new announcer or timer library.

1. **Single source of truth.** Use `useAuctionCountdown` / `Countdown` from
   `app/auctions/[id]/page.tsx` as the canonical countdown. Move the hook to
   `src/hooks/useAuctionCountdown.ts` and re-export it from the page so the
   existing imports in `__tests__/auctionCountdownBoundary.test.tsx` keep
   working. Have `BiddingPanel` and `TimeRemaining` consume it.
2. **Stable text label.** Add a pure helper, for example
   `formatCountdownLabel(remaining, locale)` in `src/lib/format.ts`, that
   returns a concise phrase using the two most significant units:
   - `≥ 1 day` → "2 days, 3 hours remaining"
   - `≥ 1 hour` → "3 hours, 12 minutes remaining"
   - `≥ 1 minute` → "12 minutes remaining"
   - `< 1 minute` → "Less than a minute remaining"
   - `0` → "Auction ended"

   Apply it as the `aria-label` on the countdown container
   (`role="timer"`). Mark the visual digit boxes `aria-hidden="true"`.
   The label rounds to minutes, so it does not change every second.
   `role="timer"` is implicitly `aria-live="off"`, so the label is read on
   focus or navigation, not on every tick.
3. **Throttled announcements.** Add one `StatusAnnouncer`
   (`src/components/a11y/StatusAnnouncer.tsx`) next to the countdown. Set
   its message only when the countdown crosses a threshold:

   | Threshold | Message | Politeness |
   |-----------|---------|------------|
   | 1 hour left | "1 hour remaining in this auction" | polite |
   | 15 minutes left | "15 minutes remaining" | polite |
   | 5 minutes left | "5 minutes remaining" | polite |
   | 1 minute left | "Less than a minute remaining" | polite |
   | Ended | "Auction ended. Bidding is closed." | polite |
   | End time extended (SSE `onExtend`) | "Auction extended. New end time: …" | polite |

   Track the last announced threshold in a ref. A remount, or an SSE
   extension that moves the countdown back above a threshold, must not
   repeat the same announcement. Do not use `assertive`; failures are the
   only place this project uses it.
4. **Locale keys.** Add these keys to both `en` and `sw` in
   `src/lib/i18n.ts` (the app's live catalog) and to the
   `messages/en.json` / `messages/sw.json` mirrors:
   `countdown_days`, `countdown_hours`, `countdown_minutes`,
   `countdown_seconds`, `countdown_remaining_label`,
   `countdown_less_than_minute`, `countdown_ended`,
   `countdown_threshold_announcement`, `countdown_extended`. Pluralization
   is needed: Swahili "siku 1 / siku 2" is unchanged, but English is not.
   Keep separate singular and plural keys rather than adding an ICU library.
5. **Reduced motion.** The countdown has no animation, but check that
   `useReducedMotion()` users still see the static text label. Any future
   "pulse when < 1 minute" styling must be gated behind the hook (see
   `docs/accessibility/ACCESSIBILITY.md` → *Reduced motion*).

## Tests

| Kind | File | Cases |
|------|------|-------|
| Unit | `src/__tests__/format.test.ts` | `formatCountdownLabel` at 0 s, 59 s, 60 s, 3599 s, 3600 s, 86399 s, 86400 s, multi-day; en and sw output; singular and plural |
| Unit | `src/__tests__/auctionCountdownBoundary.test.tsx` (extend) | `role="timer"` with a non-empty `aria-label`; digit boxes `aria-hidden`; announcer fires once per threshold under `jest.useFakeTimers()`; no announcement on ordinary ticks; extension does not re-announce a threshold already passed |
| Unit | `src/__tests__/BiddingPanel.test.tsx` | Countdown renders for an active auction with **no** transaction in flight (regression for bug #3) |
| a11y | `npm run test:a11y` | jest-axe passes on `Countdown` and `BiddingPanel` |
| E2E | `tests/e2e/auction-flow.spec.ts`, `tests/e2e/a11y.spec.ts` | Countdown exposes `getByRole('timer')` with a readable name; reduced-motion project still shows the label |

Smallest command set:

```bash
cd frontend/elcarehub-app
npx jest src/__tests__/auctionCountdownBoundary.test.tsx src/__tests__/BiddingPanel.test.tsx src/__tests__/format.test.ts
npm run test:a11y
npx playwright test tests/e2e/auction-flow.spec.ts tests/e2e/a11y.spec.ts
```

## Acceptance checklist

- [ ] Every countdown exposes one concise, localized text label.
- [ ] Live announcements happen only at the listed thresholds and on extension or end.
- [ ] No raw numbers, `undefined`, or untranslated labels reach assistive tech.
- [ ] The BiddingPanel countdown renders regardless of transaction state.
- [ ] Focus order, Escape behavior and contrast are unchanged.
- [ ] The tests listed above pass. No other route behavior changes.
