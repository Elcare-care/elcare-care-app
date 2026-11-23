# Mutation Testing

Mutation testing measures whether the test suite actually detects dangerous
defects rather than merely executing code. This document describes the
configuration, ownership, acceptable thresholds, and known survivors for the
elcare-care-app Rust contracts.

---

## Tool

[cargo-mutants](https://mutants.rs) — the standard Rust mutation testing tool.

```bash
cargo install cargo-mutants
```

Configuration lives in `mutants.toml` at the repo root.

---

## Quick Start

```bash
# PR mode — only mutates files changed vs origin/main (fast, CI-safe)
bash mutation-tests/run-mutation-tests.sh

# Full scheduled analysis — all high-priority modules
FULL=1 bash mutation-tests/run-mutation-tests.sh

# Single-file targeted run
FILE=contracts/soroban-marketplace/src/math.rs \
  bash mutation-tests/run-mutation-tests.sh
```

Results land in `mutation-tests/reports/` and `cargo-mutants-out/`.

---

## Selected Modules

| Module | Rationale | Owner | Threshold |
|---|---|---|---|
| `contracts/soroban-marketplace/src/math.rs` | Fee arithmetic and dust routing. Any arithmetic operator mutation that survives is a direct financial defect. | @contracts-team | **95%** |
| `contracts/soroban-marketplace/src/contract.rs` | Settlement functions (`buy_artwork`, `finalize_auction`, `accept_offer`), access-control guards (`require_admin`, `require_not_paused`, `require_not_revoked`), and two-step admin rotation. Inverted auth checks are the highest-severity class. | @contracts-team | **80%** |
| `contracts/soroban-marketplace/src/storage.rs` | Index correctness for active-listing swap-removal and reentrancy lock acquire/release. Off-by-one mutations in O(1) swap-remove silently corrupt the active-listing index. | @contracts-team | **85%** |
| `contracts/soroban-marketplace/src/escrow.rs` | NFT custody transitions. A surviving mutant could enable double-listing or asset theft. | @contracts-team | **90%** |
| `contracts/launchpad/src/contract.rs` | Deploy-fee collection and WASM clone address derivation. Fee mutations directly affect protocol revenue. | @contracts-team | **75%** |

---

## Exclusions

The following files are excluded from mutation analysis. Each exclusion has a
documented rationale; all are reviewed quarterly.

| Pattern | Reason |
|---|---|
| `*/test.rs`, `*/tests.rs` | Test code itself; mutating it produces noise rather than actionable coverage signals. |
| `*/lib.rs` | Pure re-export files with no logic. Mutations produce compile errors, not meaningful survivors. |
| `*/events.rs` | Event struct definitions and topic-string constants. String-literal mutations are caught trivially by all callers; the meaningful coverage is exercised by indexer integration tests, not contract unit tests. |
| `*/types.rs` | Data-type definitions (`#[contracterror]`, `#[contracttype]`). Mutating `#[repr(u32)]` discriminants breaks XDR serialisation and is caught by every single test that invokes the contract — producing inflated-but-trivially-detected survivor counts. |
| `patches/**` | Vendored `soroban-env-host`; not project code. |
| `contracts/collection_nft_erc721/**` | Thin delegation contract. No custom business logic today; re-evaluate when custom royalty logic is added. |
| `contracts/collection_nft_erc1155/**` | Same as above. |
| `contracts/lazy_mint_erc721/**` | Thin delegation contract. Deferred until lazy-mint voucher verification logic is added. |
| `contracts/lazy_mint_erc1155/**` | Same as above. |

---

## Acceptable Mutation Score

A module's mutation score is:

```
score = killed / (killed + survived) × 100
```

Timeouts and compile errors are excluded from the denominator (they do not
represent true survivors).

The thresholds in the table above are the **minimum acceptable scores**.
Dropping below threshold on a PR blocks the `mutation-pr` CI job.
The nightly `mutation-full` job tracks score trend over time.

---

## Known Survivors

This section documents mutants that survive but are deemed **semantically
equivalent** — i.e., the mutation produces code that is logically indistinguishable
from the original in all reachable program states.

Semantically equivalent survivors are acceptable and should be listed here to
avoid creating tests that only kill them by coincidence.

### math.rs

| Mutant | Description | Classification |
|---|---|---|
| `calc_fee: replace return 0 with return 1` when `bps == 0 \|\| price == 0` | Both branches short-circuit before multiplication; returning 1 here would be caught by `test_calc_fee_zero_price` and `test_calc_fee_zero_bps`. If this survives, add an explicit assertion in the boundary tests. | **Actionable** — add assertion |

### contract.rs

| Mutant | Description | Classification |
|---|---|---|
| `version()` string constant mutations | The version string is only checked in upgrade scripts, not in unit tests. | **Acceptable** — operational check only; add a unit test asserting `version() == "1.1.0"` if this score matters. |
| View-only getter bodies (e.g., `get_total_listings` returning 0) | View functions are pure reads; their return values are tested end-to-end via integration, not in unit tests. | **Acceptable** — covered by integration tests. |

### storage.rs

_No known semantically equivalent survivors as of baseline._

### escrow.rs

_No known semantically equivalent survivors as of baseline._

### launchpad/contract.rs

_Initial run pending — threshold set conservatively at 75% to account for
currently incomplete test coverage. Survivors from the first full run will be
documented here._

---

## Recurring Survivor Ownership

When a module's score drops below threshold in the nightly report, the owners
listed in the module table above are responsible for:

1. Reviewing the `mutation-tests/reports/survivors-<timestamp>.md` file.
2. Determining whether each survivor is actionable or semantically equivalent.
3. Either adding/strengthening a test (actionable) or documenting it here
   (semantically equivalent) within **5 business days**.

The nightly CI job posts a trend comment on the merge commit to make score
changes visible without requiring direct inspection of the artifact.

---

## CI Integration

| Workflow | File | Trigger | Scope |
|---|---|---|---|
| `mutation-pr` | `.github/workflows/mutation-tests.yml` | PR touching a high-priority module | Changed files only — bounded, non-blocking |
| `mutation-full` | `.github/workflows/mutation-tests.yml` | Nightly 02:00 UTC / manual dispatch | All include_globs from `mutants.toml` |
| `mutation-file` | `.github/workflows/mutation-tests.yml` | Manual dispatch with `mode=file` | Single specified file |

PR mode never runs the full workspace — it only analyses the high-priority
files that were actually modified, so it completes in 5–15 minutes and does not
delay developer feedback.

---

## Trend Report

Score history is maintained in `mutation-tests/reports/trend.json` and committed
by the nightly job. To view the last 5 runs:

```bash
jq '.[-5:] | map({ timestamp: .timestamp, scores: .files | map({ (.file | split("/") | last): .score }) | add })' \
  mutation-tests/reports/trend.json
```

---

## Mutation Operator Reference

`cargo-mutants` applies the following operators by default:

| Operator | Example |
|---|---|
| Replace arithmetic operator | `+` → `-`, `*` → `/`, etc. |
| Replace comparison operator | `<` → `<=`, `==` → `!=`, etc. |
| Replace boolean operator | `&&` → `\|\|` |
| Return early with default value | `return Ok(x)` → `return Ok(Default::default())` |
| Delete statement | Remove a `save_listing()` call |
| Replace integer literal | `10_000` → `0` or `1` |

Operators that produce compile errors (type mismatches, borrow violations) are
automatically filtered by cargo-mutants and do not appear in results.

---

## Triage Procedure

When a mutation run produces survivors, the following procedure applies. The full
step-by-step process, decision tree, and worked example live in
[`docs/runbooks/mutation-triage-runbook.md`](docs/runbooks/mutation-triage-runbook.md).

**Owner:** @contracts-team (Backend Lead)  
**Trigger:** Any nightly `mutation-full` or PR `mutation-pr` CI run that produces a
`mutation-tests/reports/survivors-<timestamp>.md` report with one or more surviving mutants.  
**Expected output:** Every surviving mutant is classified as Keep, Fix, or Retire and recorded
(in this file or in a new test) within 5 business days.  
**Rollback / escalation:** If the CI job is broken and not generating outcomes, re-trigger via
manual dispatch (`mode=full`) from the GitHub Actions UI. If `cargo-mutants` itself is the
failure, escalate to DevOps Engineer — do not suppress the CI failure while the tool is broken.

### Classification summary

| Classification | Meaning | Record in |
|---|---|---|
| **Fix** | Test gap — a real defect with this mutation would not be caught | New or strengthened test; re-run to confirm mutant is killed |
| **Keep** | Semantically equivalent mutant — cannot change observable behaviour | `MUTATION_TESTING.md §Known Survivors` for the relevant module |
| **Retire** | Dead code — mutated path is unreachable | `mutants.toml [[filters]] exclude_globs` + entry in `§Exclusions` |

### Quick reference

```bash
# Reproduce a surviving mutant locally (no deployment, no network)
FILE=contracts/soroban-marketplace/src/math.rs \
  bash mutation-tests/run-mutation-tests.sh

# Inspect raw survivors from the last run
jq '[.[] | select(.outcome == "survived")]' cargo-mutants-out/outcomes.json

# Check score trend for the last 3 runs
jq '.[-3:] | map({ timestamp: .timestamp, scores: (.files | map({ (.file | split("/") | last): .score }) | add) })' \
  mutation-tests/reports/trend.json
```

See [`docs/runbooks/mutation-triage-runbook.md`](docs/runbooks/mutation-triage-runbook.md) for the full
decision tree, per-classification action steps, and a worked example from `math.rs`.
