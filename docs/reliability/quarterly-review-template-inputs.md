# Quarterly Review Input Collection Template

Use this template to gather artifacts **before** the quarterly reliability review session. The review chair should collect these inputs and link them in the decision record.

---

## Review Information

**Quarter:** YYYY-QN  
**Target Review Date:** YYYY-MM-DD  
**Review Chair:**  
**Expected Participants:**

---

## 1. Contract Releases and `CONTRACT_VERSION` Changes

**Owner:** On-chain safety (Backend Lead - contracts)

**Artifacts to collect:**
- [ ] Git tags for contract releases since last review
- [ ] Deploy logs or deployment runbook outcomes
- [ ] `versions.toml` snapshot showing current production state
- [ ] Any contract upgrade incidents or rollbacks

**Summary:**
```
Release ID: 
Contract Version (marketplace): 
Contract Version (launchpad): 
Deployment Date: 
Notable Changes: 
```

**Links:**
- 

---

## 2. Audit / Security Scan Findings

**Owner:** Security Lead

**Artifacts to collect:**
- [ ] Cargo audit output (`cargo audit`)
- [ ] npm audit output (`npm audit`)
- [ ] Gitleaks scan results
- [ ] External audit reports (if any)
- [ ] Triaged findings from `SECURITY_SCANNING_TRIAGE.md` (if exists)

**Summary:**
```
High/Critical CVEs: 
Dependency Updates Required: 
Security Findings: 
```

**Links:**
- 

---

## 3. Production Metrics and SLO Signals

**Owner:** Availability (DevOps Engineer)

**Artifacts to collect:**
- [ ] Prometheus dashboard snapshot (indexer lag, error rates)
- [ ] Health endpoint status (last 90 days)
- [ ] Uptime percentage
- [ ] RPC failover incidents
- [ ] Cache invalidation metrics (if instrumented)

**Summary:**
```
Indexer Lag (p95): 
Error Rate (p99): 
Uptime: 
Notable Outages: 
```

**Links:**
- 

---

## 4. Incidents and Near Misses

**Owner:** Review Chair

**Artifacts to collect:**
- [ ] All completed incident write-ups in `docs/incidents/` since last review
- [ ] Near-miss events (see quarterly review process definition)
- [ ] Post-incident action items and their completion status
- [ ] Tabletop exercise outcomes (see `docs/runbooks/tabletop-exercises.md`)

**Summary:**
```
Incidents This Quarter: 
Near Misses: 
Unresolved Action Items: 
```

**Links:**
- 

---

## 5. Dependency and Compatibility Reports

**Owner:** Data Correctness (Backend Lead - indexer)

**Artifacts to collect:**
- [ ] `scripts/validate-compatibility.sh` output (CI run or local)
- [ ] Dependabot alerts summary
- [ ] Event schema version drift analysis
- [ ] Database migration compatibility (if migrations ran)

**Summary:**
```
Compatibility Validation: Pass / Fail
Version Mismatches: 
Pending Dependabot PRs: 
```

**Links:**
- 

---

## 6. Support Trends

**Owner:** Support (Frontend Lead or designated liaison)

**Artifacts to collect:**
- [ ] GitHub issues labeled `support` (last 90 days)
- [ ] Internal support ticket summary (if using external system)
- [ ] Common user-reported errors (contract error codes, wallet issues)
- [ ] Transaction UX friction points

**Summary:**
```
Total Support Requests: 
Top 3 Issues: 
1. 
2. 
3. 

User-Facing Gaps: 
```

**Links:**
- 

---

## 7. Tabletop / Exercise Outcomes

**Owner:** Security Lead

**Artifacts to collect:**
- [ ] Completed tabletop exercises from `docs/runbooks/tabletop-exercises.md`
- [ ] Findings and action items from each exercise
- [ ] Runbook gaps identified during exercises

**Summary:**
```
Exercises Completed This Quarter: 
High-Priority Findings: 
Runbook Updates Needed: 
```

**Links:**
- 

---

## 8. Open Reliability Backlog

**Owner:** Review Chair

**Artifacts to collect:**
- [ ] Current state of `docs/reliability/backlog.md`
- [ ] Open GitHub issues tagged `reliability`
- [ ] Stale backlog items (>6 months old, no updates)

**Summary:**
```
Total Open Items: 
High-Priority Items (score >10): 
Stale Items Requiring Re-score: 
```

**Links:**
- 

---

## 9. Load Test Results (if available)

**Owner:** Availability (DevOps Engineer)

**Artifacts to collect:**
- [ ] `LOAD_TEST_RESULTS.md` (if exists)
- [ ] Performance regression analysis
- [ ] Stress test outcomes (peak load, failure thresholds)

**Summary:**
```
Last Load Test Date: 
Peak Throughput: 
Bottlenecks Identified: 
```

**Links:**
- 

---

## 10. Accessibility and Privacy

**Owner (Accessibility):** Frontend Lead  
**Owner (Privacy):** Security Lead + Legal (as needed)

**Artifacts to collect:**
- [ ] jest-axe CI failures or regressions
- [ ] Playwright a11y test results
- [ ] WCAG gap analysis (if available)
- [ ] PII audit findings (logs, retention, moderation data)
- [ ] Privacy policy updates or compliance changes

**Summary:**
```
A11y Regressions: 
WCAG Compliance Status: 
PII Findings: 
```

**Links:**
- 

---

## Pre-Review Checklist

Before the review session, confirm:

- [ ] All domain owners have submitted their inputs
- [ ] Version baseline is captured (`versions.toml` snapshot)
- [ ] Compatibility validation script has run
- [ ] All artifacts are linked in this document
- [ ] Review chair has prepared agenda with focus topics
- [ ] Decision record template is ready to populate

---

## Change Log

| Date | Change |
|---|---|
| 2026-08-26 | Initial input collection template (Issue #346) |
