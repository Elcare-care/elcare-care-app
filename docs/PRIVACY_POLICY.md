# ElcareHub Privacy Policy

> Last updated: July 2026

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
| Indexer database (listings, auctions, offers) | Active records indefinitely; cancelled/sold records per operator policy | Contact privacy@elcarehub.art |
| PostHog analytics | 90 days | PostHog data deletion API |
| Sentry error reports | 90 days | Sentry project deletion or purge |
| Admin audit log | Session lifetime | Cleared on logout / tab close |
| Blockchain records | Permanent | Not possible |
| IPFS metadata | Permanent | Not possible |
| Rate-limit counters | 60 seconds | Automatic (Redis TTL) |

---

## 7. User controls

| Control | Location |
|---|---|
| Analytics consent (opt-in / opt-out) | Settings → Privacy → Analytics |
| Wallet disconnect | Navbar → wallet menu, or Settings |
| Request data deletion | privacy@elcarehub.art |

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
