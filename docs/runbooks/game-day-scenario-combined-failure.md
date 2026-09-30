# Game Day Scenario: Combined Infrastructure Failure

**Scenario Name:** "Perfect Storm" — Indexer Loss, Database Restore, RPC Provider Change, and SSE Reconnection  
**Severity:** CRITICAL — Combined service outage affecting all core infrastructure  
**Target RTO:** 60 minutes (service restoration)  
**Target RPO:** 5 minutes (data loss tolerance)  
**Duration:** 90-120 minutes (including debrief)  
**Frequency:** Quarterly  

---

## Overview

This game day simulates a combined infrastructure failure where multiple critical components fail simultaneously:
1. **Indexer loss** — Indexer service becomes unavailable or corrupted
2. **Database restore** — Primary database requires restoration from backup
3. **RPC provider change** — Primary Stellar RPC provider becomes unavailable, requiring switch to backup
4. **SSE reconnection** — Real-time event streams must reconnect after service restoration

Unlike individual component failures covered in existing runbooks, this scenario tests the team's ability to coordinate across multiple systems, prioritize recovery steps, and maintain data consistency during complex recovery operations.

---

## Scenario Objectives

### Primary Objectives
- Restore full service within the stated RTO (60 minutes)
- Restore data within the stated RPO (5 minutes of data loss maximum)
- Verify reconciliation of canonical events and financial projections
- Validate end-to-end functionality across all affected systems

### Secondary Objectives
- Test team coordination and communication during complex incidents
- Identify gaps in existing runbooks when failures overlap
- Validate backup/restore procedures under time pressure
- Exercise frontend recovery and user-facing state management
- Collect performance metrics for process improvement

---

## Prerequisites

### Infrastructure Requirements
- **Staging environment** with isolated services matching production configuration
- **Known ledger state** — Pre-seeded with realistic test data (listings, auctions, events)
- **Backup system** — Working backup/restore scripts with recent backup available
- **Multiple RPC providers** — At least 2 Stellar RPC endpoints configured
- **Monitoring stack** — Prometheus, Grafana, or equivalent for metrics collection
- **Communication channels** — Slack/incident channel, status page access

### Data Preparation
```bash
# 1. Seed staging environment with known ledger state
cd indexer
npx tsx scripts/seed-test-data.ts \
  --ledgers 1000 \
  --listings 50 \
  --auctions 10 \
  --events 500

# 2. Create baseline backup before scenario
DATABASE_URL=$STAGING_DB_URL \
BACKUP_ENCRYPTION_KEY=$TEST_ENCRYPTION_KEY \
BACKUP_DIR=/tmp/game-day-prep \
./scripts/backup/backup.sh

# 3. Record baseline metrics
curl http://staging-indexer:4000/metrics > /tmp/game-day-baseline-metrics.txt
psql $STAGING_DB_URL -c "SELECT COUNT(*) FROM \"Listing\"" > /tmp/game-day-baseline-listings.txt
psql $STAGING_DB_URL -c "SELECT COUNT(*) FROM \"MarketplaceEvent\"" > /tmp/game-day-baseline-events.txt
```

### Tooling
- **Backup/restore scripts** — `scripts/backup/backup.sh` and `scripts/backup/restore.sh`
- **Database client** — `psql` for direct database queries
- **Stellar CLI** — For contract interactions and RPC verification
- **SSE test client** — For validating real-time event streams
- **Metrics collector** — For recording timing and performance data

---

## Roles and Responsibilities

| Role | Primary Responsibilities | Required Access |
|------|-------------------------|-----------------|
| **Incident Commander** | Overall coordination, decision-making, timeline management | All systems, communication channels |
| **Database Lead** | Database restore, data validation, reconciliation procedures | Database access, backup system |
| **Indexer Lead** | Indexer recovery, RPC failover, sync state management | Indexer deployment, RPC endpoints |
| **Frontend Lead** | SSE reconnection validation, user-facing state verification | Frontend deployment, SSE endpoints |
| **DevOps Engineer** | Infrastructure recovery, service orchestration, monitoring | Docker/Kubernetes, monitoring stack |
| **Security Lead** | Secret rotation verification, access control, audit logging | Secrets manager, access logs |
| **Scribe** | Timeline recording, action tracking, evidence collection | Documentation system |
| **Observer** | Process observation, gap identification, feedback collection | Read-only access to all systems |

---

## Success Measures

### Service Restoration (RTO)
- **TARGET:** 60 minutes from incident start to full service restoration
- **MEASUREMENT:** Time from scenario start to all health checks passing
- **CRITERIA:**
  - Indexer `/health` returns 200
  - Indexer `/readyz` returns 200 with sync lag < 10 ledgers
  - Frontend can successfully query all API endpoints
  - SSE connections can be established and receive events

### Data Restoration (RPO)
- **TARGET:** Maximum 5 minutes of data loss (approximately 60 ledgers on Stellar)
- **MEASUREMENT:** Ledger gap between last backup and recovery point
- **CRITERIA:**
  - Backup age < 5 minutes at time of failure
  - Restore process includes gap replay for missed ledgers
  - Final sync state matches network tip within acceptable lag

### Data Integrity
- **TARGET:** 100% reconciliation of canonical events and financial projections
- **MEASUREMENT:** Post-recovery reconciliation run shows zero discrepancies
- **CRITERIA:**
  - All `MarketplaceEvent` rows have corresponding on-chain events
  - Financial aggregates (protocol fees, royalties) match event-derived totals
  - No orphaned records in any table
  - `LedgerGap` table shows no open gaps

### End-to-End Functionality
- **TARGET:** All user-facing workflows operational
- **MEASUREMENT:** Successful completion of test transactions
- **CRITERIA:**
  - New listings can be created and appear in frontend
  - Bids can be placed on auctions
  - Real-time events are received via SSE
  - Wallet activity feeds update correctly

---

## Evidence Collection

### Timeline Evidence
```bash
# Record all actions with timestamps
echo "$(date -u +%FT%TZ) - Scenario started" >> /tmp/game-day-timeline.log
echo "$(date -u +%FT%TZ) - Indexer failure detected" >> /tmp/game-day-timeline.log
echo "$(date -u +%FT%TZ) - Database restore initiated" >> /tmp/game-day-timeline.log
# ... continue for all major actions
```

### Performance Metrics
```bash
# Record timing for each major phase
time_backup_restore=$(grep "Database restore" /tmp/game-day-timeline.log | head -1)
time_indexer_recovery=$(grep "Indexer recovery" /tmp/game-day-timeline.log | head -1)
time_rpc_failover=$(grep "RPC failover" /tmp/game-day-timeline.log | head -1)
time_sse_reconnect=$(grep "SSE reconnection" /tmp/game-day-timeline.log | head -1)

# Calculate phase durations
echo "Backup restore duration: $time_backup_restore" >> /tmp/game-day-metrics.txt
echo "Indexer recovery duration: $time_indexer_recovery" >> /tmp/game-day-metrics.txt
```

### System State Evidence
```bash
# Capture system state at key points
function capture_state() {
  local phase=$1
  mkdir -p /tmp/game-day-evidence/$phase
  
  # Database state
  psql $STAGING_DB_URL -c "\dt" > /tmp/game-day-evidence/$phase/db-schema.txt
  psql $STAGING_DB_URL -c "SELECT COUNT(*) FROM \"Listing\"" > /tmp/game-day-evidence/$phase/listing-count.txt
  psql $STAGING_DB_URL -c "SELECT COUNT(*) FROM \"MarketplaceEvent\"" > /tmp/game-day-evidence/$phase/event-count.txt
  
  # Indexer state
  curl http://staging-indexer:4000/health > /tmp/game-day-evidence/$phase/indexer-health.txt
  curl http://staging-indexer:4000/readyz > /tmp/game-day-evidence/$phase/indexer-readyz.txt
  curl http://staging-indexer:4000/metrics > /tmp/game-day-evidence/$phase/indexer-metrics.txt
  
  # Sync state
  psql $STAGING_DB_URL -c "SELECT * FROM \"SyncState\"" > /tmp/game-day-evidence/$phase/sync-state.txt
}

capture_state "pre-incident"
capture_state "post-failure"
capture_state "post-restore"
capture_state "post-recovery"
```

### Error Evidence
```bash
# Capture all errors and warnings
docker compose logs indexer > /tmp/game-day-evidence/indexer-logs.txt
docker compose logs db > /tmp/game-day-evidence/db-logs.txt
grep -i "error\|warning\|fail" /tmp/game-day-evidence/*.txt > /tmp/game-day-evidence/errors-summary.txt
```

### Verification Evidence
```bash
# Run reconciliation and capture results
cd indexer
npx tsx scripts/run-reconciliation.ts \
  --from-backup \
  --to-current \
  > /tmp/game-day-evidence/reconciliation-results.txt

# Record any discrepancies
grep -i "discrepancy\|drift\|mismatch" /tmp/game-day-evidence/reconciliation-results.txt \
  > /tmp/game-day-evidence/discrepancies.txt
```

---

## Implementation Procedure

### Phase 1: Scenario Initiation (T+0 to T+5)

**Objective:** Establish baseline and introduce failure simulation

**Steps:**
1. **Baseline Recording**
   ```bash
   # Record initial state
   capture_state "pre-incident"
   
   # Verify all systems are healthy
   curl http://staging-indexer:4000/health | jq '.status'
   curl http://staging-indexer:4000/readyz | jq '.ready'
   psql $STAGING_DB_URL -c "SELECT 1"
   ```

2. **Introduce Failures**
   ```bash
   # Stop indexer (simulating indexer loss)
   docker compose stop indexer
   
   # Corrupt database (simulating database failure requiring restore)
   docker compose exec db psql -U postgres -d marketplace_indexer -c "DROP TABLE IF EXISTS \"Listing\";"
   
   # Block primary RPC (simulating RPC provider failure)
   # Note: This should be done via network configuration or firewall rules
   iptables -A OUTPUT -p tcp -d soroban-testnet.stellar.org --dport 443 -j DROP
   ```

3. **Confirm Failure State**
   ```bash
   # Verify indexer is down
   curl http://staging-indexer:4000/health
   
   # Verify database is corrupted
   psql $STAGING_DB_URL -c "SELECT COUNT(*) FROM \"Listing\""
   
   # Verify RPC is unreachable
   stellar rpc --rpc-url https://soroban-testnet.stellar.org getLatestLedger
   ```

**Timeline:** T+0 to T+5 minutes  
**Owner:** Incident Commander  
**Evidence:** Capture failure state evidence

---

### Phase 2: Assessment and Planning (T+5 to T+15)

**Objective:** Assess impact, plan recovery sequence, assign tasks

**Steps:**
1. **Impact Assessment**
   ```bash
   # Check current system state
   docker compose ps
   psql $STAGING_DB_URL -c "\dt"
   
   # Check backup availability
   ls -lah /tmp/game-day-prep/
   ```

2. **Recovery Planning**
   - Determine recovery sequence based on dependencies
   - Assign specific tasks to team members
   - Establish communication protocol
   - Set checkpoint times

3. **Task Assignment**
   - Database Lead: Database restore preparation
   - Indexer Lead: RPC failover preparation
   - DevOps Engineer: Service orchestration preparation
   - Frontend Lead: SSE reconnection test preparation

**Timeline:** T+5 to T+15 minutes  
**Owner:** Incident Commander  
**Evidence:** Record recovery plan and task assignments

---

### Phase 3: Database Restore (T+15 to T+35)

**Objective:** Restore database from backup and validate integrity

**Steps:**
1. **Pre-Restore Preparation**
   ```bash
   # Stop all database connections
   docker compose stop indexer
   
   # Record current corrupted state
   capture_state "post-failure"
   
   # Prepare restore environment
   export RESTORE_TARGET_URL=$STAGING_DB_URL
   export BACKUP_FILE=/tmp/game-day-prep/pg_backup_*.dump.enc
   export BACKUP_ENCRYPTION_KEY=$TEST_ENCRYPTION_KEY
   ```

2. **Execute Restore**
   ```bash
   # Run restore script
   chmod +x scripts/backup/restore.sh
   ./scripts/backup/restore.sh
   
   # Verify restore completion
   echo "Restore exit code: $?"
   ```

3. **Post-Restore Validation**
   ```bash
   # Verify database connectivity
   psql $STAGING_DB_URL -c "SELECT 1"
   
   # Verify table counts match baseline
   psql $STAGING_DB_URL -c "SELECT COUNT(*) FROM \"Listing\""
   diff /tmp/game-day-baseline-listings.txt <(psql $STAGING_DB_URL -c "SELECT COUNT(*) FROM \"Listing\"")
   
   # Verify sync state
   psql $STAGING_DB_URL -c "SELECT * FROM \"SyncState\""
   ```

4. **Run Migrations**
   ```bash
   # Apply any schema changes since backup
   cd indexer
   DATABASE_URL=$STAGING_DB_URL npx prisma migrate deploy
   ```

**Timeline:** T+15 to T+35 minutes  
**Owner:** Database Lead  
**Success Criteria:** Database restored, all tables present, baseline counts match  
**Evidence:** Capture post-restore state, run validation queries

---

### Phase 4: RPC Provider Failover (T+35 to T+45)

**Objective:** Switch to backup RPC provider and validate connectivity

**Steps:**
1. **RPC Provider Assessment**
   ```bash
   # Test backup RPC connectivity
   stellar rpc --rpc-url $BACKUP_STELLAR_RPC_URL getLatestLedger
   
   # Compare network state between providers
   stellar rpc --rpc-url $PRIMARY_STELLAR_RPC_URL getLatestLedger
   stellar rpc --rpc-url $BACKUP_STELLAR_RPC_URL getLatestLedger
   ```

2. **Update Configuration**
   ```bash
   # Update indexer environment to use backup RPC
   # This should be done via your deployment system (env vars, config map, etc.)
   export STELLAR_RPC_URL=$BACKUP_STELLAR_RPC_URL
   
   # Update docker-compose or deployment configuration
   # sed -i 's|PRIMARY_RPC_URL|BACKUP_RPC_URL|g' docker-compose.yml
   ```

3. **Restart Indexer with New RPC**
   ```bash
   # Restart indexer with new configuration
   docker compose up -d indexer
   
   # Wait for indexer to start
   sleep 30
   
   # Verify indexer is using new RPC
   docker compose logs indexer | grep "STELLAR_RPC_URL"
   ```

4. **Validate RPC Connectivity**
   ```bash
   # Check indexer can reach new RPC
   curl http://staging-indexer:4000/health | jq '.checks.rpc'
   
   # Verify sync progress
   curl http://staging-indexer:4000/metrics | grep indexer_latest_ledger_processed
   ```

**Timeline:** T+35 to T+45 minutes  
**Owner:** Indexer Lead  
**Success Criteria:** Indexer connects to backup RPC, sync resumes  
**Evidence:** Capture RPC switch logs, verify sync progress

---

### Phase 5: Indexer Recovery and Gap Replay (T+45 to T+55)

**Objective:** Resume indexer operation and replay any missed ledgers

**Steps:**
1. **Indexer Health Check**
   ```bash
   # Verify indexer is healthy
   curl http://staging-indexer:4000/health | jq '.status'
   
   # Check sync state
   curl http://staging-indexer:4000/readyz | jq '.ready'
   
   # Check sync lag
   curl http://staging-indexer:4000/metrics | grep sync_latency_ledgers
   ```

2. **Identify Ledger Gaps**
   ```bash
   # Check for ledger gaps
   psql $STAGING_DB_URL -c "
     SELECT * FROM \"LedgerGap\"
     WHERE status = 'Open'
     ORDER BY \"createdAt\" DESC;
   "
   
   # Calculate gap size
   psql $STAGING_DB_URL -c "
     SELECT 
       (SELECT MAX(\"lastLedger\") FROM \"SyncState\") as current_ledger,
       (SELECT \"windowEnd\" FROM \"LedgerCheckpoint\" 
        WHERE status = 'committed' 
        ORDER BY \"windowEnd\" DESC LIMIT 1) as last_checkpoint,
       (SELECT MAX(\"lastLedger\") FROM \"SyncState\") - 
       (SELECT \"windowEnd\" FROM \"LedgerCheckpoint\" 
        WHERE status = 'committed' 
        ORDER BY \"windowEnd\" DESC LIMIT 1) as gap_size;
   "
   ```

3. **Trigger Gap Repair**
   ```bash
   # If gap-repair is enabled, it should trigger automatically
   # Otherwise, manually trigger backfill
   cd indexer
   LAST_CHECKPOINT=$(psql $STAGING_DB_URL -tAc "SELECT \"windowEnd\" FROM \"LedgerCheckpoint\" WHERE status = 'committed' ORDER BY \"windowEnd\" DESC LIMIT 1")
   CURRENT_LEDGER=$(stellar rpc --rpc-url $STELLAR_RPC_URL getLatestLedger | jq '.sequence')
   
   npm run backfill -- \
    --start=$LAST_CHECKPOINT \
    --end=$CURRENT_LEDGER \
    --rpc=$STELLAR_RPC_URL
   ```

4. **Monitor Recovery Progress**
   ```bash
   # Watch sync progress
   watch -n 5 'curl -s http://staging-indexer:4000/metrics | grep indexer_latest_ledger_processed'
   
   # Check for reorg events
   docker compose logs -f indexer | grep -i "reorg\|rollback"
   ```

**Timeline:** T+45 to T+55 minutes  
**Owner:** Indexer Lead  
**Success Criteria:** Sync lag < 10 ledgers, no open gaps  
**Evidence:** Capture sync progress logs, verify gap closure

---

### Phase 6: SSE Reconnection Validation (T+55 to T+60)

**Objective:** Validate SSE reconnection and real-time event delivery

**Steps:**
1. **SSE Endpoint Health Check**
   ```bash
   # Verify SSE endpoint is accessible
   curl -I http://staging-indexer:4000/events
   
   # Check connection limits
   curl http://staging-indexer:4000/health | jq '.checks.sse'
   ```

2. **Test SSE Connection**
   ```bash
   # Create test SSE client
   timeout 30 curl -N -H "Accept: text/event-stream" \
     http://staging-indexer:4000/events > /tmp/game-day-sse-test.txt
   
   # Verify connection received events
   grep "CONNECTED" /tmp/game-day-sse-test.txt
   grep "heartbeat" /tmp/game-day-sse-test.txt
   ```

3. **Test Reconnection Logic**
   ```bash
   # Test Last-Event-ID replay
   LAST_EVENT_ID=$(grep "^id:" /tmp/game-day-sse-test.txt | tail -1 | cut -d: -f2)
   
   timeout 30 curl -N -H "Accept: text/event-stream" \
     -H "Last-Event-ID: $LAST_EVENT_ID" \
     http://staging-indexer:4000/events > /tmp/game-day-sse-reconnect.txt
   
   # Verify replay worked
   grep "CONNECTED" /tmp/game-day-sse-reconnect.txt
   ```

4. **Generate Test Events**
   ```bash
   # Create a test listing to generate real events
   # This should be done via contract interaction or test script
   cd contracts
   stellar contract invoke \
     --id $MARKETPLACE_CONTRACT_ID \
     --source $TEST_USER_SECRET \
     --rpc-url $STELLAR_RPC_URL \
     -- create_listing \
     --test_data
   ```

5. **Verify Event Delivery**
   ```bash
   # Wait for indexer to process event
   sleep 10
   
   # Check if event appeared in SSE stream
   grep "LISTING_CREATED" /tmp/game-day-sse-test.txt
   ```

**Timeline:** T+55 to T+60 minutes  
**Owner:** Frontend Lead  
**Success Criteria:** SSE connections established, events received, reconnection works  
**Evidence:** Capture SSE test logs, verify event delivery

---

### Phase 7: End-to-End Validation (T+60 to T+70)

**Objective:** Validate complete system functionality and data integrity

**Steps:**
1. **Health Check Validation**
   ```bash
   # All health checks should pass
   curl http://staging-indexer:4000/health | jq '.status'
   curl http://staging-indexer:4000/readyz | jq '.ready'
   
   # Verify sync lag is acceptable
   curl http://staging-indexer:4000/metrics | grep sync_latency_ledgers
   ```

2. **API Functionality Test**
   ```bash
   # Test all major API endpoints
   curl http://staging-indexer:4000/listings | jq '.length'
   curl http://staging-indexer:4000/auctions | jq '.length'
   curl http://staging-indexer:4000/collections | jq '.length'
   
   # Test wallet activity feed
   curl http://staging-indexer:4000/wallets/$TEST_WALLET/activity | jq '.length'
   ```

3. **Data Reconciliation**
   ```bash
   # Run financial reconciliation
   cd indexer
   npx tsx scripts/run-reconciliation.ts \
     --full \
     --tolerance-bps 100 \
     > /tmp/game-day-evidence/final-reconciliation.txt
   
   # Check for discrepancies
   grep -i "discrepancy\|drift" /tmp/game-day-evidence/final-reconciliation.txt
   ```

4. **Canonical Event Verification**
   ```bash
   # Spot-check events against on-chain state
   TEST_LISTING_ID=$(psql $STAGING_DB_URL -tAc "SELECT \"listingId\" FROM \"Listing\" LIMIT 1")
   
   # Compare database state with on-chain state
   psql $STAGING_DB_URL -c "
     SELECT * FROM \"Listing\" WHERE \"listingId\" = '$TEST_LISTING_ID';
   "
   
   stellar contract invoke \
     --id $MARKETPLACE_CONTRACT_ID \
     --rpc-url $STELLAR_RPC_URL \
     -- get_listing \
     --listing_id $TEST_LISTING_ID
   ```

5. **Financial Projection Validation**
   ```bash
   # Verify royalty payments match events
   psql $STAGING_DB_URL -c "
     SELECT 
       COUNT(*) as event_count,
       SUM(CAST(data->>'amount' AS BIGINT)) as total_event_amount
     FROM \"MarketplaceEvent\"
     WHERE event_type = 'ROYALTY_PAID'
     AND confirmed = true;
   "
   
   psql $STAGING_DB_URL -c "
     SELECT 
       COUNT(*) as payment_count,
       SUM(amount) as total_payment_amount
     FROM \"RoyaltyPayment\";
   "
   ```

**Timeline:** T+60 to T+70 minutes  
**Owner:** Database Lead (reconciliation), Frontend Lead (API tests)  
**Success Criteria:** All tests pass, zero discrepancies, data matches on-chain state  
**Evidence:** Capture final validation results, reconciliation reports

---

### Phase 8: Debrief and Documentation (T+70 to T+90)

**Objective:** Review performance, document findings, create action items

**Steps:**
1. **Timeline Review**
   ```bash
   # Calculate actual RTO
   START_TIME=$(grep "Scenario started" /tmp/game-day-timeline.log | cut -d' ' -f1-2)
   END_TIME=$(grep "Service restored" /tmp/game-day-timeline.log | cut -d' ' -f1-2)
   
   # Calculate RPO achievement
   BACKUP_TIME=$(stat -c %Y /tmp/game-day-prep/pg_backup_*.dump.enc)
   FAILURE_TIME=$(stat -c %Y /tmp/game-day-evidence/post-failure/sync-state.txt)
   RPO_ACHIEVED=$(( (FAILURE_TIME - BACKUP_TIME) / 60 ))
   
   echo "Actual RTO: $(( (END_TIME - START_TIME) / 60 )) minutes"
   echo "Actual RPO: $RPO_ACHIEVED minutes"
   ```

2. **Performance Analysis**
   ```bash
   # Analyze phase durations
   echo "Phase durations:" >> /tmp/game-day-final-report.txt
   grep "duration" /tmp/game-day-metrics.txt >> /tmp/game-day-final-report.txt
   
   # Identify bottlenecks
   echo "Slowest phases:" >> /tmp/game-day-final-report.txt
   sort -k2 -nr /tmp/game-day-metrics.txt | head -3 >> /tmp/game-day-final-report.txt
   ```

3. **Gap Analysis**
   ```bash
   # Review any discrepancies found
   if [ -s /tmp/game-day-evidence/discrepancies.txt ]; then
     echo "DISCREPANCIES FOUND:" >> /tmp/game-day-final-report.txt
     cat /tmp/game-day-evidence/discrepancies.txt >> /tmp/game-day-final-report.txt
   else
     echo "No discrepancies found - reconciliation successful" >> /tmp/game-day-final-report.txt
   fi
   ```

4. **Team Debrief**
   - Conduct structured debrief with all participants
   - Discuss what went well and what didn't
   - Identify process improvements
   - Document any missing or unclear procedures

5. **Action Item Creation**
   ```bash
   # Create action items from findings
   cat > /tmp/game-day-action-items.md << 'EOF'
   # Game Day Action Items - $(date +%Y-%m-%d)
   
   ## High Priority
   - [ ] Issue: [Description] - Owner: [Name] - Due: [Date]
   
   ## Medium Priority
   - [ ] Issue: [Description] - Owner: [Name] - Due: [Date]
   
   ## Low Priority
   - [ ] Issue: [Description] - Owner: [Name] - Due: [Date]
   EOF
   ```

**Timeline:** T+70 to T+90 minutes  
**Owner:** Incident Commander  
**Deliverables:** Final report, action items, updated documentation  

---

## Communication Procedures

### Internal Communication

**Incident Channel:**
- Use dedicated Slack channel: `#incident-game-day`
- All status updates must be timestamped
- Use standardized update format:

```
[STATUS] Phase X - [Phase Name] - [Time]
- Progress: [brief description]
- Blockers: [any issues]
- ETA: [estimated completion]
```

**Escalation Triggers:**
- Phase exceeds expected duration by > 50%
- Critical failure in recovery process
- Data integrity concerns identified
- RTO/RPO targets at risk

### External Communication

**Status Page Template:**
```
[Game Day Exercise] ElcareHub Staging Maintenance
We are conducting a scheduled disaster recovery exercise on our staging environment.
This is a drill only and does not affect production services.
Expected duration: 90 minutes
Started: [Time]
Status: [Current Phase]
```

**User Notification (if needed):**
- No user notification required for staging exercise
- Production exercise would require user notification 24 hours in advance

### Documentation Updates

**Real-Time Documentation:**
- Scribe maintains living document throughout exercise
- All decisions and rationale recorded
- Screenshots and logs captured for reference

**Post-Exercise Documentation:**
- Final report completed within 24 hours
- Action items assigned to reliability backlog
- Runbooks updated based on findings
- Lessons learned documented

---

## Follow-Up Tracking

### Immediate Actions (Within 24 Hours)

1. **Final Report Completion**
   - Compile all evidence into final report
   - Calculate actual RTO/RPO achievement
   - Document all deviations from plan

2. **Action Item Assignment**
   - Create GitHub issues for all findings
   - Assign owners and due dates
   - Link to reliability backlog

3. **Documentation Updates**
   - Update relevant runbooks with lessons learned
   - Add new procedures if gaps identified
   - Update this game day scenario based on feedback

### Short-Term Follow-Up (Within 1 Week)

1. **Backlog Integration**
   - Add action items to reliability backlog (`docs/reliability/backlog.md`)
   - Prioritize based on severity and impact
   - Track progress in regular reliability reviews

2. **Process Improvements**
   - Implement quick wins from findings
   - Update monitoring and alerting thresholds
   - Improve automation where manual steps were slow

3. **Team Training**
   - Share lessons learned with wider team
   - Update onboarding materials
   - Schedule additional training if knowledge gaps identified

### Long-Term Follow-Up (Within 1 Month)

1. **Runbook Maintenance**
   - Review and update all related runbooks
   - Add cross-reference between related procedures
   - Improve decision trees for complex scenarios

2. **Infrastructure Improvements**
   - Implement infrastructure changes based on findings
   - Improve backup/restore performance if needed
   - Enhance monitoring and observability

3. **Next Exercise Planning**
   - Schedule next game day based on findings
   - Rotate scenario focus based on risk assessment
   - Incorporate lessons learned into next scenario

---

## Acceptance Criteria Validation

### RTO Validation
- [ ] Service restored within 60 minutes of incident start
- [ ] All health checks passing (health, readyz, SSE)
- [ ] Sync lag within acceptable threshold (< 10 ledgers)
- [ ] Frontend can successfully query all endpoints

### RPO Validation
- [ ] Data loss less than 5 minutes (60 ledgers)
- [ ] Backup age within RPO target at time of failure
- [ ] Gap replay successfully closed all gaps
- [ ] No missing events in recovery window

### Data Integrity Validation
- [ ] Financial reconciliation shows zero discrepancies
- [ ] Canonical events match on-chain state
- [ ] No orphaned records in any table
- [ ] LedgerGap table shows no open gaps

### End-to-End Validation
- [ ] New transactions can be created and processed
- [ ] Real-time events delivered via SSE
- [ ] Frontend state management working correctly
- [ ] All user-facing workflows operational

### Process Validation
- [ ] Team coordination effective throughout
- [ ] Communication procedures followed
- [ ] Evidence collection complete
- [ ] Action items identified and assigned

---

## Rollback Procedures

If at any point the recovery cannot be completed within RTO targets:

1. **Stop Recovery Efforts**
   ```bash
   # Halt all recovery processes
   docker compose stop indexer
   
   # Document current state
   capture_state "rollback-point"
   ```

2. **Restore to Last Known Good State**
   ```bash
   # Restore from pre-exercise backup
   export BACKUP_FILE=/tmp/game-day-prep/pg_backup_*.dump.enc
   export RESTORE_TARGET_URL=$STAGING_DB_URL
   ./scripts/backup/restore.sh
   ```

3. **Investigate Root Cause**
   - Review evidence collected to date
   - Identify specific failure point
   - Document blocking issue

4. **Reschedule Exercise**
   - Schedule retry after blocking issue resolved
   - Update scenario based on findings
   - Communicate delay to stakeholders

---

## Continuous Improvement

### Scenario Evolution
This scenario should evolve based on:
- Previous exercise findings
- Production incident learnings
- Infrastructure changes
- Team feedback

### Success Metrics Tracking
Track the following metrics across exercises:
- RTO achievement rate
- RPO achievement rate
- Data integrity success rate
- Team coordination effectiveness
- Process improvement completion rate

### Benchmarking
Compare performance against:
- Previous exercise results
- Industry standards for similar systems
- Production incident response times
- SLA targets

---

## Appendix: Quick Reference Commands

### Database Operations
```bash
# Quick database health check
psql $DATABASE_URL -c "SELECT 1"

# Check table counts
psql $DATABASE_URL -c "
  SELECT 
    'Listing' as table_name, COUNT(*) as count FROM \"Listing\"
  UNION ALL
  SELECT 'Auction', COUNT(*) FROM \"Auction\"
  UNION ALL
  SELECT 'MarketplaceEvent', COUNT(*) FROM \"MarketplaceEvent\";
"

# Check sync state
psql $DATABASE_URL -c "SELECT * FROM \"SyncState\""
```

### Indexer Operations
```bash
# Check indexer health
curl http://localhost:4000/health | jq '.'
curl http://localhost:4000/readyz | jq '.'
curl http://localhost:4000/metrics | grep indexer_latest_ledger_processed

# Check sync lag
curl http://localhost:4000/metrics | grep sync_latency_ledgers

# Check for errors
docker compose logs indexer | grep -i error
```

### RPC Operations
```bash
# Test RPC connectivity
stellar rpc --rpc-url $STELLAR_RPC_URL getLatestLedger

# Compare RPC providers
stellar rpc --rpc-url $PRIMARY_RPC getLatestLedger
stellar rpc --rpc-url $BACKUP_RPC getLatestLedger
```

### SSE Operations
```bash
# Test SSE connection
curl -N -H "Accept: text/event-stream" http://localhost:4000/events

# Test with replay
curl -N -H "Accept: text/event-stream" \
  -H "Last-Event-ID: 123" \
  http://localhost:4000/events
```

---

## Related Documentation

- [Incident Runbook](../INCIDENT_RUNBOOK.md)
- [Database Outage Runbook](./database-outage.md)
- [Chain Reorganization Runbook](./reorganization.md)
- [Tabletop Exercises](./tabletop-exercises.md)
- [Financial Reconciliation Runbook](../financial-reconciliation-runbook.md)
- [SSE Protocol Specification](../sse-protocol.md)
- [Retention and Archival Strategy](../retention-archival.md)
- [Backup/Restore Scripts](../../scripts/backup/)

---

**Document Owner:** Incident Commander  
**Last Updated:** 2026-08-25  
**Next Review:** 2026-11-25 (Quarterly)  
**Version:** 1.0