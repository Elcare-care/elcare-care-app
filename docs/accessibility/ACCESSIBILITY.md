# Accessibility Statement & Conformance Program

ElcareHub aims to make marketplace workflows usable by people who rely on keyboards, screen readers, and other assistive technologies.

**Last updated:** 2026-08-26  
**Contact:** accessibility@elcarehub.io (placeholder — route via support channel)

---

## Target standard

| Goal | Standard |
|------|----------|
| **Target** | [WCAG 2.2 Level AA](https://www.w3.org/TR/WCAG22/) |
| **Legal reference** | Align with applicable regional requirements as product scope expands |
| **Scope** | Public marketplace flows: wallet connect, browse/filter, listing detail, checkout, offers, auctions, admin tables |

Full AAA is not claimed. Known exceptions are listed below and tracked in the [reliability backlog](../reliability/backlog.md).

---

## Supported environments

| Category | Supported |
|----------|-----------|
| **Browsers** | Latest two major versions of Chrome, Firefox, Safari, Edge |
| **Screen readers** | NVDA + Firefox (Windows), VoiceOver + Safari (macOS/iOS) |
| **Input** | Keyboard-only, pointer, touch |
| **Viewport** | 320 px minimum width; tested at mobile/tablet/desktop breakpoints |

Wallet extensions (Freighter, Magic.link) follow their own accessibility profiles; we test integration points only.

---

## Audit frequency & severity

| Activity | Cadence | Tooling |
|----------|---------|---------|
| Automated unit a11y | Every PR (component scope) | `jest-axe` — `npm run test:a11y` |
| E2E a11y scan | Weekly CI + release gate | Playwright + `@axe-core/playwright` — `tests/e2e/a11y.spec.ts` |
| Keyboard walkthrough | Quarterly | Manual — `tests/e2e/a11y-keyboard.spec.ts` |
| Full manual audit | Annual (or after major UI redesign) | External or internal WCAG review |

### Severity definitions

| Level | Definition | SLA |
|-------|------------|-----|
| **Blocker** | Core task impossible without mouse/sight | Fix before release |
| **Major** | Task completable with undue burden | Fix within 30 days |
| **Minor** | Cosmetic or edge-case announcement gap | Backlog |
| **Exception** | Documented third-party or platform limitation | Review quarterly |

---

## Critical workflow coverage

| Workflow | Keyboard | Focus | Contrast | Motion | Screen reader |
|----------|----------|-------|----------|--------|---------------|
| Connect wallet | Tab order, Escape closes modal | Trapped in modal (`useModalA11y`) | Button labels ≥ 4.5:1 | Reduced-motion respected | `aria-modal`, labelled buttons |
| Marketplace filters | All filters operable | Visible focus ring | Filter chips readable | No essential info in motion-only | Filter state in labels |
| Listing / checkout | Checkout steps reachable | Focus returns on close | Price/error text contrast | Loading via `StatusAnnouncer` | Live region for tx state |
| Auctions / offers | Bid/offer forms | Same as checkout | Countdown readable | Countdown static when reduced-motion | Status announcements |
| Admin tables | Row actions via keyboard | Skip links where present | Table headers associated | — | Sort/filter announced |
| SSE-driven updates | N/A | Focus not stolen on update | Stale banner contrast | Reorg banner non-flashing | `StatusAnnouncer` for critical changes |

Implementation references:

- `frontend/elcarehub-app/src/components/a11y/StatusAnnouncer.tsx`
- `frontend/elcarehub-app/src/hooks/useModalA11y.ts`
- `frontend/elcarehub-app/src/hooks/useReducedMotion.ts`
- Tests: `frontend/elcarehub-app/src/__tests__/a11y/`, `tests/e2e/a11y*.spec.ts`

---

## Reduced motion

Nonessential animations (transitions, pulsing loaders, decorative gradients) honor `prefers-reduced-motion: reduce`:

- Global CSS: `globals.css` → `@media (prefers-reduced-motion: reduce)`
- Runtime hook: `useReducedMotion()` for component-level animation toggles
- E2E: `viewport-responsive.spec.ts` — auction countdown readable under reduced motion

Essential feedback (error states, focus indicators) remains visible without animation.

---

## Known exceptions

| Area | Issue | Severity | Tracking |
|------|-------|----------|----------|
| Wallet extension UI | Controlled by third party | Exception | Document workaround in wallet-incompatibility runbook |
| Complex data tables (admin) | Some sort icons lack long description | Minor | REL backlog |
| CI a11y gate on every PR | Deferred full gate to 2027-Q1 | Process | [2026-Q3 review](../reliability/reviews/2026-Q3.md) |

---

## Integration with tests

```bash
# Unit a11y (jest-axe)
cd frontend/elcarehub-app && npm run test:a11y

# E2E a11y
cd frontend/elcarehub-app && npm run test:e2e -- tests/e2e/a11y.spec.ts tests/e2e/a11y-keyboard.spec.ts
```

Visual regression and E2E flows should include at least one keyboard-only path for release candidates.

---

## Reporting issues

Users can report accessibility barriers via the in-app support link or GitHub Issues tagged `a11y`. Include:

- Browser + version
- Assistive technology used
- Steps to reproduce
- Expected vs actual behavior

We acknowledge reports within 5 business days and provide severity classification within 10 business days.

---

## Related documents

- [frontend-transaction-debugging.md](../guides/frontend-transaction-debugging.md)
- [reliability/quarterly-review-process.md](../reliability/quarterly-review-process.md)
- [wallet-incompatibility.md](../runbooks/wallet-incompatibility.md)
