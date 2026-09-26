# Support Triage & Diagnostic Collection Guide

This guide defines safe diagnostic collection for support requests, severity classification, escalation paths, and safe redaction practices to protect user credentials.

---

## Table of Contents

- [Overview](#overview)
- [Safe Diagnostic Collection](#safe-diagnostic-collection)
- [Support Request Template](#support-request-template)
- [Frontend Copy-Diagnostic Action](#frontend-copy-diagnostic-action)
- [Severity Classification](#severity-classification)
- [Escalation Paths](#escalation-paths)
- [Transaction State Distinctions](#transaction-state-distinctions)
- [Runbook References](#runbook-references)

---

## Overview

Users experiencing transaction failures, wallet issues, indexer lag, or reorgs need support responses that are **accurate**, **safe**, and **actionable**. Support engineers must collect enough information to investigate without requesting secrets like private keys, seed phrases, or credential-bearing URLs.

**Core principles:**
1. **Never ask users for private keys or seed phrases.**
2. **Collect stable identifiers:** transaction hash, public address, request ID, network, timestamp.
3. **Provide clear state distinctions:** pending vs. failed vs. reorg-corrected.
4. **Escalate based on severity and domain.**

---

## Safe Diagnostic Collection

### ✅ Safe to Collect

| Data Type | Example | Why It's Safe |
|---|---|---|
| Transaction hash | `a1b2c3d4e5f6...` | Public blockchain data |
| Public Stellar address | `GBUYER...` | Public identifier, no signing capability |
| Request ID | `req_1234567890` | Application-level correlation ID |
| Error code | `Error(Contract, #23)` | No secrets, helps root-cause |
| Visible error message | `Insufficient token balance` | User-facing copy, no credentials |
| Approximate time | `2026-08-26 14:35 UTC` | Helps locate logs and ledger range |
| Network | `testnet` / `mainnet` | Required for investigation |
| Wallet type | `Freighter` / `Magic.link` | Helps identify wallet-specific issues |

### ❌ Never Request

| Data Type | Why It's Dangerous | Alternative |
|---|---|---|
| Private key (`S...`) | Full account control, irreversible if leaked | Use public address (`G...`) |
| Seed phrase / recovery phrase | Permanent account takeover | Use transaction hash |
| Magic.link session token | Session hijacking | Use request ID from UI |
| Full URL with auth params | Credential leakage via logs/screenshots | Use redacted URL or route name |
| API keys in screenshots | Service compromise | Redact `.env` values |

---

## Support Request Template

Users can open a support request using `.github/ISSUE_TEMPLATE/support_request.md`. The template automatically prompts for safe diagnostic fields and includes a security notice warning against sharing secrets.

**Key sections:**
1. **Request Details** — transaction hash, network, wallet, time, error message
2. **Security Notice** — explicit list of what NOT to share
3. **Reproduction Steps** — step-by-step failure scenario
4. **Diagnostic Information** — browser version, console logs (redacted)
5. **Severity Assessment** — triage level for maintainers

**Template location:** [`.github/ISSUE_TEMPLATE/support_request.md`](../../.github/ISSUE_TEMPLATE/support_request.md)

---

## Frontend Copy-Diagnostic Action

### Implementation Plan

Add a **"Copy Diagnostic Info"** button to the transaction error toast or failure modal. When clicked, it copies a safe, pre-redacted diagnostic payload to the user's clipboard.

**Implementation location:** `frontend/elcarehub-app/src/components/ErrorToast.tsx` or `CheckoutModal.tsx`

### Example Diagnostic Payload

```json
{
  "type": "transaction_failure",
  "timestamp": "2026-08-26T14:35:22.123Z",
  "network": "testnet",
  "txHash": "a1b2c3d4e5f6789...",
  "publicAddress": "GBUYER...",
  "walletType": "Freighter",
  "errorCode": "Contract#23",
  "errorMessage": "Insufficient token balance to complete this transaction.",
  "requestId": "req_1234567890",
  "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)...",
  "appVersion": "1.2.3"
}
```

**Redacted fields (never included):**
- Private keys
- Seed phrases
- Magic.link session tokens
- Full URLs with auth params
- Environment variables

### Safe Redaction Logic

```typescript
// frontend/elcarehub-app/src/lib/diagnostic-redaction.ts

export interface DiagnosticPayload {
  type: 'transaction_failure' | 'wallet_connection_failure' | 'indexer_lag';
  timestamp: string;
  network: string;
  txHash?: string;
  publicAddress?: string;
  walletType?: string;
  errorCode?: string;
  errorMessage?: string;
  requestId?: string;
  userAgent: string;
  appVersion: string;
}

export function createSafeDiagnostic(context: {
  txHash?: string;
  publicAddress?: string;
  walletType?: string;
  errorCode?: string;
  errorMessage?: string;
  requestId?: string;
}): DiagnosticPayload {
  return {
    type: 'transaction_failure',
    timestamp: new Date().toISOString(),
    network: process.env.NEXT_PUBLIC_STELLAR_NETWORK || 'unknown',
    txHash: context.txHash,
    publicAddress: context.publicAddress,
    walletType: context.walletType,
    errorCode: context.errorCode,
    errorMessage: context.errorMessage,
    requestId: context.requestId,
    userAgent: navigator.userAgent,
    appVersion: process.env.NEXT_PUBLIC_APP_VERSION || 'unknown',
  };
}

export async function copyDiagnosticToClipboard(payload: DiagnosticPayload): Promise<void> {
  const formatted = JSON.stringify(payload, null, 2);
  await navigator.clipboard.writeText(formatted);
}
```

### Testing Against Secret Fixtures

Add a test that verifies the diagnostic payload does not leak secrets:

```typescript
// frontend/elcarehub-app/src/__tests__/diagnostic-redaction.test.ts

import { createSafeDiagnostic } from '@/lib/diagnostic-redaction';

it('does not include private keys in diagnostic payload', () => {
  const payload = createSafeDiagnostic({
    txHash: 'abc123',
    publicAddress: 'GBUYER...',
    walletType: 'Freighter',
    errorCode: 'Contract#23',
    errorMessage: 'Insufficient balance',
    requestId: 'req_123',
  });

  const serialized = JSON.stringify(payload);
  expect(serialized).not.toMatch(/S[A-Z0-9]{55}/); // Stellar private key format
  expect(serialized).not.toMatch(/pk_live_[a-zA-Z0-9]+/); // Magic.link API key format
  expect(serialized).not.toMatch(/authorization.*Bearer/i); // Bearer tokens
});
```

---

## Severity Classification

Use the following severity levels for triage and SLA assignment:

| Severity | Definition | Response Time | Example |
|---|---|---|---|
| **Critical** | Funds at risk, cannot complete critical transaction, data loss | 1 hour | Contract pause, wallet compromise, settlement error |
| **High** | Feature completely broken, blocking user workflow | 4 hours | Cannot list artwork, bids failing, indexer completely stalled |
| **Medium** | Feature partially broken, workaround exists | 1 business day | Image upload slow, activity feed not updating, minor UI glitch |
| **Low** | Minor UI issue, no functional impact | 1 week | Tooltip typo, color inconsistency, missing translation |

**Escalation trigger:** If a Medium severity issue affects >10 users or >1 hour, escalate to High.

---

## Escalation Paths

### Domain-Based Routing

| Issue Domain | Primary Owner | Secondary Escalation | Slack Channel |
|---|---|---|---|
| Contract execution errors | Backend Lead (contracts) | Security Lead | #alerts |
| Indexer lag / stalls | Backend Lead (indexer) | DevOps Engineer | #alerts |
| Wallet connection failures | Frontend Lead | Backend Lead | #support |
| Transaction UI errors | Frontend Lead | Backend Lead | #support |
| Payment token issues | Backend Lead (contracts) | Security Lead | #alerts |
| Reorg-related failures | Backend Lead (indexer) | DevOps Engineer | #alerts |

### Escalation Procedure

1. **Acknowledge** the support request within the severity response time.
2. **Collect diagnostics** using the support template or copy-diagnostic action.
3. **Classify severity** and assign domain owner.
4. **Investigate** using runbooks, metrics dashboards, and logs.
5. **Resolve** or escalate to secondary owner if outside domain expertise.
6. **Document** resolution in the support issue and close.
7. **Create backlog item** if a systemic issue or reliability gap is identified.

---

## Transaction State Distinctions

Users often confuse pending, failed, and reorg-corrected transactions. Support responses must clarify the exact state.

### State Definitions

| State | User-Facing Copy | Diagnostic Guidance |
|---|---|---|
| **Pending** | "Your transaction is being confirmed on the blockchain. This may take 5–10 seconds." | Check `txHash` in Stellar explorer. If ledger confirmed, check indexer lag. |
| **Failed** | "Your transaction failed with error: [message]. No funds were transferred." | Extract contract error code. Check wallet balance, allowances, authorization. |
| **Reorg-Corrected** | "A blockchain reorganization occurred. Your transaction was reverted and must be retried." | Check `docs/runbooks/reorganization.md`. Verify transaction was dropped from chain. |
| **Rejected by User** | "You cancelled the transaction in your wallet. No action was taken." | Expected behavior. No investigation needed. |

### Example Response Templates

#### Pending Transaction
```
Your transaction is pending confirmation on the Stellar blockchain.

Transaction Hash: a1b2c3d4e5f6...
Network: Testnet
Status: Waiting for ledger inclusion

Expected wait time: 5–10 seconds. If this transaction has been pending for >1 minute, please share your transaction hash and we'll investigate.
```

#### Failed Transaction
```
Your transaction failed with error code #23: "Insufficient token balance."

To resolve this issue:
1. Ensure your wallet has enough XLM to cover the transaction amount plus network fees.
2. Check your balance in Freighter or the Stellar laboratory.
3. If your balance is sufficient, please share your transaction hash for further investigation.

No funds were transferred. You can retry the transaction once your balance is confirmed.
```

#### Reorg-Corrected Transaction
```
A blockchain reorganization occurred, and your transaction was reverted.

What happened: The Stellar network temporarily rolled back recent ledgers. Your transaction was valid but was dropped during the reorganization.

Next steps:
1. Retry the transaction in the UI.
2. Your wallet balance was not affected by the reorg.
3. If you continue to see failures, share your transaction hash and we'll investigate.
```

---

## Runbook References

For common failure modes, refer to the following operational runbooks:

| Failure Mode | Runbook | Quick Fix |
|---|---|---|
| Indexer stalled / lagging | [`stalled-ingestion.md`](../runbooks/stalled-ingestion.md) | Check poller health, restart if needed |
| Reorg detected | [`reorganization.md`](../runbooks/reorganization.md) | Verify rollback depth, re-index affected range |
| Wallet connection failure | [`wallet-incompatibility.md`](../runbooks/wallet-incompatibility.md) | Check wallet extension version, network mismatch |
| Contract paused | [`contract-pause.md`](../runbooks/contract-pause.md) | Verify pause state, notify users, resume when safe |
| IPFS metadata unavailable | [`pinata-outage.md`](../runbooks/pinata-outage.md) | Check Pinata status, display fallback UI |
| Transaction simulation error | [`frontend-transaction-debugging.md`](./frontend-transaction-debugging.md) | Extract contract error code, verify parameters |

---

## Change Log

| Date | Change |
|---|---|
| 2026-08-26 | Initial support triage guide (Issue #347) |
