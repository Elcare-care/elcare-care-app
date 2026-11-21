# CI Artifact Retention Policy

**Issue:** [#1122](https://github.com/Elcare-care/elcare-care-app/issues/1122)  
**Category:** Reliability, Security, and Operations  
**Owner:** DevOps Lead  
**Last updated:** 2025-07-19

---

## Purpose

Build logs, SBOMs, test reports, and other workflow artifacts need consistent retention periods and clear access controls. Without a written policy, artifacts either accumulate indefinitely (storage cost, compliance risk) or are deleted before they are needed for incident review or regulatory audit. This document inventories all `actions/upload-artifact` calls across the CI workflows, records the current retention settings, and defines the review and cleanup policy.

---

## Artifact Inventory

### `sbom.yml` — Software Bill of Materials

| Artifact Name | Contents | Current Retention | Access |
|---|---|---|---|
| `sbom-frontend` | `sbom-frontend.cdx.json`, `sbom-frontend.meta.json` | 90 days | Any user with read access to the repository |
| `sbom-indexer` | `sbom-indexer.cdx.json`, `sbom-indexer.meta.json` | 90 days | Any user with read access |
| `sbom-contracts` | `sbom-contracts.cdx.json`, `sbom-contracts.meta.json` | 90 days | Any user with read access |
| `sbom-docker-indexer` | `sbom-docker-indexer.cdx.json`, `sbom-docker-indexer.meta.json` | 90 days | Any user with read access |
| `sbom-bundle-<sha>` | All four SBOM pairs combined (non-tag runs) | 90 days | Any user with read access |

On `v*` tag pushes, all SBOM and provenance files are attached to the GitHub Release and have no independent retention limit — they persist as long as the release exists.

### `release.yml` — Release Artifacts

| Artifact Name | Contents | Current Retention | Access |
|---|---|---|---|
| `release-artifacts-<tag>` | Contract WASM files, ABI JSON + tarball, frontend Next.js build tarball, indexer Docker image tarball, `SHA256SUMS`, `SHA256SUMS.sig`, `SHA256SUMS.pem`, `SHA256SUMS.bundle`, `PROVENANCE.json` | 90 days | Any user with read access |

On tag runs, artifacts are also attached to the GitHub Release (no independent expiry).

### `post-deploy-smoke.yml` — Health Gate Reports

| Artifact Name | Contents | Current Retention | Access |
|---|---|---|---|
| `health-gate-report-<run_id>` | Full stdout/stderr of `health-gate.sh` | 30 days | Any user with read access |

### `e2e-wallet-failure-matrix.yml` — Playwright Reports

| Artifact Name | Contents | Current Retention | Access |
|---|---|---|---|
| `wallet-failure-matrix-report` | Playwright HTML report directory | 14 days | Any user with read access |
| Upload condition: `if: always()` | Uploaded on both pass and fail | — | — |

### `mutation-tests.yml` — Mutation Test Reports

Review the workflow for current upload and retention settings. At the time of this writing, no `actions/upload-artifact` step was confirmed in `mutation-tests.yml`. If reports are added, apply the **Short-lived test artifacts** retention class below.

### `secret-scan.yml`, `ci.yml`, `indexer-tests.yml`, `load-tests.yml`

No `actions/upload-artifact` steps. Build logs are retained by GitHub Actions default (90 days for logs, not stored as downloadable artifacts).

---

## Retention Classes

Use the following classes when adding new `upload-artifact` steps. Do not introduce a new retention period without updating this document.

| Class | `retention-days` | Use For |
|---|---|---|
| **Release artifacts** | 90 | SBOMs, release binaries, provenance metadata — anything needed for supply-chain audit or incident forensics |
| **Deployment operations** | 30 | Health gate reports, deploy logs — needed for post-deploy incident review but not long-term audit |
| **Short-lived test artifacts** | 14 | Playwright reports, mutation reports, load test results — useful for recent PR review; not needed after a sprint |
| **Temporary debug artifacts** | 7 | One-off diagnostic uploads; must include a comment in the workflow explaining the short lifetime |

---

## Access Controls

GitHub Actions artifacts inherit the repository's access permissions:

- **Private repository:** Only authenticated users with at least Read access can download artifacts.
- **Public repository:** Artifacts are publicly downloadable. Do not upload artifacts that contain secrets, internal IP addresses, or customer data.

No artifact should ever contain:
- API keys, tokens, or private keys (covered by `secret-scan.yml` on source, but CI scripts can also emit these in logs)
- Database connection strings with credentials
- Full production environment variable files

If an artifact is accidentally uploaded with sensitive content, delete it immediately via **Actions → workflow run → artifact → Delete** and rotate any exposed credentials.

---

## Cleanup Policy

### Automated expiry

GitHub deletes artifacts automatically after the `retention-days` value. No manual cleanup is required for artifacts within policy.

### Release artifact review (quarterly)

During the quarterly reliability review, confirm:
1. All `upload-artifact` steps in every workflow file match the retention classes in this document.
2. No new workflow has been added with an undocumented retention period.
3. Artifacts attached to GitHub Releases are audited: releases older than one year that are not the current production version may have their attached artifact files removed if storage is a concern, but the release itself (notes, tag) must remain.

### Incident artifact retention override

If a workflow run produced artifacts that are needed for an active security incident or regulatory investigation, download them locally before the retention period expires. GitHub does not support extending the retention of an already-uploaded artifact. Record the download location in the incident issue.

---

## Adding a New Artifact

When adding a new `actions/upload-artifact` step to any workflow:

1. Choose the retention class that matches the artifact's purpose.
2. Set `retention-days` explicitly — do not rely on the GitHub default (currently 90 days, but subject to change).
3. Set `if-no-files-found: error` for required artifacts and `if-no-files-found: ignore` for optional reports (such as Playwright reports that are skipped on fast-fail).
4. Add a row to the inventory table in this document.
5. If the artifact could contain secrets or sensitive data, add a note in the workflow comment explaining why it does not.

Example:

```yaml
- name: Upload test report
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: my-test-report-${{ github.run_id }}
    path: reports/
    retention-days: 14          # Short-lived test artifact — see ci-artifact-retention-policy.md
    if-no-files-found: ignore
```

---

## Owner and Trigger

**Owner:** DevOps Lead  
**Trigger:** Review this document when a new workflow is added, an existing workflow is modified to add or remove artifact uploads, or the quarterly reliability review is due.  
**Expected output:** This document kept current; all `upload-artifact` steps verified against the retention classes; any out-of-policy artifact steps updated in the workflow YAML.
