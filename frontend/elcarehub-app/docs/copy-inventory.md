# Frontend Copy Inventory

> Issue #1056 · Scope: documentation and QA only. This file adds no new copy framework.
> Last reviewed against `main` @ `a5746a7`.

This is the list of high-frequency, user-facing strings in the ElcareHub frontend,
mapped to the locale system that already exists. Use it to:

- check that a label reads the same everywhere it appears,
- find the existing key before adding a new one,
- see which components still hard-code English and could move to `t()`.

---

## 1. Where copy lives

| Source | Role | Consumed by |
|---|---|---|
| [`src/lib/i18n.ts`](../src/lib/i18n.ts) → `translations` | **Source of truth.** Typed catalog (`TranslationKey`) read by `t()` and `useLocale()`. | `CollectionForm.tsx`, `ListingWizard.tsx`, `LocaleSwitcher.tsx`, `__tests__/i18n.test.ts` |
| [`src/messages/en.json`](../src/messages/en.json) | Flat JSON mirror of the English catalog. | **Nothing imports it at runtime** (checked with `grep -rn "messages/" src tests`). Translators and tooling only. |
| [`src/messages/sw.json`](../src/messages/sw.json) | Flat JSON mirror of the Swahili catalog. | Same as above. |

Supported locales: `en` (default) and `sw`. `t(key, locale?)` falls back from the requested locale to English, and from English to the raw key. Locale is resolved in this order: `localStorage['elcarehub_locale']` → `navigator.language` → `en`.

---

## 2. Key inventory

Key = the `TranslationKey`. "Hard-coded in" lists components that render the same English text inline instead of calling `t()`. These are candidates for migration, not defects in the catalog.

### Navigation

`Navbar.tsx` (`PUBLIC_NAV` / `AUTH_NAV`) hard-codes its labels and does not call `t()`. Three of them differ from the catalog. These are **copy mismatches**.

| Key | en | sw | What `Navbar.tsx` renders today |
|---|---|---|---|
| `nav_home` | Home | Nyumbani | **"Marketplace"** (mismatch) |
| `nav_explore` | Explore | Gundua | **"Discover"** (mismatch) |
| `nav_auctions` | Auctions | Minada | "Auctions" |
| `nav_launchpad` | Launchpad | Uzinduzi | "Launchpad" |
| `nav_profile` | Profile | Wasifu | **"My Collection"** (mismatch) |
| `nav_admin` | Admin | Msimamizi | — |
| `nav_help` | Help | Msaada | — |

Navbar labels with no key yet: "Activity" (the `activity` key exists but belongs to the profile section), "Dashboard", "Offers" (the `offers` key exists).

### Actions

| Key | en | sw | Hard-coded in |
|---|---|---|---|
| `connect_wallet` | Connect Wallet | Unganisha Pochi | `Navbar`, `WalletGuard`, `PageStates`, `app/page`, `app/help/page`, `app/settings/page` |
| `disconnect` | Disconnect | Tenganisha | `Navbar`, `WalletMenu`, `WalletGuard`, `StaleBanner`, `app/help/page`, `app/settings/page` |
| `buy_now` | Buy Now | Nunua Sasa | `ListingCard` |
| `place_bid` | Place Bid | Weka Zabuni | `BiddingPanel` |
| `create_listing` | Create Listing | Unda Tangazo | `ListingWizard`, `ListingForm` |
| `cancel` | Cancel | Ghairi | ~14 files (modals, wizards) |
| `save` | Save | Hifadhi | ~8 files |
| `edit` | Edit | Hariri | — |
| `view_details` | View Details | Angalia Maelezo | `app/launchpad/page`, `app/launchpad/collections/page`, `app/launchpad/my-collections/page` |
| `back` | Back | Rudi | ~40 files (mostly "Back to …" variants) |

### Status

| Key | en | sw | Notes |
|---|---|---|---|
| `loading` | Loading… | Inapakia… | ~55 files render their own "Loading…" text. Use the Unicode ellipsis `…`, not `...`. |
| `error` | Error | Hitilafu | |
| `success` | Success | Imefanikishwa | |
| `pending` | Pending | Inasubiri | |
| `approved` | Approved | Imeidhinishwa | Matches the moderation state `APPROVED`. |
| `rejected` | Rejected | Imekataliwa | Matches the moderation state `REJECTED`. |

### Marketplace

| Key | en | sw | Notes |
|---|---|---|---|
| `listings` | Listings | Matangazo | |
| `collections` | Collections | Makusanyo | |
| `auctions` | Auctions | Minada | Same text as `nav_auctions`. See §3. |
| `offers` | Offers | Mapendekezo | |
| `price` | Price | Bei | |
| `royalties` | Royalties | Mrabaha | |

### Profile

| Key | en | sw | Notes |
|---|---|---|---|
| `bio` | Bio | Wasifu Mfupi | `sw` adds "Mfupi" (short) so it reads differently from `nav_profile` (Wasifu). |
| `display_name` | Display Name | Jina la Kuonyesha | |
| `social_links` | Social Links | Viungo vya Mtandao | |
| `earnings` | Earnings | Mapato | |
| `activity` | Activity | Shughuli | |
| `purchased` | Purchased | Vilivyonunuliwa | |
| `sold` | Sold | Vilivyouzwa | |

### Common

| Key | en | sw | Hard-coded in |
|---|---|---|---|
| `search` | Search | Tafuta | |
| `filter` | Filter | Chuja | |
| `sort` | Sort | Panga | |
| `empty_state_no_items` | No items found | Hakuna vitu vilivyopatikana | `CollectionDetailClient` |

### Wizard (screen-reader progress text)

Used by `CollectionForm.tsx` and `ListingWizard.tsx` to build "Step 2 of 4" and the live-region announcement.

| Key | en | sw | In JSON mirrors? |
|---|---|---|---|
| `wizard_step` | Step | Hatua | **No** |
| `wizard_of` | of | ya | **No** |
| `wizard_current_step` | Current step | Hatua ya sasa | **No** |
| `wizard_step_complete` | completed | imekamilika | **No** |
| `wizard_step_current` | current | ya sasa | **No** |
| `wizard_step_remaining` | remaining | zinazobaki | **No** |

---

## 3. Audit findings

Checked with a one-off script that parses both JSON files with a duplicate-key hook and compares them with `i18n.ts`:

| Check | Result |
|---|---|
| Duplicate JSON keys in `en.json` / `sw.json` | **None.** Nothing to remove. |
| Keys in `en` but not `sw` (or the reverse) | **None.** Both catalogs have the same 46 keys in `i18n.ts`. |
| `sw` value identical to `en` (untranslated) | **None.** |
| Empty values | **None.** |
| Placeholder (`{…}`) mismatch | **None.** No keys use placeholders yet. |
| JSON mirrors vs `i18n.ts` | **Drift:** the JSON files have 40 keys and are missing all 6 `wizard_*` keys. |
| Same English value under two keys | `nav_auctions` and `auctions` are both "Auctions" / "Minada". |
| Catalog vs rendered UI | `Navbar` shows "Marketplace", "Discover" and "My Collection" where the catalog says Home, Explore and Profile (§2 Navigation). |

### Decisions

- **`nav_auctions` / `auctions` are kept.** They are not duplicate keys. They have different roles (a nav item and a section heading), and other languages may need different forms for them. Both are part of the exported `TranslationKey` type, so removing one would be a breaking change for any caller.
- **JSON drift is recorded, not fixed here.** No runtime code reads the JSON files, so the drift cannot show users missing or raw text. To fix it, copy the six `wizard_*` entries into both JSON files. Do this in the same PR as any future change that makes the JSON files load-bearing.
- **The Navbar mismatch needs a product decision.** The labels shown in the UI ("Marketplace", "Discover", "My Collection") are what users see today. When `Navbar` moves to `t()`, update the `nav_home`, `nav_explore` and `nav_profile` values (and their `sw` translations) to match the UI rather than the other way round. That way the visible copy does not change.
- **The wizard builds sentences by concatenation** (`Step` + n + `of` + m). This works in English and Swahili today. It will not work for languages with different word order. If a third locale is added, replace it with one interpolated key such as `wizard_progress: "Step {current} of {total}"`.

---

## 4. Rules for adding copy

1. Add the key to **both** `en` and `sw` in `src/lib/i18n.ts`. The `as const` typing turns a missing English key into a compile error at the call site. A missing Swahili key falls back to English silently, so check it in review.
2. Mirror the key into `src/messages/en.json` and `src/messages/sw.json`.
3. Reuse an existing key from §2 before creating a new one. Use one name per concept: "Connect Wallet" is always `connect_wallet`.
4. Never render a raw key, `undefined`, an enum value (`QUARANTINED`, `lazy_721`) or an error code as visible text. Map it to a key first.
5. Keep `aria-label` text and visible labels in the same locale. Screen-reader-only strings (like the `wizard_*` keys) count as user-facing.

---

## 5. Verification

Read-only commands. None of them change files.

```bash
cd frontend/elcarehub-app

# Unit tests for the catalog, fallback and locale persistence
npx jest src/__tests__/i18n.test.ts src/__tests__/LocaleSwitcher.test.tsx

# Key parity between i18n.ts locales and JSON mirrors (prints any drift)
node -e '
const en=require("./src/messages/en.json"), sw=require("./src/messages/sw.json");
const a=Object.keys(en), b=Object.keys(sw);
console.log("en-only:", a.filter(k=>!b.includes(k)));
console.log("sw-only:", b.filter(k=>!a.includes(k)));'
```

This document changes no runtime behaviour, routes or UI. To revert it, delete this file.
