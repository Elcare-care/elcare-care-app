# @elcarehub/contract-abi

Versioned TypeScript types, error codes, event schemas, and compatibility utilities for the ElcareHub Soroban smart contracts.

This package eliminates drift between on-chain contract definitions and client TypeScript code by providing a single authoritative interface artifact that the frontend and indexer both import.

## Contents

| File | Purpose |
|------|---------|
| `abi.json` | Machine-readable JSON schema: methods, args, return types, event shapes, error codes |
| `src/marketplace.ts` | TypeScript types for the marketplace contract |
| `src/launchpad.ts` | TypeScript types for the launchpad factory contract |
| `src/compatibility.ts` | Version compatibility check utilities |
| `scripts/validate-abi.mjs` | CI validation script |

## Installation

```bash
npm install @elcarehub/contract-abi
```

## Usage

### Import types

```typescript
import {
  Listing, Auction, Offer, Recipient,
  ListingStatus, AuctionStatus, OfferStatus,
  MarketplaceErrorCode, MarketplaceErrorName,
  MARKETPLACE_CONTRACT_VERSION,
} from '@elcarehub/contract-abi';

import type { MarketplaceEventPayload } from '@elcarehub/contract-abi';

function handleEvent(event: MarketplaceEventPayload) {
  if (event.type === 'ARTWORK_SOLD') {
    console.log('Buyer:', event.data.buyer);
  }
}
```

### Version compatibility

```typescript
import { assertCompatibility } from '@elcarehub/contract-abi';

// Throws if major version mismatch with deployed contract
const deployedVersion = await contract.get_version();
assertCompatibility('marketplace', deployedVersion);
```

### Decode error codes

```typescript
import { MarketplaceErrorName } from '@elcarehub/contract-abi';
console.log(MarketplaceErrorName[3]); // → "ListingNotFound"
```

## Updating after a contract change

1. Update the Rust contract in `contracts/`.
2. Update `abi.json` — add/modify the affected method, event, or error.
3. Update `src/marketplace.ts` or `src/launchpad.ts` to match.
4. Bump `version` in `abi.json`, `package.json`, and the constant in `src/marketplace.ts`.
5. Run `npm run validate` to verify consistency.
6. Run `npm run build` to regenerate `dist/`.

The generated diff on `abi.json` and `src/` is the interface change review artifact.

## Validation

```bash
node scripts/validate-abi.mjs
```

Checks version consistency, unique error codes, event topics, and method shapes.
