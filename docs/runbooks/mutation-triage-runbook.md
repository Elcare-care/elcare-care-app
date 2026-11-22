# Runbook: Mutation Survivor Triage

**Owner:** @contracts-team (Backend Lead)  
**Trigger:** Nightly `mutation-full` CI job or manual dispatch produces a `survivors-<timestamp>.md` report with one or more surviving mutants.  
**Expected output:** Every surviving mutant is classified as **Keep**, **Fix**, or **Retire** within 5 business days. The classification is recorded in `MUTATION_TESTING.md §Known Survivors` or in the test that kills it.  
**Rollback / escalation:** If the nightly job is broken (not generating outcomes), re-run via manual dispatch (`mode=full`) from the Actions UI. If `cargo-mutants` itself is broken, escalate to DevOps Engineer and open a tracking issue in GitHub; do not suppress CI failure in the meantime.

---

## Purpose

This runbook makes survivor triage reproducible. Any engineer on `@contracts-team` must be able to reach the same keep/fix/retire decision for a given mutant by following these steps, independent of who ran the original analysis.

---

## Prerequisites

| Requirement | How to verify |
|---|---|
| `cargo-mutants` installed | `cargo mutants --version` prints a version string |
| `jq` installed | `jq --version` |
| Rust toolchain with `wasm32v1-none` | `rustup target list --installed \| grep wasm32v1-none` |
| Write access to `MUTATION_TESTING.md` | `git status` on a branch from `main` |

---

## Step 1 — Locate the survivor report

After each CI run the survivors report is uploaded as a workflow artifact named `mutation-full-<run_id>` (or `mutation-pr-<run_id>` for PR mode).

```bash
# Download the artifact from the CLI (replace RUN_ID)
gh run download <RUN_ID> --name mutation-full-<RUN_ID> --dir /tmp/mutation-report

# Or open the report already committed by the nightly job
cat mutation-tests/reports/survivors-<TIMESTAMP>.md
```

The raw survivor list is also in `cargo-mutants-out/outcomes.json`:

```bash
jq '[.[] | select(.outcome == "survived")]' cargo-mutants-out/outcomes.json
```

---

## Step 2 — Reproduce a single surviving mutant locally

Before classifying, confirm the mutant actually survives in a clean run. This rules out flaky test infrastructure as the cause.

```bash
# Target the specific file (no network, no deployment)
FILE=contracts/soroban-marketplace/src/math.rs \
  bash mutation-tests/run-mutation-tests.sh
```

If the mutant does **not** survive on a fresh local run, the original result was a CI flake. Close without action and add a comment to the report.

---

## Step 3 — Classify each mutant

For each surviving mutant apply the decision tree below.

### Decision tree

```
Is the mutated code reachable in any valid execution path?
│
├── No → RETIRE (dead code — open a separate cleanup task)
│
└── Yes
    │
    Is there a currently-passing test that exercises this code path
    with inputs that would produce a different observable result
    if the mutation were real?
    │
    ├── Yes, but the test does not assert the specific value →
    │       FIX: add or strengthen the assertion
    │
    ├── No test covers this path at all →
    │       FIX: add a test
    │
    └── The mutation produces code that is logically equivalent
        in ALL reachable states (semantically equivalent mutant) →
            KEEP: document in MUTATION_TESTING.md §Known Survivors
```

### Classification definitions

| Classification | Meaning | Required action |
|---|---|---|
| **Fix** | A test gap — a real defect with this mutation would not be caught | Add or strengthen a test; re-run mutation analysis to confirm the mutant is now killed |
| **Keep** | Semantically equivalent mutant — the mutation cannot change observable behaviour in any reachable state | Document in `MUTATION_TESTING.md §Known Survivors` with a brief explanation |
| **Retire** | Dead code — the mutated path is unreachable | Open a code cleanup task; exclude from future runs if the exclusion is permanent |

---

## Step 4 — Act on the classification

### Fix path

1. Write or strengthen the test in the relevant `*_tests.rs` file or in `math.rs §Tests`.
2. Run the unit tests alone first to confirm the new test passes on the original code:
   ```bash
   cargo test -p soroban-marketplace -- --test-output immediate 2>&1 | tail -20
   ```
3. Re-run mutation analysis on the file to confirm the mutant is now killed:
   ```bash
   FILE=contracts/soroban-marketplace/src/math.rs \
     bash mutation-tests/run-mutation-tests.sh
   ```
4. Verify the module score meets or exceeds its threshold (see `MUTATION_TESTING.md §Selected Modules`).
5. Commit the new test and open a PR.

### Keep path

1. Add a row to `MUTATION_TESTING.md §Known Survivors` for the relevant module. Use this format:
   ```
   | <mutant description> | <why it is semantically equivalent> | **Acceptable** — <brief note> |
   ```
2. Commit and open a PR. The PR description must reference the survivors report artifact name.

### Retire path

1. Open a GitHub issue titled `Dead code: <function/file> — mutation survivor`.
2. Add the file or function pattern to `mutants.toml [[filters]] exclude_globs` with a comment referencing the issue.
3. Document the exclusion in `MUTATION_TESTING.md §Exclusions`.

---

## Step 5 — Update trend tracking

The nightly job updates `mutation-tests/reports/trend.json` automatically. After a Fix, verify the score improved:

```bash
jq '.[-3:] | map({ timestamp: .timestamp, scores: (.files | map({ (.file | split("/") | last): .score }) | add) })' \
  mutation-tests/reports/trend.json
```

A rising score for the affected module confirms the fix worked.

---

## Worked Example — `calc_fee` boundary assertion (math.rs)

This example walks through a real survivor from the `math.rs` module to demonstrate how to apply the runbook end-to-end.

### The survivor

```
File:    contracts/soroban-marketplace/src/math.rs
Mutant:  calc_fee — replace `return 0` with `return 1`
         when `bps == 0 || price == 0`
Outcome: survived
```

The mutated code looks like:

```rust
// ORIGINAL
pub fn calc_fee(price: i128, bps: u32) -> i128 {
    if bps == 0 || price == 0 {
        return 0;
    }
    // ...
}

// MUTANT
pub fn calc_fee(price: i128, bps: u32) -> i128 {
    if bps == 0 || price == 0 {
        return 1;  // ← mutation: 0 → 1
    }
    // ...
}
```

### Step 2 — Reproduce

```bash
FILE=contracts/soroban-marketplace/src/math.rs \
  bash mutation-tests/run-mutation-tests.sh
# Expected: survivors-<TS>.md contains this mutant
```

### Step 3 — Classify

- The `bps == 0` and `price == 0` branches are both reachable (callers pass `fee_bps=0` and zero-price paths exist in settlement).
- Two tests exist — `test_calc_fee_zero_price` and `test_calc_fee_zero_bps` — but both use `assert_eq!(calc_fee(...), 0)` only within `calc_fee`'s own unit tests, which are excluded from mutation analysis (`*/test.rs` pattern). The inline `#[cfg(test)]` block in `math.rs` is _not_ excluded, but neither test currently calls `calc_fee` with an assertion that would catch return value `1` through the `distribute` function's output.
- Decision: **Fix** — the boundary tests exist but do not assert the boundary value through `distribute`, which means the integration between `calc_fee` and `distribute` is not checked at the boundary.

### Step 4 — Fix

Add an explicit assertion to the parametric invariant test in `math.rs`:

```rust
// In math.rs §Tests — test_distribute_invariant_no_stroop_ever_lost
// Add these boundary cases to the existing prices/fee_bps arrays:
let prices  = [0i128, 1, 7, 100, 9_999, 10_000, 10_001, 1_000_000, 99_999_999];
//              ^ add 0
let fee_bps = [0u32, 1, 100, 333, 500, 1_000];

// Also add a dedicated boundary assertion:
#[test]
fn test_calc_fee_zero_inputs_via_distribute() {
    let env = Env::default();
    let a = Address::generate(&env);
    // fee_bps=0, price=1_000_000: fee must be exactly 0, all goes to artist
    let r = distribute(&env, 1_000_000, 0, &single(&env, &a, 10_000));
    assert_eq!(r.fee, 0, "zero bps must yield zero fee");
    assert_eq!(sum_payouts(&r), 1_000_000);

    // price=0, fee_bps=500: fee must be exactly 0
    let r2 = distribute(&env, 0, 500, &single(&env, &a, 10_000));
    assert_eq!(r2.fee, 0, "zero price must yield zero fee");
    assert_eq!(sum_payouts(&r2), 0);
}
```

Run validation (no deployment, no network):

```bash
cargo test -p soroban-marketplace math::tests -- --test-output immediate
# All tests pass on original code ✓

FILE=contracts/soroban-marketplace/src/math.rs \
  bash mutation-tests/run-mutation-tests.sh
# Mutant is now killed ✓
```

### Evidence

| Item | Result |
|---|---|
| Mutant reproduced locally | ✓ |
| Root cause | Boundary assertions did not propagate through `distribute` |
| Fix | Add `test_calc_fee_zero_inputs_via_distribute` in `math.rs §Tests` |
| Mutant killed after fix | ✓ |
| Module score after fix | ≥ 95% (threshold met) |

---

## Owner and Contacts

| Role | Contact | Escalation |
|---|---|---|
| **Primary:** @contracts-team | Backend Lead | Slack #contracts-dev |
| **Secondary:** DevOps (CI infra) | DevOps Engineer | Slack #ci-alerts |

---

## Related Documents

- [`MUTATION_TESTING.md`](../../MUTATION_TESTING.md) — module list, thresholds, known survivors
- [`mutants.toml`](../../mutants.toml) — cargo-mutants configuration
- [`mutation-tests/run-mutation-tests.sh`](../../mutation-tests/run-mutation-tests.sh) — runner script
- [`.github/workflows/mutation-tests.yml`](../../.github/workflows/mutation-tests.yml) — CI workflow
- [`ISSUE-MUTATION-TRIAGE.md`](../reliability/ISSUE-MUTATION-TRIAGE.md) — tracking issue with evidence record
