# Issue: Mutation Survivor Triage — Reproducibility Gap

**Status:** Closed — procedure implemented  
**Opened:** 2026-11-22  
**Closed:** 2026-11-22  
**Owner:** @contracts-team (Backend Lead)

---

## Problem Statement

Mutation test results can identify weak assertions or invalid mutants, but without a
documented triage procedure the keep/fix/retire decision is not reproducible across
engineers. Two reviewers looking at the same surviving mutant could reach different
conclusions, and there is no canonical place to record either outcome.

---

## Work Done

### Evidence inspected

| Artifact | Finding |
|---|---|
| `.github/workflows/mutation-tests.yml` | Three jobs: `mutation-pr` (PR mode, changed files only), `mutation-full` (nightly at 02:00 UTC), `mutation-file` (manual single-file). All upload `cargo-mutants-out/` and `mutation-tests/reports/` as artifacts. |
| `mutants.toml` | Five `include_globs` (math.rs, contract.rs, storage.rs, escrow.rs, launchpad/contract.rs). Exclusions documented with rationale. Per-module thresholds: 75–95%. |
| `MUTATION_TESTING.md` | Module table, thresholds, exclusions, known survivors, and trend-report command were present. No triage procedure section existed. The `math.rs §Known Survivors` table listed one **Actionable** mutant (`calc_fee: replace return 0 with return 1`) with a note to add an assertion — but no procedure for how to do that reproducibly. |
| `mutation-tests/run-mutation-tests.sh` | Generates `survivors-<timestamp>.md` per run. Outputs `[ERROR]` and exit 1 on threshold violation. No triage steps referenced. |
| `contracts/soroban-marketplace/src/math.rs` | `calc_fee` has inline `#[cfg(test)]` tests: `test_calc_fee_zero_price`, `test_calc_fee_zero_bps`, `test_calc_fee_single_stroop_truncates`. The `distribute` function is exercised by `test_distribute_invariant_no_stroop_ever_lost` with a parametric matrix, but the matrix did not include `price=0` as an input, leaving the `calc_fee` zero-price boundary unkilled through `distribute`. |

### Gap identified

The `calc_fee: replace return 0 with return 1` mutant survives because:

1. The boundary tests (`test_calc_fee_zero_price`, `test_calc_fee_zero_bps`) only assert the
   return value of `calc_fee` in isolation.
2. `distribute` calls `calc_fee` internally, but `test_distribute_invariant_no_stroop_ever_lost`
   does not include `price=0` in its parametric `prices` array, so the zero-price path through
   `distribute` is never exercised with an assertion that would catch return value `1`.

### Changes made

| File | Change |
|---|---|
| `docs/runbooks/mutation-triage-runbook.md` | **Created.** Full triage procedure: prerequisites, 5-step decision process, keep/fix/retire definitions, worked example for the `calc_fee` survivor. |
| `MUTATION_TESTING.md` | **Updated.** Added `§Triage Procedure` section with owner, trigger, expected output, rollback/escalation, classification table, and quick-reference commands linking to the new runbook. |
| `docs/reliability/ISSUE-MUTATION-TRIAGE.md` | **Created** (this file). Evidence record. |

---

## Validation

The following commands were specified in the runbook and verified syntactically against the
existing scripts. They do not require `cargo-mutants` to be installed or any network access:

```bash
# Reproduce a survivor (requires cargo-mutants installed locally)
FILE=contracts/soroban-marketplace/src/math.rs \
  bash mutation-tests/run-mutation-tests.sh

# Parse survivors from outcomes.json
jq '[.[] | select(.outcome == "survived")]' cargo-mutants-out/outcomes.json

# View score trend
jq '.[-3:] | map({ timestamp: .timestamp, scores: (.files | map({ (.file | split("/") | last): .score }) | add) })' \
  mutation-tests/reports/trend.json
```

No dependencies were installed. No production deployment was triggered. No secrets were
introduced or referenced.

---

## Implementation Procedure (repeatable)

1. When `mutation-full` or `mutation-pr` CI produces survivors, open
   `mutation-tests/reports/survivors-<timestamp>.md` or download the CI artifact.
2. For each surviving mutant, follow the decision tree in
   `docs/runbooks/mutation-triage-runbook.md §Step 3`.
3. Act per classification: Fix → add/strengthen test; Keep → add row to
   `MUTATION_TESTING.md §Known Survivors`; Retire → update `mutants.toml` exclusions.
4. Re-run `bash mutation-tests/run-mutation-tests.sh` on the affected file to confirm
   the mutant is killed (Fix) or confirm the threshold is still met (Keep/Retire).
5. Record the result in this file or in a new instance of this template.

**Measurable result:** Module score for the affected file meets or exceeds its threshold
(defined in `mutants.toml` and `MUTATION_TESTING.md §Selected Modules`), and every surviving
mutant has a written classification in `MUTATION_TESTING.md §Known Survivors` or is killed by
a new test.

---

## Owner, Trigger, Expected Output, Rollback

| Field | Value |
|---|---|
| **Owner** | @contracts-team — Backend Lead |
| **Trigger** | Nightly `mutation-full` CI job or any `mutation-pr` run producing survivors |
| **Expected output** | All surviving mutants classified within 5 business days; module scores at or above thresholds |
| **Rollback** | If the CI job stops generating outcomes (tool broken), re-trigger via manual dispatch (`mode=full`) from the GitHub Actions UI. If `cargo-mutants` is broken, escalate to DevOps Engineer — do not suppress the CI failure. |
| **Escalation** | DevOps Engineer (CI infrastructure); Backend Lead (contract logic); Slack #contracts-dev |

---

## Related Documents

- [`docs/runbooks/mutation-triage-runbook.md`](../runbooks/mutation-triage-runbook.md)
- [`MUTATION_TESTING.md`](../../MUTATION_TESTING.md)
- [`mutants.toml`](../../mutants.toml)
- [`.github/workflows/mutation-tests.yml`](../../.github/workflows/mutation-tests.yml)
- [`mutation-tests/run-mutation-tests.sh`](../../mutation-tests/run-mutation-tests.sh)
