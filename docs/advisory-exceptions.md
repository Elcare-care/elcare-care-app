# Advisory & Audit-Finding Exceptions Register

**Owner:** Security Lead (registry) · Backend Lead (contracts) · DevOps (indexer/frontend)
**Last reviewed:** 2026-11-21
**Reconciled with:** [`.cargo/audit.toml`](../.cargo/audit.toml), [`.gitleaks.toml`](../.gitleaks.toml), [`docs/secret-inventory.md`](./secret-inventory.md)

This is the single, time-bound register for every High/Critical npm and Cargo
audit finding that has been *accepted* rather than fixed — i.e. a finding the
CI audit workflow would otherwise fail on. An accepted finding is never
silently suppressed; it lives here with an **owner** and an **expiry**, and
[`scripts/check-advisory-exceptions.mjs`](../scripts/check-advisory-exceptions.mjs)
fails CI if an exception is expired, ownerless, or unmatched to the ignore
list that actually suppresses it.

> **No secrets here.** This file records advisory IDs, package names, owners,
> dates, and short justifications only. It never contains secret values,
> tokens, credentials, or connection strings. The validator enforces that
> rows match the `RUSTSEC-…` / `GHSA-…` / `npm:<pkg>` id format.

---

## 1. How to add an exception (procedure)

1. **Run the audit locally** and confirm the finding is real:
   - Cargo: `cargo audit --deny warnings` (config: [`.cargo/audit.toml`](../.cargo/audit.toml))
   - npm: `npm audit --audit-level=high` in `frontend/elcarehub-app/` and `indexer/`
2. **Try the fix first** — update the manifest/lockfile (`cargo update -p <pkg>`,
   `npm audit fix`, or bump the manifest). Only accept an exception when the
   fix is blocked (transitive dep, SDK upgrade required, upstream unreleased).
3. **Add a row** to the [register table](#3-exceptions-register) below with owner,
   opened date, expiry (per the tier policy), re-review trigger, and status.
4. **Wire the suppression** so the audit stops failing:
   - Cargo: add the advisory id to `ignore = [ … ]` in `.cargo/audit.toml`
     (the validator cross-checks that every ignored id has a register row).
   - npm: there is no per-advisory ignore file; record the accepted finding
     here and, where applicable, pin an `overrides` entry in the relevant
     `package.json` with a `// AUDIT EXCEPTION:` comment linking this file.
5. **Commit** the register row + the suppression change together, with the
   advisory id in the commit message. Reviewers verify owner + expiry here.
6. **Re-review before expiry.** When `check-advisory-exceptions.mjs` reports an
   exception nearing/past expiry, either remediate (close it → Status `Remediated`)
   or re-document it with a new expiry and a fresh justification.

## 2. Time-bound expiry policy

| Severity of the underlying advisory | Max exception window | Example |
|---|---|---|
| Critical / High | 90 days | RCE, memory-safety in a reachable path |
| Medium | 180 days | DoS in a non-default feature |
| Low / Unmaintained / Informational | 365 days | `derivative`, `paste` (build-time proc-macros) |

The validator **warns** when an exception's window exceeds its tier and **fails**
when an `Open` exception is past its expiry. A window longer than the tier is
allowed only with an explicit, reviewer-visible justification in the Reason
column (e.g. "blocked on soroban-sdk major bump, tracked in #NNN").

## 3. Exceptions register

| Advisory ID | Package | Scope | Severity | Reason | Owner | Opened | Expiry | Re-review trigger | Status | Tracking |
|---|---|---|---|---|---|---|---|---|---|---|
| RUSTSEC-2024-0388 | `derivative` | cargo | Unmaintained (low) | Build-time derive macro, transitive via `soroban-sdk`; no runtime path in our contracts; no maintained replacement without a full Stellar SDK upgrade | Backend Lead (contracts) | 2026-11-21 | 2027-11-21 | soroban-sdk upgrade · new advisory raising severity · quarterly review | Open | `.cargo/audit.toml` |
| RUSTSEC-2024-0436 | `paste` | cargo | Unmaintained (low) | Build-time proc-macro, transitive via the Soroban contract toolchain (`soroban-sdk`/`soroban-env-host`); no runtime path; removal blocked on SDK upgrade | Backend Lead (contracts) | 2026-11-21 | 2027-11-21 | soroban-sdk upgrade · new advisory raising severity · quarterly review | Open | `.cargo/audit.toml` |

> The two rows above predate this register (they were already in
> `.cargo/audit.toml`'s `ignore` list). `Opened` is the register baseline date
> (2026-11-21); the original commit is recoverable from git history. The clock
> for each exception runs from its `Opened` date to its `Expiry` date.

### Row template (copy, do not edit the live table header above)

Fields, in order:

- **Advisory ID** — `RUSTSEC-YYYY-NNNN`, `GHSA-xxxx-xxxx-xxxx`, or `npm:<package>`
- **Package** — affected crate/npm package name
- **Scope** — `cargo` | `npm-frontend` | `npm-indexer`
- **Severity** — the advisory's severity, or `Unmaintained (low)` / `Informational`
- **Reason** — one line: why it can't be fixed now + why it's acceptable
- **Owner** — named role (see owner block at top); never blank
- **Opened** — `YYYY-MM-DD`
- **Expiry** — `YYYY-MM-DD`, ≤ tier window above
- **Re-review trigger** — what should bring this back before expiry
- **Status** — `Open` | `Remediated` | `Retired`
- **Tracking** — where the suppression lives (`.cargo/audit.toml`, `package.json` overrides, issue/PR link)

Example npm row (for reference; not currently active):

```text
| npm:lodash | lodash | npm-indexer | High | Prototype pollution in <4.17.21; pinned via overrides until indexer PR #NNN lands | DevOps (indexer) | 2026-11-21 | 2027-02-19 | PR #NNN merge · quarterly review | Open | indexer/package.json overrides |
```

## 4. Reconciliation with the audit config

- **Cargo (`cargo audit`)** — reads `.cargo/audit.toml`. The validator reads
  its `ignore = [ … ]` list and requires every ignored id to have a matching
  `cargo`-scoped, `Open` row here. This closes the "silent suppress" gap: an
  ignore without a documented, owned, time-bound exception fails CI.
- **npm (`npm audit`)** — no ignore file; accepted findings are recorded only
  here (and optionally in `package.json` `overrides`). The validator enforces
  owner + expiry + status on npm-scoped rows.
- **Secret findings (gitleaks)** are *not* exceptions — a real leaked secret is
  rotated, never time-bounded. See [`docs/secret-inventory.md`](./secret-inventory.md)
  and [`SECURITY.md`](../SECURITY.md). The allowlist in `.gitleaks.toml` is for
  synthetic fixtures only and is reconciled in the secret inventory, not here.

## 5. Ownership, trigger, expected output, rollback / escalation

| | |
|---|---|
| **Owner** | Security Lead owns the register and the validator; the named owner per row owns remediation of that finding |
| **Trigger** | `advisory-exceptions` job in `.github/workflows/ci.yml` runs on every push/PR; local: `node scripts/check-advisory-exceptions.mjs` |
| **Expected output** | Exit 0 + `✓ advisory exceptions register OK (N row(s), M cargo ignore(s) reconciled)`. Exit 1 with a list of expired/ownerless/unmatched findings |
| **Rollback** | Revert the register row + the matching `.cargo/audit.toml` ignore entry in the same commit; the finding returns to failing the audit, which is the safe default |
| **Escalation** | Expired or unowned exceptions → Security Lead. A finding that can't be remediated within its tier window → escalate to @admin per [`SECURITY_SCANNING_TRIAGE.md`](../SECURITY_SCANNING_TRIAGE.md) (local reference) and the quarterly reliability review |

## 6. Validator

```bash
node scripts/check-advisory-exceptions.mjs
```

Read-only — parses `docs/advisory-exceptions.md` and `.cargo/audit.toml` only;
no network, no writes, no secrets. Fails on: missing owner/date/status, an
`Open` exception past expiry, or a `.cargo/audit.toml` ignore with no matching
register row. Warns when an exception window exceeds its severity tier.

## Change log

| Date | Change |
|---|---|
| 2026-11-21 | Initial register + validator; imported the two pre-existing `.cargo/audit.toml` ignores with owner + expiry |
