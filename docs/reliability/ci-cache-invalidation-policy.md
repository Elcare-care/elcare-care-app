# CI Cache Invalidation Policy

**Issue:** [#1121](https://github.com/Elcare-care/elcare-care-app/issues/1121)  
**Category:** Reliability, Security, and Operations  
**Owner:** DevOps / Backend Lead  
**Last updated:** 2025-07-19

---

## Purpose

Build and dependency caches that survive across runs can mask stale lockfile or ABI changes: a job may pass against a cached `node_modules` or Rust target directory even though the lockfile or a contract ABI changed in the same commit. This document audits the current cache key strategy, identifies when a key must change, and proposes low-risk configuration updates.

---

## Current Cache Inventory

The following table lists every `actions/cache` and implicit caching mechanism in use across the CI workflows.

### Explicit npm caching (`actions/setup-node` with `cache: 'npm'`)

| Workflow | Job | Cache Key Input | Cache Path |
|---|---|---|---|
| `e2e-wallet-failure-matrix.yml` | `wallet-failure-matrix` | `cache-dependency-path: package-lock.json` (workspace root) | `~/.npm` |

`actions/setup-node` with `cache: 'npm'` and `cache-dependency-path` constructs a cache key from the OS, Node version, and a hash of the specified lockfile. The cache is invalidated automatically when `package-lock.json` changes.

### Implicit Rust/Cargo caching

The `ci.yml` and `release.yml` workflows use `actions-rs/toolchain@v1` and `cargo` commands but do **not** configure an explicit `actions/cache` step for the Rust target directory or the Cargo registry. This means:

- Cargo downloads all crates on every run (no cross-run caching).
- There is no risk of stale Cargo cache today, but build times are longer than necessary.

### SBOM workflow (`sbom.yml`)

No explicit caching. Each SBOM job installs fresh dependencies on every run via `npm ci` and `cargo metadata`. This is intentional: the freshness check (`check-freshness.mjs`) compares the SBOM's recorded lockfile hash against the checked-out lockfile, so a cached partial install would be a correctness risk.

### Post-deploy smoke (`post-deploy-smoke.yml`)

No build steps; no caching configured.

### Mutation tests (`mutation-tests.yml`), load tests (`load-tests.yml`), indexer tests (`indexer-tests.yml`)

Reviewed; no explicit cache configuration found. These jobs run `npm ci` or `cargo` fresh on each invocation.

---

## When a Cache Key Must Change

A cache key must be invalidated whenever its inputs include a file that has changed and whose change could affect the build output or test correctness.

| Cache | Must Invalidate When |
|---|---|
| npm workspace root (`package-lock.json`) | Any change to `package-lock.json` at the workspace root |
| Frontend npm (`frontend/elcarehub-app/package-lock.json`) | Any change to that lockfile |
| Indexer npm (`indexer/package-lock.json`) | Any change to that lockfile |
| Rust target directory (not currently cached) | `Cargo.lock` changes, toolchain version changes, or any change to a workspace member's `Cargo.toml` |
| Contract ABI (`packages/contract-abi/abi.json`) | Any change to `abi.json` or the ABI generation scripts — not a cache key today, but relevant if ABI-dependent jobs are cached in future |

The rule: **the cache key must include a hash of every lockfile or manifest file that the cached artifact was built from**.

---

## Identified Gaps and Proposed Changes

### Gap 1: `e2e-wallet-failure-matrix.yml` caches the workspace root `package-lock.json` but installs under `frontend/elcarehub-app`

The `cache-dependency-path: package-lock.json` points to the monorepo root lockfile. The job then runs `npm ci` from the workspace root (which is correct for a monorepo workspace). This is not a bug today, but if the root lockfile ever diverges from the sub-workspace lockfiles the cache key would not reflect the sub-workspace change.

**Proposed change (low-risk):** Expand `cache-dependency-path` to cover all three lockfiles:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: '20'
    cache: 'npm'
    cache-dependency-path: |
      package-lock.json
      frontend/elcarehub-app/package-lock.json
      indexer/package-lock.json
```

This is additive: the cache key becomes a hash of all three files. Any change to any of the three invalidates the cache. No secrets, credentials, or production paths are involved.

### Gap 2: Rust/Cargo builds are not cached

Every CI run re-downloads crates. This is safe but slow (the `ci.yml` `check` job takes several minutes on cold runners).

**Proposed change (low-risk, opt-in):** Add an explicit `actions/cache` step keyed on OS, the stable toolchain version, and a hash of `Cargo.lock`:

```yaml
- name: Cache Cargo registry and target
  uses: actions/cache@v4
  with:
    path: |
      ~/.cargo/registry/index
      ~/.cargo/registry/cache
      ~/.cargo/git/db
      target/
    key: ${{ runner.os }}-cargo-stable-${{ hashFiles('**/Cargo.lock') }}
    restore-keys: |
      ${{ runner.os }}-cargo-stable-
```

The `Cargo.lock` hash in the key means any lockfile change (new dependency, version bump) forces a fresh cache. The `restore-keys` prefix allows partial hits from the previous lockfile version, which is safe because Cargo validates downloaded crates against `Cargo.lock` on every build.

**Do not cache `target/wasm32v1-none/release/`** without also including a hash of every `Cargo.toml` in the workspace — compiled WASM output is ABI-sensitive.

### Gap 3: No documentation of ABI-change impact on cached builds

If a contract ABI changes (new entry-point or changed argument types) and a downstream job (e.g., `config-validation`) runs against a cached copy of `packages/contract-abi/dist`, it may pass on stale types.

**Proposed change (documentation only):** The ABI validation step in `ci.yml` (`npm run validate` in the `packages/contract-abi` job) must remain on the critical path without cache restoration of `dist/`. Add a comment to `ci.yml` noting this constraint:

```yaml
# Do not add actions/cache for packages/contract-abi/dist — the validate step
# must run against a freshly built dist to catch ABI regressions.
- name: Build and validate contract-abi package
  working-directory: packages/contract-abi
  run: |
    npm install
    npm run build
    npm run validate
```

---

## Validation Command

To verify that the npm cache key covers all lockfiles after the Gap 1 change, run a dry-run on a branch:

```bash
# Confirm all three lockfiles are present and have different hashes
sha256sum package-lock.json \
           frontend/elcarehub-app/package-lock.json \
           indexer/package-lock.json
```

A change to any one file should produce a different combined hash and therefore a different cache key.

---

## Rollback

Cache configuration changes in GitHub Actions are low-risk and reversible: removing the `cache` input or restoring the previous `cache-dependency-path` value in the YAML is sufficient. No production deployment or secret rotation is involved. If a stale-cache incident is suspected, manually clear the cache via **Actions → Caches** in the repository settings.

---

## Owner and Review Cadence

**Owner:** DevOps / Backend Lead  
**Trigger:** Review this document and the cache key configuration whenever a new lockfile is added to the monorepo, the Node or Rust toolchain version is pinned to a new major version, or a CI flake is traced to a stale cache hit.  
**Expected output:** Updated `cache-dependency-path` entries or `actions/cache` steps in the affected workflow files; this document updated to reflect the current state.
