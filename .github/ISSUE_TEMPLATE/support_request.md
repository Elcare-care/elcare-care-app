---
name: Support Request
about: Report a transaction failure, indexer lag, wallet issue, or other user-facing problem
title: "[SUPPORT] "
labels: support
assignees: ''
---

## Problem Summary

<!-- Brief description of what went wrong -->

---

## Request Details

### Request ID / Transaction Hash
<!-- If available, provide the transaction hash or request ID from the UI -->
```
Transaction Hash: 
Request ID: 
```

### Network
- [ ] Mainnet
- [ ] Testnet
- [ ] Local development

### Wallet Provider
- [ ] Freighter
- [ ] LOBSTR
- [ ] Magic.link (email/passkey)
- [ ] Other (specify): 

### Approximate Time
<!-- When did this occur? Include timezone if possible -->
```
Date/Time: 
Timezone: 
```

### Visible Error Code or Message
<!-- Copy the exact error message shown in the UI, browser console, or toast notification -->
```
Error Message: 


```

---

## 🔒 Security Notice

> **DO NOT share the following in this issue:**
> - Private keys (starting with `S...`)
> - Seed phrases or recovery phrases
> - Magic.link API keys or session tokens
> - Full credential-bearing URLs

**Safe to share:**
- Transaction hashes (`txHash: "a1b2c3d4..."`)
- Public Stellar addresses (`G...`)
- Error codes and messages
- Screenshots with sensitive data redacted

---

## Reproduction Steps

<!-- Describe step-by-step how to reproduce the issue -->

1. 
2. 
3. 

### Expected Behavior
<!-- What did you expect to happen? -->

### Actual Behavior
<!-- What actually happened? -->

---

## Diagnostic Information (Optional)

### Browser & Wallet Version
<!-- If you know the versions, include them here -->
```
Browser: 
Wallet Extension Version: 
```

### Frontend Console Logs
<!-- If there are relevant console errors, paste them here. Redact any sensitive data. -->
```


```

### Additional Context
<!-- Screenshots, network timeline, or other relevant information. Redact secrets. -->

---

## Severity Assessment (for triage)

- [ ] **Critical** — Funds at risk, cannot complete critical transaction
- [ ] **High** — Feature completely broken, blocking user workflow
- [ ] **Medium** — Feature partially broken, workaround exists
- [ ] **Low** — Minor UI issue, no functional impact

---

## Internal Use Only (maintainers fill this section)

### Escalation Path
- [ ] Assigned to: 
- [ ] Severity confirmed: 
- [ ] Related incident: 
- [ ] Requires contract investigation: Yes / No
- [ ] Requires indexer investigation: Yes / No
- [ ] Requires frontend investigation: Yes / No

### Resolution
- [ ] Root cause identified
- [ ] Fix deployed
- [ ] User notified
- [ ] Backlog item created (if needed): 
