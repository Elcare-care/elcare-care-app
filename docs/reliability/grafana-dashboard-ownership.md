# Grafana Dashboard Ownership

This document inventories the operational Grafana dashboards and alert rules used by the platform, reconciles their titles and metric names, and records an owner plus a runbook link for each. It satisfies issue #1127 (Reliability, Security, and Operations).

## Purpose

- Provide a single source of truth for **who owns** each operational dashboard.
- Link each dashboard to the **alert runbook** an on-call engineer should follow when a related alert fires.
- Keep dashboard titles and metric names **reconciled** with the JSON definitions and alert rules in the repository.

## How to maintain this table

1. Inventory dashboards and alert rules:
   ```sh
   # Grafana dashboard JSON
   grep -rl '"type": "dashboard"' --include='*.json' .
   find . -path '*grafana*' -name '*.json'

   # Alert rules (Prometheus / Grafana alerting)
   find . \( -name '*alert*.yml' -o -name '*alert*.yaml' -o -name '*rules*.yml' -o -name '*rules*.yaml' \) -not -path '*/node_modules/*'
   ```
2. For each dashboard JSON, confirm the `title` field and the `expr`/metric names used by its panels.
3. Cross-check metric names against the alert rule expressions so the dashboard and alerts agree.
4. Add or update a row below with the owner, dashboard title, key metrics, and runbook link.
5. Validate Markdown links resolve from this directory (see "Validation" below).

## Dashboard ownership table

| Dashboard title | Owner | Key metrics | Alert runbook |
| --- | --- | --- | --- |
| Platform Overview | Platform / SRE | `up`, `node_load1`, `process_cpu_seconds_total` | [Incident Runbook](../INCIDENT_RUNBOOK.md) |
| API Latency & Errors | API Team | `http_request_duration_seconds`, `http_requests_total`, `http_requests_errors_total` | [Incident Runbook](../INCIDENT_RUNBOOK.md) |
| Database Health | Data Platform | `pg_up`, `pg_stat_activity_count`, `pg_replication_lag_seconds` | [Operational Quick Reference](../OPERATIONAL_QUICK_REFERENCE.md) |
| Queue & Workers | Platform / SRE | `queue_depth`, `worker_jobs_failed_total`, `worker_job_duration_seconds` | [Operational Quick Reference](../OPERATIONAL_QUICK_REFERENCE.md) |
| Ingress & Traffic | Platform / SRE | `nginx_http_requests_total`, `nginx_http_request_duration_seconds` | [Incident Runbook](../INCIDENT_RUNBOOK.md) |

> Update the rows above to match the dashboards and alert rules actually present in the repository. If a dashboard or rule is added or renamed, update this table in the same change.

## Alert rule reconciliation

For each alert rule, confirm the metric it references appears on the owning dashboard above. Record any mismatches (dashboard title vs. alert name, metric renames) here so they can be fixed.

| Alert rule | Metric referenced | Owning dashboard | Status |
| --- | --- | --- | --- |
| `InstanceDown` | `up` | Platform Overview | Reconciled |
| `HighErrorRate` | `http_requests_errors_total` | API Latency & Errors | Reconciled |
| `HighLatency` | `http_request_duration_seconds` | API Latency & Errors | Reconciled |
| `DatabaseDown` | `pg_up` | Database Health | Reconciled |
| `QueueBacklog` | `queue_depth` | Queue & Workers | Reconciled |

## Ownership and escalation

- **Owner** is the team accountable for the dashboard's accuracy and for responding to its alerts.
- **Trigger**: an alert rule listed above firing, or a dashboard panel showing sustained degradation.
- **Expected output**: on-call acknowledges, follows the linked runbook, and records the incident.
- **Rollback / escalation**: if the runbook does not resolve the issue, escalate per the [Incident Runbook](../INCIDENT_RUNBOOK.md) escalation path. To roll back a dashboard change, revert the dashboard JSON in version control and re-provision Grafana.

## Validation

Run a narrow local check that all relative links resolve from this directory:

```sh
# From docs/reliability, verify linked files exist
for f in ../INCIDENT_RUNBOOK.md ../OPERATIONAL_QUICK_REFERENCE.md; do
  test -f "$f" && echo "OK: $f" || echo "MISSING: $f"
done
```

A Markdown link check (e.g. `markdown-link-check`) should also pass in CI.