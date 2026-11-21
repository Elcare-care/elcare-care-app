# API & Event-Schema Versioning and Deprecation Policy

> Issue #1068. **Status:** Active. **Applies to:** the indexer HTTP API, the
> indexer SSE streams, and the on-chain contract event schemas the indexer
> consumes.
> Related: [`COMPATIBILITY.md`](../COMPATIBILITY.md) (release matrix),
> [`CONTRIBUTING-SCHEMA-CHANGES.md`](../CONTRIBUTING-SCHEMA-CHANGES.md)
> (DB + event-schema procedures), [`event-schema-reference.md`](event-schema-reference.md),
> [`sse-protocol.md`](sse-protocol.md).

This policy defines what counts as a breaking change, how a change is
versioned, how long a deprecated contract stays supported, and who approves
it. It formalises the rules already built into the code:

| Mechanism | Where | What it does today |
|---|---|---|
| `X-API-Version` response header | `indexer/src/api/versioning.ts` (`versioningMiddleware`, mounted for all routes in `routes.ts`) | Echoes the negotiated major version (currently always `1`) |
| Version negotiation | same | `Accept: application/vnd.elcarehub.v<N>+json` › `?version=<N>` › `X-API-Version: <N>` request header › default `1` |
| `Deprecation` / `Sunset` headers + `meta.deprecated` / `meta.sunset` | `versioning.ts` `ok()` envelope helper | Available, **not used by any route yet** |
| V1 response contracts | `versioning.ts` (`ListingResponseV1`, `AuctionResponseV1`, `OfferResponseV1`, …) | Zod schemas. A mismatch causes a 500 with a structured log, never a silently dropped field |
| OpenAPI spec | `indexer/openapi.json` / `indexer/openapi.yaml` (`info.version: 1.0.0`), generated from Zod by `npm run generate-openapi`; `npm run check-openapi` fails CI on drift | Machine-readable REST contract |
| Event `schema_version` | contract event structs in `contracts/soroban-marketplace/src/events.rs` | A version field inside each versioned event payload |
| `SUPPORTED_SCHEMA_VERSIONS` | `indexer/src/event-schemas.ts` | Highest `schema_version` per event type that the indexer understands (all `1` today). A missing field means implicit version `0`, which is always supported |
| Unsupported-version quarantine | `indexer/src/event-sync.ts` → `UnsupportedSchemaVersionError` | The event is dead-lettered as `UNSUPPORTED_SCHEMA_VERSION`, `indexer_unsupported_schema_version_total{event_type,schema_version}` goes up, and the event can be replayed once a decoder update ships |
| Event-schema lint | `npm run check-event-schemas` (CI job `event-schema-lint`) | Checks that contract structs and the indexer registry agree |

---

## 1. Owners

Owners come from [`.github/CODEOWNERS`](../.github/CODEOWNERS). Any PR that
touches a contract listed below needs approval from that contract's owner.

| Contract surface | Primary owner (approves) | Secondary reviewer | Deprecation announcement |
|---|---|---|---|
| HTTP REST API (`indexer/src/api/**`, `openapi.*`) | `@org/backend-lead-indexer` | `@org/frontend-lead` (main consumer) | `@org/backend-lead-indexer` |
| SSE streams (`/events`, `/notifications/stream`) | `@org/backend-lead-indexer` | `@org/frontend-lead` | `@org/backend-lead-indexer` |
| On-chain event schemas (`events.rs`, `event-schemas.ts`, parser) | `@org/backend-lead-contracts` | `@org/backend-lead-indexer` | `@org/backend-lead-contracts` |
| Database schema behind the API (`prisma/**`) | `@org/backend-lead-indexer` | `@org/backend-lead-contracts` | n/a (internal) |
| Release matrix (`COMPATIBILITY.md`) and rollout | `@org/devops` | relevant primary owner | `@org/devops` (release notes) |

The primary owner is responsible for: classifying the change (§2), choosing
the version bump (§3), setting the deprecation dates (§4), and making sure
`COMPATIBILITY.md` and `CHANGELOG.md` are updated in the same PR.

---

## 2. What counts as breaking

### 2.1 HTTP API (and SSE payloads)

| Change | Breaking? |
|---|---|
| Add a new endpoint, a new optional query parameter, or a new **optional/nullable** response field | No |
| Add a new enum value to a response field that clients may switch on (for example `status`) | **Yes for strict clients.** Treat it as minor, and announce it one release ahead |
| Remove or rename an endpoint, field, or query parameter | **Yes** |
| Change a field's type, format or units (for example stroops ↔ decimal string, number ↔ string) | **Yes** |
| Make an optional request parameter required, or tighten its validation regex | **Yes** |
| Change pagination/cursor semantics, sort order defaults, or error `code` values | **Yes** |
| Change the `error` envelope shape (`indexer/docs/error-response-examples.md`) | **Yes** |
| Change SSE frame naming, id format, or replay semantics (`sse-protocol.md`) | **Yes** |
| Change cache headers, ETag behaviour, or rate-limit thresholds | No. Document it in the changelog |

### 2.2 On-chain event schemas

| Change | Breaking? | Required action |
|---|---|---|
| Add a field to an event struct | Additive, but the indexer cannot *prove* that it is safe | Bump the struct's `schema_version`. Update `event-schemas.ts` + `SUPPORTED_SCHEMA_VERSIONS` **and deploy the indexer before the contract** |
| Remove/rename a field, change its type or meaning | **Yes** | New `schema_version`, and the indexer decodes old **and** new versions for the whole deprecation window |
| Rename an event topic / symbol (`TOPIC_MAP` in `parser.ts`) | **Yes** | Keep the old topic as an alias (like `listing_price_updated`) for the window |
| Add a new event type | No | Register it in `TOPIC_MAP` and `event-schemas.ts` first |
| Change any input to `eventHash` (`contractId`, ledger, `txHash`, `eventIndex`) | **Yes (data integrity)** | Not allowed without a migration plan. See [`guides/event-deduplication.md`](guides/event-deduplication.md) |

Events are immutable once they are on-chain. **The indexer must be able to
decode every `schema_version` that has ever been emitted**, so it can
backfill and replay dead letters. Old decoders can be removed from the *live*
path, but they must stay available for backfill.

---

## 3. Versioning rules

**HTTP API**

1. The API major version is the integer `N` used in `X-API-Version` and
   `application/vnd.elcarehub.vN+json`. A breaking change (§2.1) needs either
   a new major version served **alongside** the old one, or a deprecation
   (§4) of the affected field or endpoint while it stays in `v1`.
2. The OpenAPI `info.version` follows semver. MAJOR = the API major above.
   MINOR = an additive change. PATCH = docs/fix only. It must match the
   **Indexer** and **OpenAPI Spec** rows in `COMPATIBILITY.md`.
3. Every change to a route's Zod schema regenerates `openapi.json`
   (`npm run generate-openapi`) in the same PR. CI (`check-openapi`) blocks
   drift.
4. *Known gap:* `parseApiVersion` does not reject unknown versions today
   (for example, `?version=2` echoes `X-API-Version: 2` but serves v1). Before
   `v2` ships, the owner must add an explicit `406`/`400` for unsupported
   versions.

**Event schemas**

1. `schema_version` is a per-event-type integer that only ever increases.
   Never reuse or decrease it.
2. Bump the **Event Schema** row in `COMPATIBILITY.md` whenever any event
   type's maximum supported version changes.
3. Deploy in this order: **indexer (decoder) → verify → contract**. If an
   event arrives before its decoder, it is quarantined, not lost. Replay it
   after the decoder deploy (see `dead-letter-replay.ts`).

---

## 4. Deprecation windows

| Surface | Minimum notice before removal | Minimum overlap (old + new both served) |
|---|---|---|
| REST endpoint / field / parameter | **90 days** after the announcement | 90 days, and at least **two** frontend releases |
| SSE frame format / semantics | **60 days** | 60 days |
| Event `schema_version` (live decode path) | **90 days** after the contract stops emitting the old version on mainnet | Indefinite for backfill decoders (§2.2) |
| Event topic alias | **90 days** after the last emission on mainnet | — |
| Security fix that requires a breaking change | May be shortened by the primary owner **and** `@org/security-lead` | Record the reason in the changelog |

Deprecation procedure:

1. **Announce.** Add a `Deprecated` entry to `CHANGELOG.md` with the removal
   date, and mark the item `deprecated: true` in OpenAPI.
2. **Signal at runtime.** Serve the deprecated response through `ok(res,
   data, { deprecated: true, sunset: '<RFC 7231 date>' })`. This sets the
   `Deprecation: true` and `Sunset: <date>` headers and
   `meta.deprecated`/`meta.sunset`.
3. **Measure.** Watch `apiRequestDurationHistogram` (route label) for
   remaining traffic. Do not remove anything while a supported frontend
   release still calls it.
4. **Remove.** After the window ends, in a PR approved by the primary owner.
   Update `COMPATIBILITY.md` (new release row, minimum required versions).

---

## 5. Pull request checklist

Copy this into the PR description when a change touches an owned surface:

- [ ] Change is classified as breaking or non-breaking under §2 (state which row).
- [ ] Version bump chosen under §3: API major / OpenAPI semver / `schema_version`.
- [ ] `openapi.json` regenerated, and `COMPATIBILITY.md` + `CHANGELOG.md` updated.
- [ ] For event schemas, `npm run check-event-schemas` was run, and the indexer deploy comes before the contract deploy in the rollout plan.
- [ ] For deprecations, the removal date is ≥ the §4 window, and `Deprecation`/`Sunset` are wired up.
- [ ] The primary owner from §1 is requested as reviewer.
- [ ] No secrets, tokens, or raw PII (wallet addresses are pseudonymised in logs per `docs/LOGGING_POLICY.md`) in examples.

---

## 6. Review and revert

**Reviewing.** Check the mechanism table at the top against
`indexer/src/api/versioning.ts`, `indexer/src/event-schemas.ts`,
`indexer/src/event-sync.ts` (unsupported-version branch),
`indexer/package.json` (`generate-openapi`, `check-openapi`), and
`.github/CODEOWNERS`. Policy changes need approval from
`@org/backend-lead-indexer` **and** `@org/backend-lead-contracts`.

**Reverting.** This is a documentation-only policy. Revert with
`git revert <commit>`, which also removes the links added to
`CONTRIBUTING.md`, `DEPLOYMENT.md` and `docs/guides/deployment.md`. Runtime
behaviour is unaffected, because no code, configuration or schema changed.
