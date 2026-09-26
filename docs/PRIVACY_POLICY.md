# ElcareHub Privacy Policy

> Last updated: August 2026

ElcareHub is a non-custodial NFT marketplace. We do not create accounts,
store passwords, or hold funds. This document explains what data is collected,
why, how long it is kept, and what cannot be removed.

---

## 1. Data inventory

| Data | Where stored | Purpose | Retention |
|---|---|---|---|
| Wallet public key | Indexer database | Link listings, offers, bids to a wallet | While listings exist; pseudonymised in analytics |
| Transaction hashes | Indexer database + blockchain | Confirm on-chain state | Permanent (mirrors public chain) |
| NFT metadata CIDs | Smart contract + IPFS | Display artwork | Permanent — IPFS is immutable |
| Page view / interaction events | PostHog (opt-in only) | Product analytics | 90 days; never sent without consent |
| Error reports | Sentry | Bug tracking | 90 days; PII stripped |
| Admin audit events | Browser sessionStorage | Operator accountability | Session lifetime; cleared on logout |
| Rate-limit counters | Redis (indexer) | Abuse prevention | 60-second TTL |
| Privacy requests (export/deletion) | Indexer database (`PrivacyRequest`) | Self-service data export and deletion (section 6) | Request metadata retained as an audit trail; export payloads purged on deletion request |

---

## 2. Analytics — consent-gated

PostHog analytics fires **only** when the user has actively granted consent via
**Settings → Privacy → Analytics**. The default on first visit is **opted out**.

When analytics runs:

- Page views are recorded with sensitive URL parameters stripped (`artist`, `address`, `wallet`, `q`).
- Marketplace events (listing created, purchase, bid placed) are recorded as aggregate counters.
- Wallet addresses are pseudonymised to a 4+4-character prefix (e.g. `GCAT…ZXAB`).
- No full key, email, or IP address is sent.

Consent is stored in `localStorage` under `elcarehub:analytics_consent` and
applied at PostHog init (`opt_out_capturing_by_default`). Changing the setting
takes effect immediately without a page reload.

---

## 3. Error monitoring (Sentry)

Sentry is always active. Configuration enforces:

- `sendDefaultPii: false` — no user-identifying fields are included by default.
- Authorization and Cookie headers are stripped from request contexts in `beforeSend`.
- Session replay masks all text and blocks all media.
- User-rejected wallet transactions are dropped and never sent to Sentry.

Retention: 90 days.

---

## 4. Blockchain and IPFS — what cannot be deleted

Any signed transaction (create listing, buy artwork, place bid, accept offer) is
permanently recorded on the Stellar public blockchain. **We cannot delete blockchain
records.**

NFT artwork metadata stored on IPFS is content-addressed and permanently pinned once
the CID is referenced by a contract. **We cannot delete IPFS-pinned content.**

If you are a creator, do not include personal information in artwork metadata that
you may need to remove later.

---

## 5. Admin audit logging

Privileged operations in the admin dashboard produce structured audit events
containing:

- Action name and outcome (`success` / `rejected` / `failed` / `initiated`)
- Pseudonymised admin key prefix (first 4 + last 4 chars)
- Transaction hash if produced
- Network and contract ID

Audit events are stored in browser `sessionStorage` and are cleared on logout,
session expiry, or tab close. They are also forwarded as Sentry breadcrumbs for
error correlation.

**Never recorded:** private keys, raw signatures, JWT tokens, or secret values.

---

## 6. Retention summary

| Category | Retention | Deletion mechanism |
|---|---|---|
| Indexer database — listings, auctions, offers, bids, royalty payments, marketplace events | Indefinitely — mirrors the public Stellar ledger | Not possible; canonical on-chain mirror. Exported by reference (ids/hashes) on request, never deleted. |
| Indexer database — operational audit log (`OperationalAudit`) | Indefinitely — operator accountability record | Not possible; exported by reference on request, never deleted. |
| Indexer database — privacy request records (`PrivacyRequest`) | Indefinitely as an audit trail; generated export documents | Export payloads are purged when you submit a deletion request; request metadata (id, type, status, timestamps) is retained for audit. |
| PostHog analytics | 90 days | PostHog data deletion API |
| Sentry error reports | 90 days | Sentry project deletion or purge |
| Admin audit log | Session lifetime | Cleared on logout / tab close |
| Frontend support reports | Ephemeral in-memory MVP store; cleared on server restart | Not currently persisted long enough to require a deletion request |
| Blockchain records | Permanent | Not possible |
| IPFS metadata | Permanent | Not possible |
| Rate-limit counters | 60 seconds | Automatic (Redis TTL) |

### Self-service export and deletion

Any connected wallet can request an export or deletion of its eligible off-chain
data from **Settings → Data & Privacy Controls** (backed by
`POST /privacy/requests` on the indexer API — see section 7). Because ElcareHub
has no accounts or passwords, a wallet address is itself the identity used to
scope a request, the same trust model already used for `/wallets/{address}/...`
endpoints — there is no additional signature challenge.

- **Export** returns a JSON document listing ELIGIBLE off-chain data (currently:
  your own previously generated export documents) plus a RETAINED section that
  references canonical on-chain-mirrored records (listing/auction/offer/bid ids,
  royalty payments, operational audit event count) for informational
  completeness — those records are not included as deletable data.
- **Deletion** purges ELIGIBLE off-chain data (currently: previously generated
  export payloads) and reports, in `retainedRecordsNote`, exactly what could not
  be deleted and why (canonical blockchain mirror or audit requirement).
- Requests are tracked with a status (`PENDING → VERIFIED → PROCESSING →
  COMPLETED`, or `REJECTED`/`FAILED`) and an audit note. No private keys,
  signatures, or other secrets are ever stored on a privacy request.

---

## 7. User controls

| Control | Location |
|---|---|
| Analytics consent (opt-in / opt-out) | Settings → Privacy → Analytics |
| Wallet disconnect | Navbar → wallet menu, or Settings |
| Request a data export | Settings → Data & Privacy Controls → "Request data export" |
| Request account deletion | Settings → Data & Privacy Controls → "Request account deletion" |
| Check request status / download a completed export | Settings → Data & Privacy Controls → Request history |
| Escalate, or request anything outside the self-service flow (e.g. blockchain/IPFS questions) | privacy@elcarehub.art |

Self-service requests are handled immediately (see section 6) since wallet
identity is the verification step. Email remains available as a fallback for
anything the automated flow cannot cover.

---

## 8. Third-party processors

| Service | Role | Their privacy policy |
|---|---|---|
| Stellar / Soroban RPC | Blockchain read/write | Public blockchain — no privacy policy applies |
| Pinata | IPFS pinning | https://pinata.cloud/privacy |
| PostHog | Analytics (opt-in) | https://posthog.com/privacy |
| Sentry | Error monitoring | https://sentry.io/privacy |
| Vercel | Frontend hosting | https://vercel.com/legal/privacy-policy |
| Magic.link | Optional email wallet | https://magic.link/legal/privacy-policy |

---

## 9. Contact

For any privacy requests: **privacy@elcarehub.art**

See the in-app [Privacy Policy](/privacy) for the user-facing version of this document.
