# Implementation Plan: Search, Collection Details, Deployment Safety & Reproducibility

**Project**: ELCARE-HUB Soroban NFT Marketplace  
**Date**: 2026-07-26  
**Status**: Planning

## Overview

This document outlines the implementation plan for four critical features needed for the ELCARE-HUB marketplace:

1. **Server-Side Search & Filtering** - Scalable search across listings, collections, and NFTs
2. **Collection & Token Detail Pages** - Dedicated views for collection and token provenance
3. **Deployment Script Hardening** - Production-safe configuration and validation
4. **Build Reproducibility** - Verifiable link between source and deployed contracts

---

## Feature 1: Server-Side Search & Filtering

### Problem Statement
Client-only filtering does not scale and produces incomplete results when paginated. Users need to search listings and collections by title, creator, collection address, asset, status, price range, and date.

### Current State Analysis
- ✅ Prisma schema has `Listing`, `Collection`, `Auction`, `Offer` models
- ✅ Full-text search infrastructure exists (`searchVector` tsvector columns with GIN indexes)
- ✅ Basic indexes on `artist`, `status`, `updatedAtLedger` exist
- ❌ No API endpoints for server-side filtering
- ❌ Frontend hooks still do client-side filtering
- ❌ No price range, date range, or multi-field search support

### Database Schema Changes

#### Add indexes for common search patterns:
```sql
-- Price range queries (listings & auctions)
CREATE INDEX "Listing_price_idx" ON "Listing"("price") WHERE "status" = 'Active';
CREATE INDEX "Auction_reservePrice_idx" ON "Auction"("reservePrice") WHERE "status" = 'Active';

-- Date range queries
CREATE INDEX "Listing_createdAt_idx" ON "Listing"("createdAt");
CREATE INDEX "Collection_createdAt_idx" ON "Collection"("createdAt");

-- Composite for creator + status filtering
CREATE INDEX "Listing_artist_status_price_idx" ON "Listing"("artist", "status", "price");
```

### API Endpoints to Implement

#### 1. `GET /api/listings/search`
**Query Parameters:**
- `q` (string, optional): Full-text search query
- `creator` (string, optional): Filter by artist address
- `collection` (string, optional): Filter by collection contract address
- `status` (enum, optional): Active | Sold | Cancelled | Auction
- `minPrice` (decimal, optional): Minimum price
- `maxPrice` (decimal, optional): Maximum price
- `currency` (string, optional): Filter by payment token address
- `fromDate` (ISO8601, optional): Created after this date
- `toDate` (ISO8601, optional): Created before this date
- `sortBy` (enum, optional): price | createdAt | updatedAt (default: updatedAt)
- `sortOrder` (enum, optional): asc | desc (default: desc)
- `cursor` (string, optional): Pagination cursor
- `limit` (number, optional): Results per page (max 100, default 20)

**Response:**
```typescript
{
  data: Listing[],
  pagination: {
    nextCursor: string | null,
    hasMore: boolean,
    total: number
  }
}
```

#### 2. `GET /api/collections/search`
**Query Parameters:**
- `q` (string, optional): Full-text search (name/symbol)
- `creator` (string, optional): Filter by deployer address
- `kind` (enum, optional): normal_721 | normal_1155 | lazy_721 | lazy_1155
- `fromDate` (ISO8601, optional): Deployed after this date
- `sortBy` (enum, optional): deployedAtLedger | createdAt | name (default: deployedAtLedger)
- `sortOrder` (enum, optional): asc | desc (default: desc)
- `cursor`, `limit`

#### 3. `GET /api/auctions/search`
Similar to listings but with `reservePrice` range and `endTime` filtering.

### Implementation Steps

1. **Backend (Indexer)**
   - [ ] Create `indexer/src/api/routes/listings/search.ts`
   - [ ] Create `indexer/src/api/routes/collections/search.ts`
   - [ ] Create `indexer/src/api/routes/auctions/search.ts`
   - [ ] Implement query builder with Prisma for complex WHERE clauses
   - [ ] Implement cursor-based pagination using `updatedAtLedger` + `id`
   - [ ] Add input validation with Zod schemas
   - [ ] Add OpenAPI spec annotations
   - [ ] Update `indexer/openapi.yaml`

2. **Database Migration**
   - [ ] Create migration for new indexes
   - [ ] Test migration rollback safety

3. **Frontend Integration**
   - [ ] Create `frontend/src/hooks/useListingSearch.ts` with debouncing
   - [ ] Create `frontend/src/hooks/useCollectionSearch.ts`
   - [ ] Update `frontend/src/app/auctions/page.tsx` to use server-side filtering
   - [ ] Update `frontend/src/app/explore/page.tsx` with search UI
   - [ ] Add filter panel components (price range, date range, status toggles)
   - [ ] Implement request cancellation for stale searches

4. **Testing**
   - [ ] Unit tests for query builder edge cases (null values, empty strings)
   - [ ] Integration tests for each search endpoint
   - [ ] Test full-text search with special characters, partial matches
   - [ ] Test price range edge cases (zero, max decimal precision)
   - [ ] Test pagination boundary conditions (empty results, single page)
   - [ ] Load testing with 10k+ listings

---

## Feature 2: Collection & Token Detail Pages

### Problem Statement
Collectors need dedicated views to see collection metadata (supply, creator, royalty policy), individual token provenance (mint history, transfers, sales), and links to blockchain explorers.

### Current State Analysis
- ✅ `Collection` model exists with basic metadata
- ❌ No token-level tracking (NFT ownership, transfer history)
- ❌ No collection detail API endpoint
- ❌ No token detail API endpoint
- ❌ No frontend routes for `/collections/[address]` or `/tokens/[address]/[id]`

### Database Schema Changes

#### Add NFT Token model:
```prisma
model NFT {
  id                Int      @id @default(autoincrement())
  collection        String   // Contract address
  tokenId           BigInt
  owner             String   // Current owner address
  mintedBy          String   // Original minter
  mintedAtLedger    Int
  mintedAt          DateTime
  metadataUri       String?
  metadataHash      String?  // IPFS CID or hash
  metadataCached    Json?    // Cached metadata JSON
  
  // Denormalized for quick lookups
  lastTransferLedger Int?
  lastSalePrice      Decimal? @db.Decimal(32, 7)
  lastSaleLedger     Int?
  
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  
  @@unique([collection, tokenId])
  @@index([collection])
  @@index([owner])
  @@index([mintedBy])
  @@index([mintedAtLedger])
  @@index([collection, tokenId, owner])
}

model TokenTransfer {
  id             Int      @id @default(autoincrement())
  collection     String
  tokenId        BigInt
  from           String
  to             String
  ledgerSequence Int
  txHash         String
  transferredAt  DateTime
  
  @@index([collection, tokenId])
  @@index([from])
  @@index([to])
  @@index([ledgerSequence])
  @@unique([collection, tokenId, ledgerSequence, txHash])
}

// Extend Collection model (add to existing)
model Collection {
  // ... existing fields ...
  totalSupply       BigInt?  // For ERC1155
  maxSupply         BigInt?  // For capped collections
  royaltyBps        Int?     // Basis points (0-10000)
  royaltyRecipient  String?
  baseUri           String?
  deployTxHash      String?
}
```

### API Endpoints to Implement

#### 1. `GET /api/collections/[address]`
**Response:**
```typescript
{
  collection: {
    contractAddress: string
    kind: "normal_721" | ...
    creator: string
    name: string
    symbol: string
    totalSupply: bigint
    maxSupply: bigint | null
    royaltyBps: number
    royaltyRecipient: string
    deployedAtLedger: number
    deployTxHash: string
    createdAt: string
  },
  stats: {
    activeListings: number
    totalVolume: decimal
    floorPrice: decimal | null
    uniqueOwners: number
  },
  recentActivity: TokenTransfer[] // Last 20
}
```

#### 2. `GET /api/collections/[address]/tokens`
Paginated list of all tokens in collection with owner and metadata.

#### 3. `GET /api/tokens/[collection]/[tokenId]`
**Response:**
```typescript
{
  token: NFT,
  collection: Collection,
  currentListing: Listing | null,
  currentAuction: Auction | null,
  transferHistory: TokenTransfer[],
  salesHistory: Array<{
    price: decimal
    currency: string
    buyer: string
    seller: string
    ledger: number
    timestamp: string
  }>,
  royaltiesPaid: RoyaltyPayment[]
}
```

#### 4. `GET /api/tokens/[collection]/[tokenId]/activity`
Cursor-paginated activity feed (transfers, sales, listings, bids).

### Implementation Steps

1. **Smart Contract Event Parsing**
   - [ ] Update `indexer/src/parser.ts` to handle `Transfer` events from ERC721/ERC1155 contracts
   - [ ] Add `Mint` event parsing for lazy mint collections
   - [ ] Parse deployment transactions to extract collection metadata

2. **Database Migration**
   - [ ] Create migration for `NFT`, `TokenTransfer`, extended `Collection`
   - [ ] Backfill existing collections from `Listing.collection` unique values
   - [ ] Backfill NFT records from existing listings (mark as partial data)

3. **Indexer Updates**
   - [ ] Track additional contracts dynamically (add to `TrackedContract`)
   - [ ] Subscribe to Transfer events from all discovered collections
   - [ ] Implement metadata fetching worker (IPFS gateway)
   - [ ] Add stats aggregation queries

4. **API Routes**
   - [ ] Create `indexer/src/api/routes/collections/[address].ts`
   - [ ] Create `indexer/src/api/routes/tokens/[collection]/[tokenId].ts`
   - [ ] Add response caching (Redis) for collection stats

5. **Frontend**
   - [ ] Create `frontend/src/app/collections/[address]/page.tsx`
   - [ ] Create `frontend/src/app/tokens/[collection]/[tokenId]/page.tsx`
   - [ ] Add collection header component (banner, stats, verified badge)
   - [ ] Add token detail component (image, traits, provenance timeline)
   - [ ] Add chain explorer links (Stellar Expert, StellarChain)
   - [ ] Add IPFS gateway links with fallback

6. **Testing**
   - [ ] Test normal vs lazy mint collection variants
   - [ ] Test ERC721 vs ERC1155 differences
   - [ ] Test batch mint/transfer handling
   - [ ] Test missing metadata graceful fallback
   - [ ] Test unavailable IPFS content handling

---

## Feature 3: Deployment Script Hardening

### Problem Statement
Deployment scripts contain testnet defaults and hard-coded paths that are dangerous for production. Need explicit configuration, validation, and dry-run capability.

### Current State Analysis
- ✅ `scripts/deploy/deploy_contract.sh` exists
- ✅ Basic `--dry-run` flag implemented
- ❌ Hard-coded testnet RPC URL
- ❌ Hard-coded network passphrase
- ❌ Assumes local file paths for frontend `.env`
- ❌ No validation of required environment variables
- ❌ Testnet funding mixed with deployment logic

### Required Changes

#### 1. Environment Variable Schema
Create `scripts/deploy/config.schema.sh`:
```bash
# Required for all deployments
REQUIRED_VARS=(
  "NETWORK"              # testnet | mainnet
  "RPC_URL"              # https://...
  "STELLAR_SECRET"       # S...
  "CONTRACT_DIR"         # Full path to contract source
)

# Required for mainnet only
MAINNET_REQUIRED=(
  "DEPLOYMENT_APPROVER"  # Address that must sign off
  "BACKUP_RPC_URL"       # Fallback RPC
)

# Optional with safe defaults for local dev only
OPTIONAL_VARS=(
  "FRONTEND_ENV:./frontend/.env.local"
  "OUTPUT_DIR:./scripts/deploy/output"
  "SOROBAN_CLI_VERSION:23.0.0"
)
```

#### 2. Validation Function
Add to `deploy_contract.sh`:
```bash
validate_config() {
  local errors=0
  
  # Check required vars
  for var in "${REQUIRED_VARS[@]}"; do
    if [[ -z "${!var}" ]]; then
      echo "ERROR: Missing required variable: $var"
      ((errors++))
    fi
  done
  
  # Network-specific validation
  if [[ "$NETWORK" == "mainnet" ]]; then
    for var in "${MAINNET_REQUIRED[@]}"; do
      if [[ -z "${!var}" ]]; then
        echo "ERROR: Mainnet requires: $var"
        ((errors++))
      fi
    done
    
    # Extra safety checks
    if [[ "$RPC_URL" == *"testnet"* ]]; then
      echo "ERROR: Mainnet deployment cannot use testnet RPC"
      ((errors++))
    fi
  fi
  
  # Path validation
  if [[ ! -d "$CONTRACT_DIR" ]]; then
    echo "ERROR: Contract directory not found: $CONTRACT_DIR"
    ((errors++))
  fi
  
  return $errors
}
```

#### 3. Dry-Run Summary
```bash
print_deployment_summary() {
  cat <<EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DEPLOYMENT CONFIGURATION SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Network          : $NETWORK
  RPC URL          : $RPC_URL
  Deployer Address : $STELLAR_PUBLIC
  Contract Source  : $CONTRACT_DIR
  Output Directory : $OUTPUT_DIR
  Git Commit       : $(git rev-parse --short HEAD)
  Soroban CLI      : $(stellar version)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

EOF

  if [[ "$NETWORK" == "mainnet" ]]; then
    echo "⚠️  WARNING: This will deploy to MAINNET"
    echo "⚠️  Estimated cost: ~5 XLM for installation + deployment"
    echo ""
    read -p "Type 'DEPLOY TO MAINNET' to continue: " confirmation
    if [[ "$confirmation" != "DEPLOY TO MAINNET" ]]; then
      echo "Deployment cancelled."
      exit 1
    fi
  fi
}
```

### Implementation Steps

1. **Refactor Scripts**
   - [ ] Remove hard-coded RPC URLs, use `$RPC_URL` everywhere
   - [ ] Remove hard-coded network passphrases, derive from `$NETWORK`
   - [ ] Make frontend env path configurable with `$FRONTEND_ENV_PATH`
   - [ ] Move testnet funding to separate `scripts/deploy/fund_testnet_account.sh`
   - [ ] Add `scripts/deploy/config.schema.sh` validation library

2. **Argument Parsing**
   - [ ] Add flag parsing: `--network`, `--rpc-url`, `--contract-dir`, `--output-dir`
   - [ ] Prioritize flags > env vars > config file > error (no defaults)
   - [ ] Add `--config` flag to load from file (e.g., `.deploy.mainnet.env`)

3. **Safety Features**
   - [ ] Add network confirmation prompt for mainnet
   - [ ] Add WASM hash verification before deployment
   - [ ] Add deployed contract verification (test invocation)
   - [ ] Store deployment manifest with timestamp, git commit, WASM hash

4. **Separation of Concerns**
   - [ ] Extract `fund_account.sh` logic from `deploy_contract.sh`
   - [ ] Create `scripts/deploy/verify_deployment.sh` for post-deployment checks
   - [ ] Create `scripts/deploy/rollback.sh` for contract upgrades

5. **Testing**
   - [ ] Test in clean checkout (no local `.env` files)
   - [ ] Test with missing required vars (should fail gracefully)
   - [ ] Test mainnet config validation (reject testnet URLs)
   - [ ] Test dry-run shows correct summary
   - [ ] Document usage in `scripts/deploy/README.md`

---

## Feature 4: Build Reproducibility & Release Artifacts

### Problem Statement
No verifiable link between source commit, toolchain version, dependency lock, WASM hash, and deployed contract. Essential for auditing and incident response.

### Solution Design

#### Reproducible Build Environment
```dockerfile
# Dockerfile.build
FROM rust:1.75.0-slim

# Pin Soroban CLI version
ENV SOROBAN_CLI_VERSION=21.5.2
RUN cargo install --version $SOROBAN_CLI_VERSION soroban-cli

# Install cargo-auditable for supply chain security
RUN cargo install cargo-auditable

WORKDIR /workspace
COPY . .

# Deterministic build
RUN cargo build --release --target wasm32-unknown-unknown \
  && stellar contract optimize \
    --wasm target/wasm32-unknown-unknown/release/soroban_marketplace.wasm \
    --wasm-out target/soroban_marketplace_optimized.wasm

# Generate build manifest
RUN ./scripts/generate_manifest.sh > target/build_manifest.json
```

#### Build Manifest Schema
`scripts/build_manifest.schema.json`:
```json
{
  "schemaVersion": "1.0",
  "contract": {
    "name": "soroban-marketplace",
    "version": "0.3.0",
    "gitCommit": "abc123def",
    "gitTag": "v0.3.0",
    "gitDirty": false
  },
  "build": {
    "timestamp": "2026-07-26T12:00:00Z",
    "builder": "github-actions",
    "rustVersion": "1.75.0",
    "rustcCommit": "...",
    "sorobanCliVersion": "21.5.2",
    "cargoLockHash": "sha256:...",
    "buildFlags": ["--release", "--target=wasm32-unknown-unknown"]
  },
  "artifact": {
    "optimizedWasmPath": "target/soroban_marketplace_optimized.wasm",
    "optimizedWasmSha256": "a1b2c3...",
    "optimizedWasmSize": 245678,
    "unoptimizedWasmSha256": "d4e5f6..."
  },
  "dependencies": {
    "soroban-sdk": "21.7.4",
    "soroban-token-sdk": "21.7.4"
  },
  "deployment": {
    "network": "testnet",
    "contractId": "CA...",
    "wasmHash": "a1b2c3...",
    "deployTxHash": "0x...",
    "deployLedger": 12345,
    "deployedAt": "2026-07-26T12:30:00Z"
  },
  "signature": {
    "pubkey": "GA...",
    "signature": "..."
  }
}
```

### Implementation Steps

1. **Manifest Generation Script**
   - [ ] Create `scripts/generate_manifest.sh`
   - [ ] Extract git metadata (commit, tag, dirty status)
   - [ ] Extract Rust/Soroban CLI versions
   - [ ] Compute Cargo.lock hash
   - [ ] Compute WASM hashes (optimized + unoptimized)
   - [ ] Extract dependency versions from Cargo.toml
   - [ ] Output JSON manifest

2. **Deployment Integration**
   - [ ] Update `deploy_contract.sh` to load manifest
   - [ ] Verify WASM hash matches manifest before deployment
   - [ ] Append deployment info to manifest after success
   - [ ] Store final manifest in `scripts/deploy/deployments/mainnet-{timestamp}.json`

3. **CI/CD Pipeline**
   - [ ] Add GitHub Actions workflow for reproducible builds
   - [ ] Build contract in Docker container
   - [ ] Generate manifest as build artifact
   - [ ] Upload manifest to release assets
   - [ ] Fail build if WASM hash doesn't match previous build from same commit

4. **Verification Tool**
   - [ ] Create `scripts/verify_build.sh <manifest> <wasm-file>`
   - [ ] Recompute WASM hash and compare to manifest
   - [ ] Fetch on-chain contract code and compare hash
   - [ ] Verify git commit matches what's claimed

5. **Documentation**
   - [ ] Write `docs/guides/reproducible-builds.md`
   - [ ] Document how to reproduce a build from manifest
   - [ ] Document how to verify a deployed contract
   - [ ] Add manifest schema reference

6. **Testing**
   - [ ] Test manifest generation on clean checkout
   - [ ] Test verification passes for matching builds
   - [ ] Test verification fails for mismatched WASMs
   - [ ] Test deployment rejects mismatched WASM hash
   - [ ] Test manifest signed with deployer key (optional)

---

## Implementation Order

### Phase 1: Foundation (Week 1-2)
1. ✅ Review current codebase (completed above)
2. Database schema changes (Features 1 & 2)
3. Deployment script hardening (Feature 3)

### Phase 2: Backend (Week 3-4)
4. Search API endpoints (Feature 1)
5. Collection/Token API endpoints (Feature 2)
6. Build reproducibility scripts (Feature 4)

### Phase 3: Frontend (Week 5-6)
7. Search UI integration (Feature 1)
8. Collection/Token detail pages (Feature 2)
9. Updated deployment docs

### Phase 4: Testing & Polish (Week 7-8)
10. Comprehensive testing for all features
11. Performance optimization (query tuning, caching)
12. Documentation updates
13. Production deployment checklist

---

## Success Criteria

### Feature 1: Search
- [ ] Users can search 10k+ listings by title in <500ms
- [ ] Price range filters return accurate results
- [ ] Pagination works correctly for all filter combinations
- [ ] Search UI debounces input and cancels stale requests

### Feature 2: Collection Details
- [ ] Collection pages show complete provenance
- [ ] Token pages display full transfer and sales history
- [ ] IPFS metadata loads with graceful fallback
- [ ] Chain explorer links work for all networks

### Feature 3: Deployment Safety
- [ ] Production deployment requires explicit confirmation
- [ ] Missing required config fails before any blockchain interaction
- [ ] Dry-run accurately predicts deployment actions
- [ ] Scripts work from any workspace (no hard-coded paths)

### Feature 4: Reproducibility
- [ ] Any developer can reproduce WASM from manifest
- [ ] Deployed contracts can be verified against source
- [ ] Release artifacts include signed manifests
- [ ] CI pipeline enforces deterministic builds

---

## Risk Management

### Technical Risks
1. **Full-text search performance**: Mitigate with query limits, caching, read replicas
2. **IPFS gateway reliability**: Mitigate with multiple gateways, local caching
3. **Database migration downtime**: Mitigate with online migrations, feature flags

### Operational Risks
1. **Production deployment errors**: Mitigate with dry-run, staging environment, rollback plan
2. **WASM hash mismatches**: Mitigate with build verification in CI, manifest validation
3. **Indexer backfill time**: Mitigate with incremental rollout, parallel backfill jobs

---

## Next Steps

1. **Review this plan** with the team
2. **Prioritize features** (can be done independently)
3. **Create GitHub issues** for each implementation step
4. **Set up feature branches** and start implementation

Would you like me to begin implementing any specific feature first?
