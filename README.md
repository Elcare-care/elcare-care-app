<div align="center">

<br />

<img src="https://img.shields.io/badge/ElcareHub-African%20Art%20on%20Stellar-D4A017?style=for-the-badge&logo=stellar&logoColor=white" alt="ElcareHub" />

<br /><br />

# ElcareHub

### Decentralized African Art Marketplace · Powered by Stellar & Soroban

Discover, collect, and trade authentic African masterpieces.  
Every piece is verified on-chain — ensuring provenance and empowering artists across the continent.

<br />

[![CI](https://github.com/your-org/elcarehub/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/elcarehub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-green)](https://nodejs.org)
[![Rust](https://img.shields.io/badge/Rust-stable-orange)](https://www.rust-lang.org)
[![Stellar](https://img.shields.io/badge/Stellar-Soroban-blue)](https://stellar.org)
[![Next.js](https://img.shields.io/badge/Next.js-14-black)](https://nextjs.org)

<br />

[Live Demo](http://localhost:3000) · [Report a Bug](https://github.com/your-org/elcarehub/issues) · [Request a Feature](https://github.com/your-org/elcarehub/issues)

</div>

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [Architecture & Debugging Guides](#architecture--debugging-guides)
- [Repository Structure](#repository-structure)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
- [Environment Variables](#environment-variables)
- [Testnet Deployment](#testnet-deployment)
- [Tech Stack](#tech-stack)
- [Roadmap](#roadmap)
- [Security](#security)
- [Contributing](#contributing)

---

## Overview

**ElcareHub** is a full-stack, non-custodial NFT marketplace purpose-built for African artists and collectors. Artists can list, auction, and sell their work directly to buyers worldwide — no middlemen. All transactions settle on the **Stellar blockchain** via **Soroban smart contracts**, providing instant finality, near-zero fees, and transparent on-chain royalties on every resale.

The platform celebrates African heritage — from Benin bronze sculptures to Tingatinga paintings — and ensures every sale is traceable, every artist is fairly compensated, and every collector owns a verifiable piece of cultural history.

**Core principles:**

| Principle | What it means |
|-----------|--------------|
| 🎨 Artist-first | Creators receive payments instantly with minimal protocol fees |
| 🔗 On-chain provenance | Every listing, sale, and transfer is recorded immutably on Stellar |
| 🌍 Cultural preservation | Celebrating African heritage through verifiable digital ownership |
| 🔒 Non-custodial | Users hold their own keys via Freighter or Magic.link wallets |
| ⚡ Instant settlement | Stellar's 5-second finality — no waiting, no gas auctions |

---

## Key Features

### Marketplace
- Create, update, and cancel listings with IPFS-hosted metadata (Pinata)
- Buy artwork with XLM or any admin-whitelisted token
- Make, accept, reject, and withdraw peer-to-peer offers on any listing
- On-chain royalty distribution to original creators on every secondary sale
- Protocol fee (basis points) configurable by admin

### Auctions
- Full auction lifecycle: create with reserve price → open bidding → auto-finalize
- Minimum bid increment enforcement at contract level
- Any participant can trigger finalization after end time

### Launchpad
- One-click NFT collection deployment (ERC-721, ERC-1155, lazy-mint variants)
- Salt-based front-running protection on collection creation
- Per-collection platform fee configuration
- Collection creation wizard in the frontend UI

### Admin Panel
- 2-step admin key transfer (propose → accept)
- Emergency pause / unpause circuit breaker
- Token whitelist management
- Artist revocation and reinstatement
- Full dashboard: fee management, collection registry, event log, listing oversight

### Indexer
- Real-time Stellar RPC event polling (configurable interval, default 5 s)
- Ledger hash continuity check with automatic re-org rollback
- Prometheus metrics: sync latency, request duration, processed ledger gauge
- Redis caching with per-endpoint TTL
- Server-Sent Events (SSE) for live UI updates
- Backfill CLI for replaying missed ledger ranges
- Tiered retention and archival for event history (see `docs/retention-archival.md`)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  Browser (Next.js 14 — App Router)              │
│                                                                 │
│  Freighter Wallet ──┐                                           │
│  Magic.link        ─┼──► Signs Soroban Transactions            │
│                     │          │                                │
│                     │          ▼                                │
│              Reads ◄─── Stellar Testnet / Mainnet               │
│              from        (Soroban Smart Contracts)              │
│              Indexer                                            │
└──────────────────┬──────────────────────────────────────────────┘
                   │ HTTP / SSE
┌──────────────────▼──────────────────────────────────────────────┐
│                  Indexer  (Node.js + Express : 4000)            │
│                                                                 │
│  Stellar RPC polling ──► XDR event decoder ──► Re-org detect   │
│  Redis cache (TTL)   ──► REST API           ──► SSE stream      │
└──────────────────┬──────────────────────────────────────────────┘
                   │ Prisma ORM
┌──────────────────▼──────────────────────────────────────────────┐
│                  PostgreSQL Database                             │
│  SyncState · Listing · Auction · Offer · Collection             │
│  MarketplaceEvent · RoyaltyStats                                │
└─────────────────────────────────────────────────────────────────┘

           ┌────────────┐
           │   Pinata   │  IPFS — artwork images + NFT metadata JSON
           └────────────┘
```


---

## Architecture & Debugging Guides

For detailed architectural walk-throughs, component boundaries, and step-by-step decision trees when troubleshooting issues, refer to our focused guides:

| Guide | Description |
|---|---|
| 🏗️ **[Local Architecture](docs/guides/local-architecture.md)** | Full-stack local setup, service communication, and diagnostic flow |
| 🦀 **[Contract Testing](docs/guides/contract-testing.md)** | Building WASM, executing Rust unit tests, and debugging contract errors |
| 🔄 **[Indexer Ingestion](docs/guides/indexer-ingestion.md)** | RPC polling, re-org detection, stall recovery, and ledger gap backfilling |
| 🏷️ **[Event Parsing](docs/guides/event-parsing.md)** | Soroban XDR event decoding, Zod schemas, and topic resolution |
| 💻 **[Frontend Transaction Debugging](docs/guides/frontend-transaction-debugging.md)** | Wallet connection, transaction lifecycle, error mapping, and E2E testing |
| 🚀 **[Deployment](docs/guides/deployment.md)** | Contract deployment, indexer containers, readiness probes, and Next.js builds |
| 🗄️ **[Database Migrations](docs/guides/database-migrations.md)** | Prisma ORM schema updates, rollback resolution, and zero-downtime rules |
| 🛡️ **[Security Triage](docs/guides/security-triage.md)** | Cargo Audit, npm Audit, Gitleaks, and Safe Redaction guidelines |
| 🎫 **[Support Triage](docs/guides/support-triage.md)** | Safe diagnostic collection, severity classification, and escalation paths |

---

## Reliability & Operational Runbooks

ElcareHub maintains a living reliability backlog, quarterly review process, and operational runbooks for incident response:

| Resource | Description |
|---|---|
| 📊 **[Reliability Program](docs/reliability/README.md)** | Domain ownership, quarterly review cadence, backlog, and decision records |
| 📋 **[Quarterly Review Process](docs/reliability/quarterly-review-process.md)** | Review inputs, scoring, incident rules, and version alignment |
| 📝 **[Quarterly Review Input Template](docs/reliability/quarterly-review-template-inputs.md)** | Pre-review artifact collection checklist |
| 🔍 **[Reliability Backlog](docs/reliability/backlog.md)** | Scored open reliability items with domain owners and milestones |
| 🚨 **[Incident Runbooks](docs/runbooks/README.md)** | Contract pause, database outage, reorg, stalled ingestion, and more |

---

## Repository Structure

```
elcarehub/
│
├── contracts/                          # Soroban smart contracts (Rust)
│   ├── soroban-marketplace/            # Core marketplace — listings, auctions, offers
│   │   └── src/
│   │       ├── contract.rs             # Business logic entry points
│   │       ├── types.rs                # Listing, Auction, Offer, Error types
│   │       ├── storage.rs              # Storage key helpers + TTL management
│   │       ├── events.rs               # On-chain event emission
│   │       └── test.rs                 # Unit tests (no live network needed)
│   ├── launchpad/                      # NFT collection factory contract
│   ├── collection_nft_erc721/          # Standard ERC-721 equivalent
│   ├── collection_nft_erc1155/         # Standard ERC-1155 equivalent
│   ├── lazy_mint_erc721/               # Lazy-mint ERC-721 (voucher-based)
│   └── lazy_mint_erc1155/              # Lazy-mint ERC-1155 (voucher-based)
│
├── frontend/
│   └── elcarehub-app/                  # Next.js 14 App Router frontend
│       ├── src/
│       │   ├── app/                    # Pages: listings, auctions, launchpad,
│       │   │                           #        profile, admin, settings, help
│       │   ├── components/             # Reusable React components
│       │   ├── lib/                    # contract.ts · indexer.ts · config.ts
│       │   ├── hooks/                  # useWallet · useMarketplace · useAuctions
│       │   ├── context/                # WalletContext (Freighter + Magic)
│       │   └── config/                 # Token addresses by network
│       └── src/__tests__/             # Jest unit tests
│
├── indexer/                            # Off-chain event indexer + REST API
│   ├── src/
│   │   ├── index.ts                    # Express server entry point
│   │   ├── poller.ts                   # Stellar RPC polling + re-org detection
│   │   ├── event-sync.ts               # XDR event decoder
│   │   ├── parser.ts                   # Event parser
│   │   ├── redis.ts                    # Cache client
│   │   ├── metrics.ts                  # Prometheus metrics
│   │   └── api/routes.ts               # REST endpoints
│   ├── prisma/schema.prisma            # Database schema
│   └── docker-compose.yml             # PostgreSQL + Redis + indexer stack
│
├── scripts/deploy/                     # Soroban deployment shell scripts
├── .github/workflows/ci.yml           # GitHub Actions CI pipeline
├── Cargo.toml                          # Rust workspace manifest
└── package.json                        # Monorepo root scripts + workspaces
```

---

## Quick Start

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20.x | [nodejs.org](https://nodejs.org) |
| Rust | stable | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Stellar CLI | latest | `cargo install --locked stellar-cli --features opt` |
| Docker | 24+ | [docker.com](https://www.docker.com) |

> **Windows users:** All `npm` commands work fine. Use PowerShell or CMD. `pnpm` is **not** required — the lockfile is `package-lock.json`.

---

### Step 1 — Clone the repository

```bash
git clone https://github.com/your-org/elcarehub.git
cd elcarehub
```

---

### Step 2 — Deploy smart contracts (Testnet)

```bash
cd scripts/deploy
./fund_account.sh        # fund a new keypair on Stellar testnet
./deploy_contract.sh     # build + deploy the marketplace contract
./deploy_launchpad.sh    # build + deploy the launchpad factory
```

Note the `CONTRACT_ID` and `LAUNCHPAD_CONTRACT_ID` printed at the end — you'll need them in the next steps.

---

### Step 3 — Start the indexer

```bash
cd indexer
cp .env.example .env
# Edit .env — set DATABASE_URL, MARKETPLACE_CONTRACT_ID, LAUNCHPAD_CONTRACT_ID
docker compose up -d       # starts PostgreSQL + Redis
npm install
npx prisma migrate deploy
npm run dev
```

Indexer API is now live at **http://localhost:4000**

---

### Step 4 — Start the frontend

```bash
cd frontend/elcarehub-app
cp .env.example .env.local
# Edit .env.local — set NEXT_PUBLIC_CONTRACT_ID, PINATA_JWT, etc.
npm install
npm run dev
```

Open **http://localhost:3000** in your browser.

---

### Running all tests

```bash
# Rust contract tests (no live network)
cargo test

# Frontend unit tests
npm run test:frontend

# Indexer unit tests
npm run test:indexer

# Frontend E2E (Playwright — requires dev server in mock mode)
npm run test:e2e
```

---

## API Reference

Base URL: `http://localhost:4000`

- **OpenAPI spec**: `GET /openapi.json` (machine-readable)
- **SSE protocol**: see `docs/sse-protocol.md`

### Listings

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/listings` | All listings. Filters: `artist`, `status`, `minPrice`, `maxPrice`, `search`, `limit`, `offset` |
| `GET` | `/listings/:id` | Single listing with IPFS metadata |
| `GET` | `/listings/:id/history` | Full on-chain event history for a listing |

### Auctions

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/auctions` | All auctions. Filters: `status`, `creator` |
| `GET` | `/auctions/:id` | Auction details with full bid history |

### Offers

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/offers` | Offers for a listing. Query param: `listing_id` |

### Collections

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/collections` | All deployed collections. Filters: `kind`, `creator` |
| `GET` | `/creators/:address/collections` | Collections by a specific creator address |

### Wallets

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/wallets/:address/activity` | Transaction history for a wallet |
| `GET` | `/wallets/:address/royalty-stats` | Royalty earnings summary for an artist |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Liveness check → `{ status: "ok" }` |
| `GET` | `/readyz` | Readiness check → `503` until first ledger indexed |
| `GET` | `/metrics` | Prometheus metrics scrape endpoint |

---

## Environment Variables

### Frontend — `frontend/elcarehub-app/.env.local`

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_CONTRACT_ID` | ✅ | Deployed marketplace contract address |
| `NEXT_PUBLIC_LAUNCHPAD_CONTRACT_ID` | ✅ | Deployed launchpad factory address |
| `NEXT_PUBLIC_STELLAR_NETWORK` | ✅ | `testnet` or `mainnet` |
| `NEXT_PUBLIC_STELLAR_RPC_URL` | ✅ | Soroban RPC endpoint |
| `NEXT_PUBLIC_STELLAR_HORIZON_URL` | ✅ | Horizon REST API endpoint |
| `NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE` | ✅ | Stellar network passphrase |
| `NEXT_PUBLIC_INDEXER_URL` | ✅ | Indexer API base URL (default: `http://localhost:4000`) |
| `NEXT_PUBLIC_PINATA_GATEWAY` | ✅ | Pinata IPFS gateway URL |
| `PINATA_JWT` | ✅ | Pinata JWT — server-side only, **never expose publicly** |
| `NEXT_PUBLIC_MAGIC_API_KEY` | ⬜ | Magic.link key for email/passkey wallets |
| `NEXT_PUBLIC_SENTRY_DSN` | ⬜ | Sentry DSN for error tracking |
| `NEXT_PUBLIC_POSTHOG_KEY` | ⬜ | PostHog key for analytics |

### Indexer — `indexer/.env`

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `MARKETPLACE_CONTRACT_ID` | ✅ | Soroban marketplace contract ID |
| `LAUNCHPAD_CONTRACT_ID` | ✅ | Launchpad factory contract ID |
| `REDIS_URL` | ✅ | Redis connection string |
| `STELLAR_RPC_URL` | ✅ | Stellar Soroban RPC endpoint |
| `STELLAR_NETWORK` | ✅ | `testnet` or `mainnet` |
| `PORT` | ⬜ | API server port (default: `4000`) |
| `POLL_INTERVAL_MS` | ⬜ | Event polling interval in ms (default: `5000`) |
| `CORS_ORIGIN` | ⬜ | Allowed origins in production — comma-separated |

---

## Testnet Deployment

> Last deployed: **2026-04-09**

| Contract | Address |
|----------|---------|
| Marketplace | `CB74XQOHEVOL2NQ376JLVW5IGVM6I5VFDSHG66YKSHDQKRNTYGGXW25E` |
| Launchpad Factory | `CA4RKSR4ORRIFBBW64MXCWS7GGJ4GY6AIXRGU5EGS43XBDDB7OYV3TRG` |
| Normal ERC-1155 Collection | `CAQBWUKVLOR5W43QBQDFJAHSE2LUGCALRDCM7EVEO36FTWOP5P2O36ML` |
| Admin / Deployer Wallet | `GBFUNHEQOVN35LFEKP7SZXFYJPMJ3WLXLX4PQZGBK737NTLRHOKVES3F` |

---

## Tech Stack

| Layer | Technology | Version |
|-------|------------|---------|
| Frontend | Next.js (App Router) | 14.x |
| UI | React + Tailwind CSS | 18.x / 3.x |
| Language | TypeScript | 5.x |
| Blockchain | Stellar / Soroban | Testnet |
| Smart Contracts | Rust (soroban-sdk) | stable |
| Wallet | Freighter + Magic.link | — |
| File Storage | IPFS via Pinata | — |
| Indexer | Node.js + Express | 20.x / 5.x |
| Database | PostgreSQL + Prisma | 15 / 5.x |
| Cache | Redis | 7.x |
| Monitoring | Prometheus + Sentry | — |
| Analytics | PostHog | — |
| Unit Tests | Jest + Rust `#[test]` | — |
| E2E Tests | Playwright | 1.x |
| CI/CD | GitHub Actions | — |

---

## Roadmap

### Near-term
- [ ] Mobile-responsive listing creation flow
- [ ] Push notifications for bids and offers via SSE
- [ ] Multi-language support (Swahili, French, Yoruba, Hausa)

### Marketplace evolution
- [ ] Primary and secondary sales pipeline with automatic royalty forwarding
- [ ] Lazy-mint drop mechanics — fixed price, timed drops, allowlists
- [ ] Launch metrics dashboard for artists (mints, volume, conversion rate)

### Platform growth
- [ ] Dedicated mobile app (React Native)
- [ ] Curator-selected collections and featured drops
- [ ] Social profiles for artists with full portfolio view and follower system
- [ ] Cross-chain bridge for collectors outside the Stellar ecosystem

---

## Security

ElcareHub handles on-chain value on behalf of artists and collectors. We take security seriously.

- **Report a vulnerability:** see [SECURITY.md](SECURITY.md) for the disclosure process and SLA.
- **Threat model:** [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) — attack surface analysis for the contract, indexer, and frontend.
- **Incident runbook:** [docs/INCIDENT_RUNBOOK.md](docs/INCIDENT_RUNBOOK.md) — pause procedure, admin key rotation, indexer re-org recovery, and secret rotation.
- **Operational runbooks:** [docs/runbooks/](docs/runbooks/README.md) — detailed procedures for stalled ingestion, reorgs, DB/Redis outage, compromised keys, Pinata outage, wallet issues, and deployment config errors.
- **Secret inventory:** [docs/secret-inventory.md](docs/secret-inventory.md) — every secret classified with storage location, owner, and rotation schedule.
- **Reliability program:** [docs/reliability/](docs/reliability/README.md) — quarterly reviews, domain owners, scored backlog, and decision records aligned with `versions.toml`.
- **Release verification:** [docs/RELEASE_VERIFICATION.md](docs/RELEASE_VERIFICATION.md) — how contract WASM, ABI, frontend, and indexer image release artifacts are signed (GitHub build provenance + keyless cosign) and how to independently verify each one before deploying.

## Contributing

See **[CONTRIBUTING.md](./CONTRIBUTING.md)** for workflow, coverage thresholds, E2E, indexer integration tests, and accessibility checks.

Quick start:

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit your changes following [Conventional Commits](https://www.conventionalcommits.org/): `git commit -m "feat: add your feature"`
4. Push to the branch: `git push origin feat/your-feature`
5. Open a Pull Request — describe what changed and how you tested it

---

<div align="center">

Built with ❤️ for African artists and collectors everywhere.

**[Live Demo](http://localhost:3000)** · **[Report a Bug](https://github.com/your-org/elcarehub/issues)** · **[Request a Feature](https://github.com/your-org/elcarehub/issues)**

© 2026 ElcareHub · Built on [Stellar](https://stellar.org)

</div>
150-Line TODO — Deterministic Database & Mock-Chain Seed System

Phase 1 — Understand the Existing Architecture

[ ] 001. Open the project in VS Code.

[ ] 002. Read the existing local architecture guide.

[ ] 003. Identify how the local stack is started.

[ ] 004. Identify the database technology.

[ ] 005. Identify the database initialization process.

[ ] 006. Identify existing database migrations.

[ ] 007. Identify existing integration fixtures.

[ ] 008. Identify existing E2E fixtures.

[ ] 009. Identify the mock-chain implementation.

[ ] 010. Identify how the mock chain is started.

[ ] 011. Identify existing mock wallets.

[ ] 012. Identify existing event fixtures.

[ ] 013. Identify existing listing fixtures.

[ ] 014. Identify existing auction fixtures.

[ ] 015. Identify existing offer fixtures.

[ ] 016. Identify existing collection fixtures.

[ ] 017. Identify existing metadata fixtures.

[ ] 018. Identify existing reorganization fixtures.

[ ] 019. Identify existing test data generators.

[ ] 020. Avoid duplicating fixtures that already exist.


Phase 2 — Design the Seed System

[ ] 021. Define the purpose of the seed command.

[ ] 022. Define the default seed profile.

[ ] 023. Define the small seed profile.

[ ] 024. Define the large seed profile.

[ ] 025. Define the reset behavior.

[ ] 026. Make seed generation deterministic.

[ ] 027. Choose a fixed random seed.

[ ] 028. Ensure repeated runs produce predictable data.

[ ] 029. Define the seed command interface.

[ ] 030. Define command-line options.

[ ] 031. Define profile selection.

[ ] 032. Define reset options.

[ ] 033. Define database-only seeding.

[ ] 034. Define mock-chain-only seeding.

[ ] 035. Define combined database and chain seeding.


Phase 3 — Environment Configuration

[ ] 036. Identify all required environment variables.

[ ] 037. Document database connection variables.

[ ] 038. Document mock-chain connection variables.

[ ] 039. Document seed profile variables.

[ ] 040. Document deterministic seed variables.

[ ] 041. Document reset-related variables.

[ ] 042. Create a safe local environment example.

[ ] 043. Add seed-specific configuration where necessary.

[ ] 044. Ensure production credentials are never required.

[ ] 045. Ensure production credentials cannot accidentally be used.

[ ] 046. Add safeguards against production database connections.

[ ] 047. Add safeguards against production chain endpoints.

[ ] 048. Ensure synthetic wallets are clearly identified.

[ ] 049. Keep private keys limited to test/mock environments.

[ ] 050. Review environment configuration for secrets.


Phase 4 — Synthetic Wallets

[ ] 051. Identify the wallet format required by the application.

[ ] 052. Reuse existing test wallet generation utilities.

[ ] 053. Create deterministic synthetic wallet identities.

[ ] 054. Generate enough wallets for the small profile.

[ ] 055. Generate additional wallets for the large profile.

[ ] 056. Label wallets by their test purpose.

[ ] 057. Create seller wallets.

[ ] 058. Create buyer wallets.

[ ] 059. Create bidder wallets.

[ ] 060. Create collector wallets.

[ ] 061. Ensure wallet addresses are synthetic.

[ ] 062. Ensure wallets cannot represent production accounts.

[ ] 063. Keep mock private keys isolated.

[ ] 064. Document the synthetic wallet strategy.

[ ] 065. Test wallet generation deterministically.


Phase 5 — Database Seed Data

[ ] 066. Identify all database tables requiring seed data.

[ ] 067. Create deterministic users.

[ ] 068. Create deterministic profiles.

[ ] 069. Create deterministic listings.

[ ] 070. Create active listings.

[ ] 071. Create sold listings.

[ ] 072. Create expired listings.

[ ] 073. Create cancelled listings.

[ ] 074. Create auction records.

[ ] 075. Create active auctions.

[ ] 076. Create completed auctions.

[ ] 077. Create expired auctions.

[ ] 078. Create offer records.

[ ] 079. Create accepted offers.

[ ] 080. Create rejected offers.

[ ] 081. Create pending offers.

[ ] 082. Create collection records.

[ ] 083. Create collection ownership data.

[ ] 084. Create metadata records.

[ ] 085. Create missing/edge-case metadata.

[ ] 086. Create reorganization-related records.

[ ] 087. Create relationships between all seeded entities.

[ ] 088. Ensure foreign keys remain valid.

[ ] 089. Ensure timestamps are deterministic.

[ ] 090. Verify seeded database integrity.


Phase 6 — Mock-Chain Data

[ ] 091. Reuse the existing E2E mock-chain capabilities.

[ ] 092. Identify the required blockchain event types.

[ ] 093. Generate deterministic block data.

[ ] 094. Generate deterministic transaction identities.

[ ] 095. Generate valid event identities.

[ ] 096. Create listing events.

[ ] 097. Create auction events.

[ ] 098. Create offer events.

[ ] 099. Create collection events.

[ ] 100. Create metadata events.

[ ] 101. Create ownership-transfer events.

[ ] 102. Create reorganization scenarios.

[ ] 103. Ensure event ordering is valid.

[ ] 104. Ensure transaction relationships are valid.

[ ] 105. Ensure block relationships are valid.

[ ] 106. Ensure event IDs cannot collide unexpectedly.

[ ] 107. Link chain events to seeded database records.

[ ] 108. Verify the mock chain starts cleanly.

[ ] 109. Verify the mock chain can be reseeded.

[ ] 110. Verify chain fixtures remain deterministic.


Phase 7 — Small & Large Profiles

[ ] 111. Implement the small profile.

[ ] 112. Keep the small profile fast.

[ ] 113. Include at least one useful example of every major entity.

[ ] 114. Include active listings.

[ ] 115. Include auctions.

[ ] 116. Include offers.

[ ] 117. Include collections.

[ ] 118. Include metadata.

[ ] 119. Include at least one reorg scenario.

[ ] 120. Implement the large profile.

[ ] 121. Generate significantly more listings.

[ ] 122. Generate multiple auctions.

[ ] 123. Generate multiple offer states.

[ ] 124. Generate multiple collections.

[ ] 125. Generate varied metadata.

[ ] 126. Generate larger ownership sets.

[ ] 127. Include realistic pagination data.

[ ] 128. Include realistic search/filter data.

[ ] 129. Ensure the large profile remains deterministic.

[ ] 130. Measure large-profile execution time.


Phase 8 — Reset & Documentation

[ ] 131. Implement a safe reset command.

[ ] 132. Ensure reset only targets local/test resources.

[ ] 133. Prevent accidental production resets.

[ ] 134. Remove seeded database records during reset.

[ ] 135. Reset mock-chain state.

[ ] 136. Reset synthetic wallets where necessary.

[ ] 137. Reset deterministic counters.

[ ] 138. Return the database to a known clean state.

[ ] 139. Return the mock chain to a known clean state.

[ ] 140. Test seed → reset → seed.

[ ] 141. Test repeated seed execution.

[ ] 142. Test small-profile execution.

[ ] 143. Test large-profile execution.

[ ] 144. Update the local architecture guide.

[ ] 145. Document the one-command setup process.

[ ] 146. Document environment variables.

[ ] 147. Document small versus large profiles.

[ ] 148. Document reset behavior and safety warnings.

[ ] 149. Verify a new developer can start the stack and populate useful data with one documented command.

[ ] 150. Run the complete integration/E2E suite and confirm all major UI states work without production credentials.
