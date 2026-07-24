# Security Triage & Scanning Guide

This guide covers security scanning processes, triaging automated security tool findings (Cargo Audit, npm audit, Gitleaks), and enforcing strict Safe Redaction policies.

---

## 1. Automated Security Scans

The repository runs automated security checks on every pull request to enforce supply-chain security and prevent secret leaks:

| Scanner | Target | Configuration File | Command |
|---|---|---|---|
| **Cargo Audit** | Rust dependencies | [`.cargo/audit.toml`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/.cargo/audit.toml) | `cargo audit --deny warnings` |
| **npm Audit** | Node.js dependencies | `package.json` files | `npm audit --audit-level=high` |
| **Gitleaks** | Secret detection in commits | [`.gitleaks.toml`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/.gitleaks.toml) | `gitleaks detect --verbose` |

---

## 2. Owning Files & Documentation

- [`SECURITY_SCANNING_TRIAGE.md`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/SECURITY_SCANNING_TRIAGE.md): In-depth triage procedure for advisories and false positives.
- [`SECURITY.md`](file:///Users/sam/Desktop/Grantfox/elcare-care-app/SECURITY.md): Responsible vulnerability disclosure policy.

---

## 3. Command Reference

### Run Local Cargo Audit
```bash
cargo audit
```

### Run Local npm Audit
```bash
# Frontend
cd frontend/elcarehub-app
npm audit --audit-level=high

# Indexer
cd indexer
npm audit --audit-level=high
```

### Run Local Secret Detection
```bash
gitleaks detect --verbose
```

---

## 4. Decision Tree for Security Finding Triage

```
                     [ Security Scan Failure in CI ]
                                    │
                                    ▼
                         Determine Failure Type
                                    │
       ┌────────────────────────────┼────────────────────────────┐
       ▼                            ▼                            ▼
[ Cargo / npm Advisory ]    [ Committed Secret Alert ]  [ Security Vulnerability ]
       │                            │                            │
       ▼                            ▼                            ▼
 1. Run `npm audit fix`     1. DO NOT push a fix commit. 1. Report privately to
    or update `Cargo.toml`. 2. IMMEDIATELY rotate key    security maintainers
 2. If false positive, add     in production.            per `SECURITY.md`.
    ignore rule with PR link.3. Purge key from git history.
```

---

## 5. Strict Safe Redaction Guidance

> [!CAUTION]
> **NEVER SHARE OR PRINT SECRETS IN ISSUES, PRs, CHAT, OR LOG FILES.**

### What Constitutes a Secret?
1. **Stellar Secret Keys:** Strings starting with `S` (56 characters long, e.g. `SD...`).
2. **Seed Phrases:** 12-word or 24-word BIP-39 mnemonic phrases.
3. **Database Passwords:** Passwords embedded in `DATABASE_URL` strings.
4. **API Keys & Tokens:** Pinata JWTs, Magic.link Secret Keys, GitHub Tokens, CI secrets.
5. **Private Auth Headers:** Bearer tokens (`Authorization: Bearer ey...`) or `X-API-Key` values.

### Safe Redaction Examples

#### ❌ UNSAFE Log Snippet:
```text
Connecting to DB with URL: postgresql://admin:SuperSecretPass123!@db.internal:5432/elcare
Wallet initialized with secret key: SDJFKDLSAKJFSDKJFLSDJFKLSDJFKLSDJFKLSDJFKLSDJFKLSD
```

#### ✅ SAFE Redacted Log Snippet:
```text
Connecting to DB with URL: postgresql://admin:[REDACTED]@db.internal:5432/elcare
Wallet initialized with secret key: [REDACTED_STELLAR_SECRET_KEY]
```

### Automatic Redaction Command Helper
Before sharing text logs, you can run a redaction helper command in terminal:
```bash
sed -E -e 's/S[A-Z0-9]{55}/[REDACTED_STELLAR_SECRET_KEY]/g' \
       -e 's/postgresql:\/\/[^:]+:[^@]+@/postgresql:\/\/[REDACTED]@/g' \
       raw_log.txt > redacted_log.txt
```
