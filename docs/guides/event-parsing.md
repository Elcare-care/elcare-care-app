# Event Parsing & Schema Decoding Guide

This guide covers how contract events are decoded from raw Soroban XDR into structured JSON models, how topic mappings operate, the event schema versioning policy (Issue #278), and how to resolve parser mismatches.

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
    3. Decode Data payload against a hand-written schema
       (`event-schemas.ts` — `SCHEMA_REGISTRY` + `decodeWithSchema()`;
        this is NOT Zod, it's a small in-house field-by-field validator)
                     │
    4. Schema-version gate: if `schema_version` is present and higher
       than this build's `SUPPORTED_SCHEMA_VERSIONS` entry, throw
       `UnsupportedSchemaVersionError` instead of accepting or generically
       failing (see §5 below)
                     │
    5. Compute Idempotent Event Hash:
       SHA256(contractId + ledgerSequence + txHash + eventIndex)
                     │
                     ▼
             DecodedEvent Object
```

---

## 2. Owning Files

- [`indexer/src/parser.ts`](../../indexer/src/parser.ts): XDR topic decoding, `TOPIC_MAP`, `computeEventHash`, the schema-version gate, and `UnsupportedSchemaVersionError`.
- [`indexer/src/event-schemas.ts`](../../indexer/src/event-schemas.ts): `SCHEMA_REGISTRY` (per-event-type `ContractEventSchema`), `decodeWithSchema()`, `SUPPORTED_SCHEMA_VERSIONS`, and `isSupportedSchemaVersion()`.
- [`indexer/src/event-sync.ts`](../../indexer/src/event-sync.ts): RPC event collection, and where decode/version-gate failures are counted (Prometheus) and logged.
- [`indexer/src/backfill.ts`](../../indexer/src/backfill.ts): replays historical ledger ranges through the same `collectMarketplaceEvents` path — this is how historical events get reprocessed if a gap or bug is found; there is no separate historical-decode code path to keep in sync.
- [`contracts/soroban-marketplace/src/events.rs`](../../contracts/soroban-marketplace/src/events.rs): Rust contract event definitions and topic constants — the versioning policy is documented at the top of this file.
- [`contracts/launchpad/src/events.rs`](../../contracts/launchpad/src/events.rs): launchpad deploy/admin/fee events (tuple-shaped, not `#[contracttype]` structs).

---

## 3. Topic Mappings

The table below maps contract Rust event topics to human-readable indexer `eventType` strings. This list mirrors `TOPIC_MAP` in `indexer/src/parser.ts` — if you add a topic constant to a contract's `events.rs`, add the corresponding row here **and** to `TOPIC_MAP`, or the event will be silently dropped (see §4, Failure 1).

| Rust Topic Symbol | Indexer `eventType` | Primary Payload Fields |
|---|---|---|
| `listing_created` | `LISTING_CREATED` | `listing_id`, `artist`, `price`, `currency`, `collection`, `token_id`, `ledger_sequence` |
| `artwork_sold` | `ARTWORK_SOLD` | `listing_id`, `artist`, `buyer`, `price`, `currency`, `ledger_sequence` |
| `listing_cancelled` | `LISTING_CANCELLED` | `listing_id`, `cancelled_by`, `reason`, `ledger_sequence` |
| `listing_updated` | `LISTING_UPDATED` | `listing_id`, `artist`, `new_price`, `collection`, `token_id`, `ledger_sequence` |
| `listing_price_updated` | `LISTING_PRICE_UPDATED` | `listing_id`, `old_price`, `new_price`, `updated_by` |
| `listing_expired` | `LISTING_EXPIRED` | `listing_id`, `expired_at`, `ledger_sequence` |
| `bid_placed` | `BID_PLACED` | `auction_id`, `bidder`, `bid_amount` |
| `auction_created` | `AUCTION_CREATED` | `auction_id`, `creator`, `reserve_price`, `token`, `collection`, `token_id`, `end_time` |
| `auction_resolved` | `AUCTION_RESOLVED` | `auction_id`, `winner`, `amount` |
| `auction_cancelled` | `AUCTION_CANCELLED` | `auction_id`, `cancelled_by` |
| `auction_extended` | `AUCTION_EXTENDED` | `auction_id`, `new_end_time` |
| `auction_bid_refunded` | `AUCTION_BID_REFUNDED` | `auction_id`, `bidder`, `amount`, `token`, `reason`, `ledger_sequence` |
| `auction_admin_cancelled` | `AUCTION_ADMIN_CANCELLED` | `auction_id`, `cancelled_by`, `refunded_amount`, `token`, `ledger_sequence` |
| `offer_made` | `OFFER_MADE` | `listing_id`, `offerer`, `amount`, `token`, `expires_at` |
| `offer_accepted` | `OFFER_ACCEPTED` | `offer_id`, `listing_id`, `offerer`, `amount` |
| `offer_rejected` | `OFFER_REJECTED` | `offer_id`, `listing_id`, `offerer` |
| `offer_withdrawn` | `OFFER_WITHDRAWN` | `offer_id`, `listing_id`, `offerer` |
| `offer_reclaimed` | `OFFER_RECLAIMED` | `offer_id`, `listing_id`, `offerer`, `amount` |
| `royalty_paid` | `ROYALTY_PAID` | `recipient`, `amount`, `listing_id` |
| `royalty_settlement` | `ROYALTY_SETTLEMENT` | `id`, `recipients[]`, `total_amount`, `token`, `ledger_sequence` |
| `protocol_fee_collected` | `PROTOCOL_FEE_COLLECTED` | `listing_id`, `amount`, `token`, `treasury` |
| `artist_revoked` | `ARTIST_REVOKED` | `artist` |
| `artist_reinstated` | `ARTIST_REINSTATED` | `artist` |
| `admin_transfer_proposed` | `ADMIN_TRANSFER_PROPOSED` | `current_admin`, `proposed_admin`, `expires_at` |
| `admin_transferred` | `ADMIN_TRANSFERRED` | `old_admin`, `new_admin` |
| `admin_proposal_cancelled` | `ADMIN_PROPOSAL_CANCELLED` | `current_admin`, `cancelled_candidate` |
| `contract_paused` / `contract_unpaused` | `CONTRACT_PAUSED` / `CONTRACT_UNPAUSED` | `paused_by` / `unpaused_by` |
| `collection_paused` / `collection_unpaused` | `COLLECTION_PAUSED` / `COLLECTION_UNPAUSED` | — |
| `function_paused` / `function_unpaused` | `FUNCTION_PAUSED` / `FUNCTION_UNPAUSED` | — |
| `("deploy", "dep_n721")` | `DEPLOY_NORMAL_721` | `[creator, contract_address, schema_version]` |
| `("deploy", "dep_n1155")` | `DEPLOY_NORMAL_1155` | `[creator, contract_address, schema_version]` |
| `("deploy", "dep_l721")` | `DEPLOY_LAZY_721` | `[creator, contract_address, schema_version]` |
| `("deploy", "dep_l1155")` | `DEPLOY_LAZY_1155` | `[creator, contract_address, schema_version]` |

`royalty_settlement`, `auction_bid_refunded`, and `auction_admin_cancelled` were added to the contract in Issues #270/#271 but were **not** previously wired into `TOPIC_MAP`/`SCHEMA_REGISTRY` — meaning every one of those events was silently dropped by the indexer. This was fixed as part of Issue #278; see §6 for why this class of gap is exactly what the versioning work is meant to catch going forward.

> Launchpad admin/fee/pause events (`fee_coll`, `cfg_fee`, `admin`+`proposed|accepted|cancelled`, `paused`, `wasm_set`) and NFT-collection-contract events (`mint`, `transfer`, `approve`, `appr_all`, `burn`, etc.) are emitted on-chain for audit history but are **not currently decoded by this indexer** — they have no `TOPIC_MAP`/`SCHEMA_REGISTRY` entry at all. If you add indexer support for them, give them a schema-version entry per §5 at the same time.

---

## 4. Decision Tree & Diagnostics for Parsing Failures

```
                    [ Event Parsing Error ]
                               │
                               ▼
                     Inspect Indexer Logs
                               │
   ┌───────────────────────────┼───────────────────────────┐
   ▼                           ▼                           ▼
[ Unmapped Topic ]   [ Schema Decode Error ]   [ Unsupported Schema Version ]
   │                           │                           │
   ▼                           ▼                           ▼
A new event was added   Contract payload changed    Event decoded fine, but its
in Rust contract.       shape in a way the          schema_version is higher than
Add topic to            indexer schema doesn't      SUPPORTED_SCHEMA_VERSIONS
`TOPIC_MAP` in           expect. Compare the         records for that event type.
`indexer/src/parser.ts`. struct in events.rs         Indexer needs an upgrade —
                         against event-schemas.ts.   see §5/§6.
```

### First Diagnostic Steps for Common Failures

#### Failure 1: Unmapped Event Topic
* **Symptom:** the event is silently absent from the database — `resolveEventType()` returns `null` and `parseMarketplaceEvent` returns `null`, so `collectMarketplaceEvents` never pushes it. There is currently no log line for this case (a known gap; see the launchpad/NFT note in §3).
* **First Diagnostic Action:**
  1. Locate the event in `contracts/soroban-marketplace/src/events.rs` (or the relevant contract's `events.rs`).
  2. Open `indexer/src/parser.ts` and add the new entry to `TOPIC_MAP`:
     ```ts
     const TOPIC_MAP: Record<string, string> = {
       ...
       'listing_featured': 'LISTING_FEATURED',
     };
     ```
  3. Add a matching `ContractEventSchema` to `event-schemas.ts` and register it in `SCHEMA_REGISTRY`.

#### Failure 2: Schema Decode Error
* **Sample Log:**
  ```text
  [SchemaDecodeError] LISTING_CREATED: Missing required field 'price'
  ```
* **First Diagnostic Action:**
  Compare the Rust event struct in `events.rs` with the corresponding schema in `indexer/src/event-schemas.ts`. Check field names, and that numeric fields use the right JS type after `scValToNative` (`i128`/`u64` → `bigint`, `u32` → `number`, `Address`/`Symbol` → `string`).

#### Failure 3: Unsupported Schema Version (Issue #278)
* **Sample Log:**
  ```json
  {"level":"warn","msg":"Unsupported event schema version — skipping event, indexer may be behind the deployed contract","eventType":"ARTWORK_SOLD","schemaVersion":2,"ledger":123456,"txHash":"..."}
  ```
* **What it means:** the event decoded structurally (all fields the indexer knows about are present and well-typed), but its `schema_version` is higher than `SUPPORTED_SCHEMA_VERSIONS[eventType]` in `event-schemas.ts`. This means the contract shipped a schema bump the indexer hasn't been updated to recognize as safe yet.
* **First Diagnostic Action:**
  1. Check `indexer_unsupported_schema_version_total{event_type,schema_version}` in Prometheus to see scope/volume.
  2. Diff the contract struct against the indexer schema for that event type; add the new field(s) as `optional: true` fields.
  3. Bump `SUPPORTED_SCHEMA_VERSIONS[eventType]` to the new version and deploy.
  4. No backfill/reprocessing is required — once deployed, the indexer will decode both old and new-shape events on the next poll, and can be pointed at historical ledgers via `backfill.ts` if you want those specific events re-ingested (they were never dropped, just skipped and logged — see §6).

---

## 5. Event Schema Versioning Policy (Issue #278)

Contract events and the indexer are separate deployables with independent release cadences, and the indexer must keep decoding **historical** ledger events indefinitely (raw XDR is retained/replayable via `backfill.ts`). The rules below make that safe:

1. **Additive-only.** A shape change is always a *new field* appended to the struct (contract side) and a corresponding *new optional field* in the matching schema (indexer side). Existing fields are never renamed, retyped, reordered, or removed.
2. **`schema_version` field.** Settlement/audit-critical events carry an explicit `schema_version: u32` field on the contract side (see the list in `contracts/soroban-marketplace/src/events.rs`'s module doc comment and `EVENT_SCHEMA_VERSION` constant). Events emitted before this field existed simply don't have it — the indexer treats an absent `schema_version` as **implicit version 0**, which is always supported.
3. **Fixed numeric encodings.** Once a field's numeric type is chosen (`i128` for amounts/prices, `u32` for ledger sequences, `u64` for ids/timestamps), it never changes. A different representation is always a new field.
4. **Topics are permanent.** A topic constant (e.g. `artwork_sold`) is never reused for a differently-shaped payload; a genuinely new event kind gets a new topic.
5. **Deprecation, never deletion.** Superseded fields are marked deprecated in a doc comment; they are never removed while any historical ledger data referencing them might need to be replayed.
6. **Version currently is 1** for every explicitly-versioned event (this is the initial rollout in Issue #278 — no prior version-0 events exist for the newly-versioned fields themselves, though the *events* predate the field).

### Current version catalog

| Event (contract struct) | `eventType` | Contract `schema_version`? | `SUPPORTED_SCHEMA_VERSIONS` |
|---|---|---|---|
| `ListingCreatedEvent` | `LISTING_CREATED` | yes | 1 |
| `ArtworkSoldEvent` | `ARTWORK_SOLD` | yes | 1 |
| `AuctionCreatedEvent` | `AUCTION_CREATED` | yes | 1 |
| `AuctionFinalizedEvent` | `AUCTION_RESOLVED` | yes | 1 |
| `OfferMadeEvent` | `OFFER_MADE` | yes | 1 |
| `OfferAcceptedEvent` | `OFFER_ACCEPTED` | yes | 1 |
| `ProtocolFeeCollectedEvent` | `PROTOCOL_FEE_COLLECTED` | yes | 1 |
| `RoyaltySettlementEvent` | `ROYALTY_SETTLEMENT` | yes | 1 |
| `AuctionBidRefundedEvent` | `AUCTION_BID_REFUNDED` | yes | 1 |
| `AuctionAdminCancelledEvent` | `AUCTION_ADMIN_CANCELLED` | yes | 1 |
| Launchpad deploy events (`publish_deploy`) | `DEPLOY_NORMAL_721` / `DEPLOY_NORMAL_1155` / `DEPLOY_LAZY_721` / `DEPLOY_LAZY_1155` | yes (3rd tuple element) | 1 |
| All other events in the tables above | (as listed) | no | not tracked — never required a shape change |

All other event structs (`ListingCancelledEvent`, `BidPlacedEvent`, `AuctionExtendedEvent`, admin-rotation events, pause events, etc.) do not carry `schema_version` because they've never needed a shape change; if one ever does, add the field and a `SUPPORTED_SCHEMA_VERSIONS` entry at that time, following the same convention.

### How to bump a version (worked example)

Say `ArtworkSoldEvent` needs a new `payment_rail: Symbol` field:

1. **Contract:** add `pub payment_rail: Symbol,` to the struct in `contracts/soroban-marketplace/src/events.rs`; bump `EVENT_SCHEMA_VERSION` to `2`; set `schema_version: EVENT_SCHEMA_VERSION` (now `2`) at every construction site in `contract.rs`.
2. **Indexer:** add `{ name: 'payment_rail', type: 'string', optional: true }` to `ARTWORK_SOLD_SCHEMA` in `event-schemas.ts`; bump `SUPPORTED_SCHEMA_VERSIONS.ARTWORK_SOLD` to `2`.
3. **Fixtures:** update/add an `ARTWORK_SOLD` fixture that includes `payment_rail` and one that omits it (pre-upgrade shape), so parser tests cover both — see §7.
4. **Docs:** update the catalog row above.
5. Deploy the indexer change **before or at the same time as** the contract upgrade — never after. Since the new field is optional, old-shape events (v1, no `payment_rail`) keep decoding exactly as before; new-shape events (v2) decode with `payment_rail` populated.

---

## 6. Migration Guidance for Historical Records

A schema/shape change **never requires rewriting historical rows**, because:

- The indexer decoder is additive-only (see §5) — the same `decodeWithSchema()` code path handles both the old and new shapes once the new field is marked `optional: true`.
- Raw XDR for every ledger event is replayable on demand via `indexer/src/backfill.ts`, so if a bug is found in how a field was previously (mis)decoded, the fix is: update the schema, then run a targeted backfill over the affected ledger range — not a one-off data migration script.
- Events that predate the `schema_version` field entirely are implicit version 0 (§5, rule 2) and always remain supported — there is no "version 0 sunset" date.

If an event was **silently dropped** (unmapped topic, like `royalty_settlement` before this issue — see §3), the fix is: add the `TOPIC_MAP`/`SCHEMA_REGISTRY` entries, deploy, then backfill the ledger range where the gap occurred so those specific events get ingested retroactively. This is the same backfill mechanism used for RPC-window gaps (`docs/guides/indexer-ingestion.md`).

If an event's `schema_version` is ever bumped in a way that turns out **not** to be safely additive (a mistake — this policy is designed to prevent that, but mistakes happen), the recovery path is: ship a hotfix contract that reverts to additive-only emission, treat the bad window as a data-quality incident, and use `backfill.ts` to re-ingest the affected range once the indexer schema is corrected. There is intentionally no automatic "migrate old rows to new shape" tooling — the additive-only policy is what makes that unnecessary in the common case.

---

## 7. Parser Test Coverage (Follow-up)

`indexer/src/__tests__/parser.test.ts` already has a per-event-type fixture table (see `LISTING_FIXTURE`, `ARTWORK_SOLD_FIXTURE`, etc.) that this versioning work was written to extend easily: each event type's schema-driven validation is table-driven, so adding coverage for a new event, or for the "no `schema_version`" vs. "`schema_version: 1`" vs. "unsupported future version" cases, is a matter of adding a fixture + a `[symbol, expectedType, fixture]` row, not new decoder logic. Tests were intentionally **not** added as part of Issue #278 (out of scope for that change); the acceptance-testing follow-up is:

- Add fixtures + assertions for `ROYALTY_SETTLEMENT`, `AUCTION_BID_REFUNDED`, and `AUCTION_ADMIN_CANCELLED` (newly wired into `TOPIC_MAP`/`SCHEMA_REGISTRY` here).
- Add a case per versioned event type that omits `schema_version` (legacy/implicit v0 — must still decode), a case with the current supported version, and a case with an out-of-range version (must throw `UnsupportedSchemaVersionError`, not `SchemaDecodeError`).

See also the **CI/fixture requirement** follow-up noted in `CONTRIBUTING.md`'s Documentation Review Policy: contract event changes and indexer event-schema changes should not be mergeable independently without updated fixtures covering both shapes, but wiring that up as an enforced CI gate is out of scope for this change and tracked as follow-up work.

---

## 8. Safe Redaction Guidance

> [!WARNING]
> When sharing event debug logs or test fixtures:

- Raw XDR strings and decoded event JSON objects contain **only public blockchain data** (addresses, token IDs, prices, CIDs) and are safe to publish.
- Do not log or attach environment variable files (`.env`) alongside event logs.
