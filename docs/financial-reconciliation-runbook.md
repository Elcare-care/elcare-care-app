# Financial Reconciliation Incident Runbook

## Overview

This runbook provides step-by-step procedures for investigating and resolving financial reconciliation alerts for protocol fees, royalties, sales, and refunds. The reconciliation system compares event-derived aggregates with indexed transfer totals to detect drift.

## Alert Severity Levels

- **Critical**: Immediate investigation required. May indicate missing or duplicate payouts affecting financial integrity.
- **High**: Investigate within 15 minutes. Multiple drifts or systematic issues.
- **Medium**: Investigate within 1 hour. Isolated drifts or timing discrepancies.
- **Low**: Monitor for patterns. May be provisional events or timing-related.

## Prerequisites

- Access to the indexer database (PostgreSQL)
- Access to Prometheus/Grafana for metrics
- Access to indexer logs
- Understanding of Stellar Soroban event structure
- Database query permissions for reconciliation tables

## Investigation Steps

### 1. Verify Alert Context

**Action**: Check the Financial Reconciliation Dashboard in Grafana

```bash
# Navigate to: Financial Reconciliation Dashboard
# Review:
# - Open Financial Drifts by Severity
# - Oldest Unresolved Drift Age
# - Financial Drift Detection Rate
# - Protocol-Level Financial Aggregates
```

**Key Information to Gather**:
- Alert severity and timestamp
- Entity type affected (protocol_fee, royalty, sale, refund)
- Scope (token, collection, ledger range)
- Drift amount and basis points
- Whether the drift is provisional

### 2. Query Drift Details

**Action**: Query the FinancialDrift table for specific alert details

```sql
-- Get drift details for the alert
SELECT 
  id,
  run_id,
  entity_type,
  entity_id,
  ledger_sequence,
  token,
  collection,
  expected_amount,
  actual_amount,
  drift_amount,
  drift_bps,
  severity,
  status,
  reason,
  is_provisional,
  confirmation_depth,
  detected_at
FROM "FinancialDrift"
WHERE severity = 'Critical'
   OR (severity = 'High' AND detected_at > NOW() - INTERVAL '1 hour')
ORDER BY detected_at DESC
LIMIT 20;
```

**Analysis**:
- Identify if drift is provisional (may resolve with confirmation depth)
- Check if drift is isolated or part of a pattern
- Note the specific reason (missing_payout, duplicate_payout, wrong_token)

### 3. Compare Event vs Transfer Data

**Action**: Cross-reference MarketplaceEvent with RoyaltyPayment

```sql
-- For royalty drifts, compare event totals with payment totals
SELECT 
  me.event_type,
  me.ledger_sequence,
  me.data->>'amount' as event_amount,
  me.data->>'token' as event_token,
  rp.amount as payment_amount,
  rp.recipient
FROM "MarketplaceEvent" me
LEFT JOIN "RoyaltyPayment" rp ON rp.ledger_sequence = me.ledger_sequence
WHERE me.event_type = 'ROYALTY_PAID'
  AND me.ledger_sequence BETWEEN <FROM_LEDGER> AND <TO_LEDGER>
  AND me.confirmed = true
ORDER BY me.ledger_sequence DESC;
```

**Analysis**:
- Identify events without corresponding payments (missing payouts)
- Identify payments without corresponding events (duplicate payouts)
- Check for amount mismatches
- Verify token addresses match

### 4. Check Aggregate Snapshots

**Action**: Compare current aggregates with previous snapshots

```sql
-- Get recent aggregate snapshots for the affected scope
SELECT 
  snapshot_type,
  scope_key,
  ledger_from,
  ledger_to,
  protocol_fees_total,
  royalties_total,
  sales_total,
  refunds_total,
  protocol_fee_count,
  royalty_count,
  sale_count,
  refund_count,
  confirmed_only,
  created_at
FROM "FinancialAggregateSnapshot"
WHERE snapshot_type = '<SCOPE_TYPE>'  -- per_ledger, per_token, per_collection, protocol
  AND scope_key = '<SCOPE_KEY>'
ORDER BY created_at DESC
LIMIT 10;
```

**Analysis**:
- Identify when the drift started (compare with previous snapshots)
- Check if drift is growing or stable
- Verify if confirmed vs provisional aggregates differ

### 5. Review Indexer Logs

**Action**: Check indexer logs for the relevant ledger range

```bash
# Search for reconciliation logs
grep "FinancialReconciler" /var/log/indexer/indexer.log | tail -100

# Search for event processing errors
grep "ERROR.*ROYALTY_PAID\|ERROR.*PROTOCOL_FEE_COLLECTED" /var/log/indexer/indexer.log | tail -50

# Check for reorg events
grep "reorg\|Reorg" /var/log/indexer/indexer.log | tail -20
```

**Analysis**:
- Identify if reconciliation runs are completing successfully
- Check for event processing errors during the affected period
- Verify if reorgs may have caused event duplication or deletion

## Resolution Procedures

### Missing Payout (Event without Transfer)

**Symptoms**: Event exists but no corresponding RoyaltyPayment row

**Steps**:
1. Verify the event is confirmed (not provisional)
2. Check if the event was processed after the reconciliation run
3. Manually trigger reconciliation for the specific ledger range:
   ```typescript
   await runFinancialReconciliation(ledgerFrom, ledgerTo, {
     toleranceBps: 100,
     includeProvisional: false,
     confirmationDepth: 32
   }, false); // dryRun = false
   ```
4. If drift persists, investigate event parser logic
5. Check for dead-letter events that may have failed to process

### Duplicate Payout (Transfer without Event)

**Symptoms**: RoyaltyPayment exists but no corresponding MarketplaceEvent

**Steps**:
1. Verify the payment is not from a different contract or system
2. Check for reorg events that may have orphaned payments
3. Query the ledger on-chain to verify the actual transaction:
   ```bash
   # Use Stellar RPC to verify transaction
   stellar-sdk tx <TRANSACTION_HASH>
   ```
4. If payment is invalid, mark for manual correction
5. Update FinancialDrift with resolution notes

### Wrong Token Payout

**Symptoms**: Payout amount matches but token address differs

**Steps**:
1. Verify the correct token address from the event data
2. Check if token whitelist changes occurred
3. Verify contract upgrade didn't change token handling
4. If systematic issue, check event schema version compatibility
5. Update tolerance policy if token differences are expected

### Provisional Event Drift

**Symptoms**: Drift marked as provisional with confirmation depth

**Steps**:
1. Wait for confirmation depth to be reached (default: 32 ledgers)
2. Re-run reconciliation with `includeProvisional: false`
3. If drift persists after confirmation, investigate as non-provisional
4. Adjust confirmation depth if network conditions require

### Systematic Drift Pattern

**Symptoms**: Multiple drifts of same type across different scopes

**Steps**:
1. Check for recent contract upgrades
2. Verify event schema version compatibility
3. Review recent parser changes
4. Check for database migration issues
5. Consider rolling back recent changes if pattern correlates

## Escalation Criteria

Escalate to engineering team if:
- Critical drift persists for > 30 minutes
- High-severity drift count exceeds 10
- Systematic pattern affects > 3 entity types
- Reconciliation runs consistently fail
- Manual correction required for > 5 drifts

## Prevention Measures

### Regular Monitoring

- Set up Grafana dashboard alerts for drift thresholds
- Review reconciliation status daily
- Monitor reconciliation run duration and success rate

### Configuration Tuning

Adjust tolerance policies based on network conditions:
```bash
# Environment variables
FINANCIAL_RECONCILE_TOLERANCE_BPS=100          # Default 1%
FINANCIAL_RECONCILE_PROVISIONAL_TOLERANCE_BPS=500  # Default 5%
FINANCIAL_RECONCILE_CONFIRMATION_DEPTH=32      # Default 32 ledgers
FINANCIAL_RECONCILE_ALERT_THRESHOLD_BPS=200    # Default 2%
```

### Data Quality Checks

- Run daily reconciliation on full ledger range
- Compare aggregates across different time windows
- Validate against on-chain state for high-value transactions

## Post-Incident Actions

1. **Document Findings**: Update incident ticket with root cause
2. **Update Drift Records**: Mark resolved drifts with resolution notes
3. **Adjust Policies**: Update tolerance policies if needed
4. **Improve Detection**: Add alerts for similar patterns
5. **Team Review**: Conduct post-mortem for critical incidents

## Runbook Maintenance

- Update this runbook when new entity types are added
- Add new resolution procedures as patterns emerge
- Review and update quarterly
- Test procedures during scheduled drills

## Contact Information

- **On-Call Engineer**: [CONTACT]
- **Database Team**: [CONTACT]
- **Smart Contract Team**: [CONTACT]
- **Product Engineering**: [CONTACT]

## Related Documentation

- [Financial Reconciliation Architecture](./financial-reconciliation-architecture.md)
- [Event Schema Reference](./event-schema-reference.md)
- [Database Schema](../indexer/prisma/schema.prisma)
- [Prometheus Alerts](../indexer/prometheus-alerts.yml)
