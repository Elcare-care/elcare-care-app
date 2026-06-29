# Security Scanning Triage Process

## Dependency Scanning Triage Process

### Overview
This project runs dependency and secret scans on every PR to protect the supply chain from vulnerabilities and committed secrets.

### Scan Types

#### 1. Cargo Audit (Rust Dependencies)

- **Runs**: On every PR in `dependency-scan` job
- **Configuration**: `.cargo/audit.toml`
- **Threshold**: High/Critical advisories fail the build
- **Command**: `cargo audit --deny warnings`

**Triaging a Cargo Audit Finding:**


1. Run locally: `cargo audit` to view advisories
2. If false-positive or acceptable risk:
   - Edit `.cargo/audit.toml`
   - Add to `[advisories] ignore = ["RUSTSEC-XXXX-XXXX"]` with ticket reference
   - Document justification in commit message
3. If dependency update available:
   - Update `Cargo.toml` to a patched version
   - Run `cargo update` and test thoroughly
   - Commit with reference to advisory number

#### 2. npm Audit (JavaScript Dependencies)

- **Runs**: On every PR for both frontend and indexer
- **Threshold**: High/Critical npm advisories fail the build
- **Commands**:
  - Frontend: `npm audit --audit-level=high` in `frontend/elcarehub-app/`
  - Indexer: `npm audit --audit-level=high` in `indexer/`

**Triaging an npm Audit Finding:**


1. Run locally: `npm audit --audit-level=high` in the affected directory
2. Check if `npm audit fix` resolves it (test thoroughly):
   - `npm audit fix`
   - Run full test suite: `npm run test`
   - Commit with advisory reference
3. If `npm audit fix` doesn't work or breaks something:
   - Document the issue in the PR with ticket reference
   - Work with the maintainer of the dependency
   - Request exception with security justification

#### 3. Secret Scanning (Gitleaks)

- **Runs**: On every PR
- **Configuration**: `.gitleaks.toml` (if custom config needed)
- **Action**: `gitleaks/gitleaks-action@v2`

**Triaging a Gitleaks Finding:**


1. If accidental secret commit:
   - DO NOT commit a fix to the branch
   - IMMEDIATELY rotate the secret in production
   - Contact repository administrators
2. If false positive (e.g., test credentials):
   - Add to `.gitleaks.toml` ignore list with reason:
   ```toml
   [[rules]]
   id = "gitleaks-rule-id"
   description = "False positive: test fixture in docs"
   path = "path/to/file"
   ```
   - Document in commit message

### Build Failure Resolution

When a scan fails on a PR:

1. **Identify the failure**: Check the CI logs in the PR checks section
2. **Assess the finding**: Determine if it's a real vulnerability or false positive
3. **Choose remediation**:
   - **Real vulnerability**: Update dependency or remove secret
   - **False positive**: Add to ignore list with documentation
4. **Test locally** before pushing:
   - Cargo: `cargo audit --deny warnings`
   - npm: `npm audit --audit-level=high`
   - Secrets: `gitleaks detect --verbose`
5. **Document the decision** in commit message for audit trail

### Escalation

- High-severity vulnerabilities without fixes: Escalate to @admin
- Repeated violations from same dependency: File upstream issue
- Compromised external token: Security incident response protocol

### References

- Cargo Audit: https://docs.rs/cargo-audit/
- npm Audit: https://docs.npmjs.com/auditing-package-dependencies-for-security-vulnerabilities
- Gitleaks: https://github.com/gitleaks/gitleaks
