<div align="center">

# ElcareHub — Frontend

**Next.js 14 frontend for the ElcareHub decentralized African art marketplace.**

[![Next.js](https://img.shields.io/badge/Next.js-14-black)](https://nextjs.org)
[![React](https://img.shields.io/badge/React-18-blue)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-3.x-teal)](https://tailwindcss.com)

</div>

---

## Table of Contents

- [Overview](#overview)
- [Design System](#design-system)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Available Scripts](#available-scripts)
- [Wallet Setup](#wallet-setup)
- [IPFS Setup](#ipfs-setup)
- [User Flows](#user-flows)
- [Testing](#testing)
- [Deployment](#deployment)
- [Known Issues](#known-issues)

---

## Overview

The frontend is a **Next.js 14 App Router** application that connects directly to Soroban smart contracts on Stellar through the Freighter browser extension or Magic.link (email/passkey). It reads marketplace state from the off-chain indexer API and writes state on-chain via signed Soroban transactions.

**This app lives at:** `frontend/elcarehub-app/`

All install, build, lint, and test commands must be run from this directory.

---

## Design System

### Color Palette — African Cultural Theme

| Token | Hex | Inspired By |
|-------|-----|-------------|
| `brand-500` (Kente Gold) | `#D4A017` | Kente cloth weaving |
| `terracotta-500` (Benin Red) | `#C1440E` | Benin bronze / fired clay |
| `sunset-500` (Sahara Orange) | `#E87722` | Saharan dusk sky |
| `midnight-900` (Baobab Earth) | `#120E04` | Baobab bark darkness |
| `mint-500` (Nile Green) | `#1E9E63` | Nile riverbank vegetation |
| `canvas-50` (Papyrus) | `#FBF7F0` | Natural linen / papyrus |
| `earth` (Laterite) | `#8B5E2A` | Laterite soil |

### Typography

| Role | Font | Weights |
|------|------|---------|
| Headings | Playfair Display | 600, 700, 800, 900 |
| Body | Inter | 300, 400, 500, 600, 700 |
| Monospace (addresses) | JetBrains Mono | 400, 500 |

### Key Design Patterns
- **Kente stripe divider** — multi-color horizontal band separating major sections
- **Glassmorphism cards** — frosted glass effect on dark backgrounds
- **Shimmer text** — animated gold gradient for hero headlines
- **Corner accents** — gold bracket decorations on image cards
- **Mudcloth dark sections** — deep earth-toned backgrounds with subtle radial gradients

---

## Project Structure

```
src/
├── app/
│   ├── layout.tsx                    # Root layout — providers + Navbar + Footer
│   ├── page.tsx                      # Homepage — hero, stats, featured listings
│   ├── explore/page.tsx              # Browse all active listings
│   ├── dashboard/page.tsx            # Artist dashboard — list + manage artwork
│   ├── listings/[id]/page.tsx        # Listing detail — buy, offer, history
│   ├── auctions/page.tsx             # Active auctions browser
│   ├── auctions/[id]/page.tsx        # Auction detail — bid, finalize
│   ├── launchpad/                    # NFT collection creation wizard
│   ├── profile/[address]/page.tsx    # Public artist profile
│   ├── offers/page.tsx               # My outgoing offers
│   ├── offers/incoming/page.tsx      # Incoming offers inbox
│   ├── admin/page.tsx                # Platform admin dashboard
│   ├── settings/page.tsx             # User preferences
│   ├── help/page.tsx                 # Help & FAQ
│   └── api/
│       ├── ipfs/upload-image/        # Server-side Pinata image upload
│       ├── ipfs/upload-metadata/     # Server-side Pinata metadata upload
│       └── og/                       # Open Graph image generation
│
├── components/
│   ├── Navbar.tsx                    # Sticky navigation with wallet connect
│   ├── ListingCard.tsx               # Artwork card with buy flow
│   ├── ListingForm.tsx               # Create / edit listing form
│   ├── CheckoutModal.tsx             # Purchase flow modal
│   ├── AuctionForm.tsx               # Create auction form
│   ├── BiddingPanel.tsx              # Place bid UI
│   ├── CollectionForm.tsx            # Deploy collection form
│   ├── ConnectWalletModal.tsx        # Wallet connection modal
│   ├── MagicWalletModal.tsx          # Magic.link flow
│   ├── FeaturedListings.tsx          # Homepage featured grid
│   ├── SearchFilter.tsx              # Search and filter bar
│   ├── WalletGuard.tsx               # Auth gate for protected routes
│   ├── RootErrorBoundary.tsx         # Top-level error boundary
│   └── onboarding/index.tsx          # New user onboarding flow
│
├── context/
│   └── WalletContext.tsx             # Global wallet state (Freighter + Magic)
│
├── hooks/
│   ├── useWallet.ts                  # Connect, disconnect, auto-reconnect
│   ├── useFreighterWallet.ts         # Freighter-specific logic
│   ├── useMagicWallet.ts             # Magic.link-specific logic
│   ├── useMarketplace.ts             # Listings CRUD + buy
│   ├── useAuctions.ts                # Auction create, bid, finalize
│   ├── useOffers.ts                  # Make, accept, reject, withdraw offers
│   ├── useLaunchpad.ts               # Deploy NFT collections
│   ├── useAdmin.ts                   # Admin operations
│   └── useUserActivity.ts            # Wallet activity feed
│
├── lib/
│   ├── config.ts                     # Centralised env var access + validation
│   ├── contract.ts                   # Soroban contract client (all functions)
│   ├── indexer.ts                    # Indexer HTTP client with retry logic
│   ├── freighter.ts                  # Freighter sign + connect helpers
│   ├── magic.ts                      # Magic.link SDK wrapper
│   ├── ipfs.ts                       # Pinata upload + IPFS fetch helpers
│   ├── launchpad.ts                  # Launchpad contract client
│   ├── errors.ts                     # Soroban error message mapping
│   └── token-support.ts              # Token validation utilities
│
└── config/
    └── tokens.ts                     # Token addresses by network
```

---

## Getting Started

### Requirements

- **Node.js 20.x** — matches CI environment
- **npm** — do not use `yarn` or `pnpm` (lockfile is `package-lock.json`)
- Freighter wallet browser extension (for testing)

### Install and run

```bash
cd frontend/elcarehub-app
cp .env.example .env.local       # copy and fill in your values
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Environment Variables

Copy `.env.example` to `.env.local` and fill in your values:

```bash
cp .env.example .env.local
```

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_CONTRACT_ID` | ✅ | Deployed Soroban marketplace contract address |
| `NEXT_PUBLIC_LAUNCHPAD_CONTRACT_ID` | ✅ | Deployed launchpad factory address |
| `NEXT_PUBLIC_STELLAR_NETWORK` | ✅ | `testnet` or `mainnet` |
| `NEXT_PUBLIC_STELLAR_RPC_URL` | ✅ | Soroban RPC endpoint |
| `NEXT_PUBLIC_STELLAR_HORIZON_URL` | ✅ | Horizon REST API endpoint |
| `NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE` | ✅ | Network passphrase |
| `NEXT_PUBLIC_INDEXER_URL` | ✅ | Indexer API base URL |
| `NEXT_PUBLIC_PINATA_GATEWAY` | ✅ | Pinata IPFS gateway URL |
| `PINATA_JWT` | ✅ | Pinata JWT — server-side only, never commit |
| `NEXT_PUBLIC_MAGIC_API_KEY` | ⬜ | Magic.link key for email/passkey wallets |
| `NEXT_PUBLIC_SENTRY_DSN` | ⬜ | Sentry DSN for error tracking |
| `NEXT_PUBLIC_POSTHOG_KEY` | ⬜ | PostHog key for analytics |

---

## Available Scripts

```bash
npm run dev           # Start dev server with hot-reload → localhost:3000
npm run dev:e2e       # Start dev server with mock blockchain (E2E mode)
npm run build         # Production build
npm run start         # Start production server
npm run lint          # ESLint
npm run type-check    # TypeScript check (no emit)
npm run test          # Jest unit tests
npm run test:coverage # Jest with coverage report
npm run test:e2e      # Playwright E2E tests
npm run test:e2e:ui   # Playwright E2E tests with interactive UI
```

---

## Wallet Setup

### Option A — Freighter (recommended for Web3 users)

1. Install the [Freighter](https://www.freighter.app) browser extension
2. Create or import a Stellar keypair
3. In Freighter settings → switch to **Testnet**
4. Fund your test account at [friendbot.stellar.org](https://friendbot.stellar.org)

### Option B — Magic.link (email / passkey)

1. Set `NEXT_PUBLIC_MAGIC_API_KEY` in `.env.local`
2. Users can sign in with email — no browser extension required
3. Magic handles key management behind the scenes

---

## IPFS Setup

Artwork images and metadata JSON are stored on IPFS via Pinata.

1. Sign up at [app.pinata.cloud](https://app.pinata.cloud)
2. Go to **API Keys → New Key** → select **Admin** scope
3. Copy the JWT into `.env.local` as `PINATA_JWT`

Uploads flow through Next.js API routes (`/api/ipfs/upload-image`, `/api/ipfs/upload-metadata`) so the JWT is never exposed to the browser.

---

## User Flows

### Artist — Listing artwork

1. Connect wallet (Freighter or Magic)
2. Go to **Dashboard → New Listing**
3. Drag and drop artwork image
4. Fill in title, description, artist name, year, price, royalty %
5. Click **List Artwork** — the app:
   - Uploads image → IPFS via Pinata
   - Builds and uploads metadata JSON → IPFS
   - Calls `create_listing` on the Soroban contract (Freighter signs)

### Collector — Buying artwork

1. Browse the marketplace at `/explore`
2. Click an artwork → **Buy Now**
3. Choose payment method: Crypto (XLM) or Credit Card
4. Freighter signs the transaction
5. Contract transfers XLM from buyer → artist + royalty split
6. NFT ownership recorded on-chain

### Artist — Creating an auction

1. Go to **Dashboard → New Auction**
2. Set reserve price, duration, royalty recipients
3. Buyers place bids until the auction ends
4. Anyone can call finalize after end time — winner receives the NFT

---

## Testing

### Unit tests (Jest)

```bash
npm run test
npm run test:coverage
```

28 test files covering components, hooks, contract utilities, and the indexer client.

### E2E tests (Playwright)

```bash
# Requires dev server running in E2E mode
npm run dev:e2e

# In a separate terminal
npm run test:e2e
```

Test suites: `smoke`, `wallet-connection`, `wallet-network`, `wallet-not-installed`, `listing-flow`, `purchase-flow`, `marketplace-journey`.

All E2E tests use a mock Freighter wallet (no real extension required) and a mock chain (no live Stellar network required).

---

## Deployment

### Vercel (recommended)

1. Connect your repository to [Vercel](https://vercel.com)
2. Set all required `NEXT_PUBLIC_*` environment variables in Vercel project settings
3. Set `PINATA_JWT` as a **server-side** (non-public) environment variable
4. Deploy — Vercel handles the build automatically

### Self-hosted

```bash
npm run build
npm run start        # starts on port 3000
```

---

## Known Issues

### Stellar SDK build warnings

When running `npm run build`, you may see:

```
Critical dependency: require function is used in a way in which
dependencies cannot be statically extracted
```

This comes from `@stellar/stellar-sdk` pulling in `sodium-native` (a Node.js native module) even in the browser bundle. It is handled via webpack `resolve.fallback` stubs in `next.config.js` and does **not** affect runtime behavior. The browser SDK uses its WASM/JS crypto fallback automatically.

See: [stellar/js-stellar-sdk#922](https://github.com/stellar/js-stellar-sdk/issues/922)

---

## Architecture & Debugging Guides

For transaction debugging, wallet flow troubleshooting, and local testing references:
- 🏗️ **[Local Architecture](../../docs/guides/local-architecture.md)**
- 💻 **[Frontend Transaction Debugging Guide](../../docs/guides/frontend-transaction-debugging.md)**
- 🚀 **[Deployment Guide](../../docs/guides/deployment.md)**
- 🛡️ **[Security Triage Guide](../../docs/guides/security-triage.md)**

