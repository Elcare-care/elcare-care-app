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

- **Workflow**: `.github/workflows/secret-scan.yml`
- **Configuration**: `.gitleaks.toml` (repo root) — extends gitleaks' default
  ruleset (`[extend] useDefault = true`, covering generic high-entropy
  secrets and common cloud provider key formats) and adds custom rules for:
  - Stellar/Soroban secret keys (`S` + 55-char base32)
  - Database connection strings with embedded credentials (postgres/mysql)
  - Pinata API keys/JWTs (`PINATA_JWT`, `PINATA_API_KEY`,
    `PINATA_SECRET_API_KEY`)
  - Generic bearer/API tokens assigned to a suspiciously-named variable or
    header
- **Runs**:
  - `gitleaks` job — every pull request (scoped to that PR's commits) *and*
    a weekly scheduled full commit-history scan ("scan history where
    permitted" — Mondays 06:00 UTC / `workflow_dispatch` for an on-demand
    run), via `gitleaks/gitleaks-action@v2`.
  - `gitleaks-docker-context` job — every pull request and the weekly
    schedule, running the `gitleaks` CLI directly (filesystem/`--no-git`
    mode, `--redact`) against `indexer/` — the Docker build context for
    `indexer/Dockerfile` — so a secret baked into the generated image can't
    slip past a source-only scan. This is a pre-build filesystem scan
    rather than a scan of the built image's layers; a full built-image
    layer scan (e.g. `docker save` + scan the exported tarball) is a
    heavier follow-up, not implemented yet.
- **Allowlist**: `.gitleaks.toml`'s `[allowlist]` covers only clearly
  synthetic fixtures — specific fake values (a repeated-`A` Stellar test key
  in `indexer/src/__tests__/keeper-unit.test.ts`, `pj_test_secret` /
  `e2e-test-pinata-jwt` Pinata placeholders in frontend tests, the fixed
  local-only `postgres:postgres@`/`ltuser:ltpass@` docker-compose creds) plus
  a small set of template/vendored paths (`.env.example` files, the vendored
  `patches/soroban-env-host-25.0.1/` crate source, and standard build output
  directories). Prefer allowlisting the exact fake *value* over an entire
  file wherever the file is otherwise real source, so a genuine secret
  accidentally added next to a fixture is still caught.
- **Output**: gitleaks' default report/log output truncates matched
  secrets, and the docker-context job passes `--redact` explicitly — the
  scanner's own output must never print a full secret. Do not add
  `--no-redact` or similar to any invocation.
- **Runtime redaction**: as defense-in-depth beyond CI, the indexer's
  logger (`indexer/src/logger.ts`) and error handler
  (`indexer/src/api/errors.ts`) run all log fields, log messages, and error
  response bodies through `indexer/src/redact.ts`, which masks the same
  secret shapes (Stellar keys, DB URLs, Pinata JWTs, bearer tokens) if one
  ends up embedded in a runtime string. Covered by
  `indexer/src/__tests__/log-redaction.test.ts`.

**Triaging a Gitleaks Finding:**


1. If accidental secret commit:
   - DO NOT commit a fix to the branch
   - IMMEDIATELY rotate the secret in production
   - Contact repository administrators
2. If false positive (e.g., test credentials):
   - Add the exact fake value (preferred) or, only for a template/vendored
     path, the path itself to `.gitleaks.toml`'s `[allowlist]`:
   ```toml
   [allowlist]
   regexes = [
     '''the-exact-synthetic-value-or-narrow-pattern''',
   ]
   ```
   - Document the reason as a comment above the entry and in the commit
     message

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
   - Secrets: `gitleaks detect --source . --config .gitleaks.toml --redact`
     (add `--log-opts="--all"` to also walk full history, matching the
     weekly scheduled scan)
5. **Document the decision** in commit message for audit trail

### Findings Ownership / Remediation Path

A failed `secret-scan.yml` check (like a failed dependency scan) **blocks
merge** — it is a required signal, not advisory. Ownership follows the same
escalation path as dependency findings below:

- The PR author triages first, using the steps above.
- If it's a real leaked secret, the author (or whoever notices first) must
  immediately rotate it and loop in repository administrators — this is not
  optional and does not wait for PR review.
- If it's a false positive, the author adds a narrowly-scoped allowlist
  entry (exact value preferred) with a documented reason and requests normal
  PR review — the allowlist change itself is reviewed like any other code
  change before merge.
- Unresolved or ambiguous findings escalate to @admin, same as below.

### Escalation

- High-severity vulnerabilities without fixes: Escalate to @admin
- Repeated violations from same dependency: File upstream issue
- Compromised external token: Security incident response protocol

### References

- Cargo Audit: https://docs.rs/cargo-audit/
- npm Audit: https://docs.npmjs.com/auditing-package-dependencies-for-security-vulnerabilities
- Gitleaks: https://github.com/gitleaks/gitleaks
