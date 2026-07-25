# Event Parsing & Schema Decoding Guide

This guide covers how contract events are decoded from raw Soroban XDR into structured JSON models, how topic mappings operate, and how to resolve parser mismatches.

---

## 1. Event Decoding Pipeline

Soroban smart contracts emit events composed of XDR-encoded topics and data payloads. The indexer converts these into type-safe database records through the following pipeline:

```
      Raw Soroban RPC Event (XDR Base64)
                     │
                     ▼
           indexer/src/parser.ts
                     │
    1. Decode Topics array using `xdr.ScVal.fromXDR()`
                     │
    2. Map Topic Symbol to Event Type (`TOPIC_MAP`)
       e.g. "listing_created" ──► "LISTING_CREATED"
       e.g. ("deploy", "dep_n721") ──► "DEPLOY_NORMAL_721"
                     │
    3. Decode Data payload using Zod schema (`event-schemas.ts`)
                     │
    4. Compute Idempotent Event Hash:
       SHA256(contractId + ledgerSequence + txHash + eventIndex)
                     │
                     ▼
             DecodedEvent Object
```

---

## 2. Owning Files

- [`indexer/src/parser.ts`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/indexer/src/parser.ts): XDR topic decoding, `TOPIC_MAP`, and `computeEventHash`.
- [`indexer/src/event-schemas.ts`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/indexer/src/event-schemas.ts): Zod schemas for validating event payloads (`ListingCreatedSchema`, `ArtworkSoldSchema`, etc.).
- [`indexer/src/event-sync.ts`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/indexer/src/event-sync.ts): RPC event collection and filtering.
- [`contracts/soroban-marketplace/src/events.rs`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/contracts/soroban-marketplace/src/events.rs): Rust contract event definitions.

---

## 3. Topic Mappings

The table below maps contract Rust event topics to human-readable indexer `eventType` strings:

| Rust Topic Symbol | Indexer `eventType` | Primary Payload Fields |
|---|---|---|
| `listing_created` | `LISTING_CREATED` | `listing_id`, `seller`, `price`, `nft_contract`, `token_id`, `cid` |
| `artwork_sold` | `ARTWORK_SOLD` | `listing_id`, `buyer`, `seller`, `price` |
| `listing_cancelled` | `LISTING_CANCELLED` | `listing_id`, `seller`, `reason` |
| `listing_updated` | `LISTING_UPDATED` | `listing_id`, `price` |
| `bid_placed` | `BID_PLACED` | `auction_id`, `bidder`, `amount` |
| `auction_resolved` | `AUCTION_RESOLVED` | `auction_id`, `winner`, `winning_bid` |
| `offer_made` | `OFFER_MADE` | `listing_id`, `buyer`, `amount`, `expires_at` |
| `royalty_paid` | `ROYALTY_PAID` | `listing_id`, `recipient`, `amount` |
| `dep_n721` | `DEPLOY_NORMAL_721` | `collection_address`, `creator`, `name`, `symbol` |

---

## 4. Decision Tree & Diagnostics for Parsing Failures

```
                    [ Event Parsing Error ]
                               │
                               ▼
                     Inspect Indexer Logs
                               │
       ┌───────────────────────┴───────────────────────┐
       ▼                                               ▼
[ Unmapped Topic Warning ]                     [ Zod Schema Validation Error ]
       │                                               │
       ▼                                               ▼
 A new event was added in Rust                  Contract payload changed.
 contract.                                      Update Zod schema in
 Add topic to `TOPIC_MAP`                       `event-schemas.ts` to match
 in `indexer/src/parser.ts`.                    new fields.
```

### First Diagnostic Steps for Common Failures

#### Failure 1: Unmapped Event Topic
* **Sample Log:**
  ```text
  [warn] Skipping unknown contract event topic: "listing_featured" on ledger 123456
  ```
* **First Diagnostic Action:**
  1. Locate the event in `contracts/soroban-marketplace/src/events.rs`.
  2. Open `indexer/src/parser.ts` and add the new entry to `TOPIC_MAP`:
     ```ts
     const TOPIC_MAP: Record<string, string> = {
       ...
       'listing_featured': 'LISTING_FEATURED',
     };
     ```

#### Failure 2: Zod Payload Validation Failure
* **Sample Log:**
  ```text
  [error] Failed to decode payload for event LISTING_CREATED at tx 0xa1b2c3...: ZodError: [ { "code": "invalid_type", "path": ["price"], "expected": "bigint", "received": "string" } ]
  ```
* **First Diagnostic Action:**
  Compare the Rust event struct in `events.rs` with the corresponding Zod schema in `indexer/src/event-schemas.ts`. Ensure BigInt/ScVal data types match (e.g. `z.bigint()`).

---

## 5. Safe Redaction Guidance

> [!WARNING]
> When sharing event debug logs or test fixtures:

- Raw XDR strings and decoded event JSON objects contain **only public blockchain data** (addresses, token IDs, prices, CIDs) and are safe to publish.
- Do not log or attach environment variable files (`.env`) alongside event logs.
