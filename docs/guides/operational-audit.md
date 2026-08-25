# Operational Audit Trail

This guide describes the operational audit trail system for tracking high-risk administrative actions in the ELCARE-HUB indexer.

## Overview

The operational audit trail provides a durable, append-only log of all high-risk administrative actions. This ensures that operators can investigate incidents, track who performed what actions, and maintain compliance with security requirements.

### Key Features

- **Append-only**: Records cannot be edited or deleted through the application
- **Redaction**: Sensitive data (passwords, tokens, keys) is automatically redacted before storage
- **Searchable**: Indexed by actor, action type, and timestamp for efficient queries
- **Exportable**: Supports CSV export for external analysis
- **Retention**: Configurable retention period for automatic cleanup

## Audit Model

### OperationalAudit Table

| Field | Type | Description |
|-------|------|-------------|
| id | Integer | Primary key (auto-increment) |
| actor | String | Wallet address or operator identifier |
| actionType | AuditActionType | Type of action performed |
| target | String? | Resource identifier (e.g., listing_id, contract_id) |
| requestId | String | Unique request ID for tracing |
| outcome | AuditOutcome | Success, Failure, or Partial |
| redactedContext | JSON | Action context with sensitive data redacted |
| ipAddress | String? | Client IP address |
| userAgent | String? | Client user agent |
| createdAt | DateTime | Timestamp when the action was logged |

### Action Types

- `AdminRoleChange` - Administrator role modifications
- `RecoveryOperation` - Data recovery procedures
- `CacheInvalidation` - Cache clearing operations
- `ReplayJob` - Event replay operations
- `ContractUpgrade` - Smart contract upgrades
- `EmergencyPause` - Emergency system pauses
- `DataCorrection` - Manual data corrections
- `BackfillJob` - Historical data backfill operations
- `GapRepair` - Ledger gap repair operations
- `DeadLetterReplay` - Failed event replay operations

### Outcomes

- `Success` - Action completed successfully
- `Failure` - Action failed completely
- `Partial` - Action partially succeeded

## Redaction Rules

Sensitive data is automatically redacted before being stored in the audit log. The following patterns are detected and redacted:

### Field Names

Any field containing these keywords is redacted:
- `secret`
- `password`
- `token`
- `apiKey`
- `privateKey`
- `seed`
- `mnemonic`
- `authToken`
- `sessionToken`
- `cookie`
- `authorization`
- `x-api-key`
- `database_url`
- `redis_url`
- `jwt`
- `signature`

### Value Patterns

Values matching these patterns are redacted:
- Stellar secret keys (`S[A-Z0-9]{50,}`)
- Stripe secret keys (`sk-[a-zA-Z0-9]{48,}`)
- API keys with separators (`[a-f0-9]{32}:[a-f0-9]{32}`)
- Long alphanumeric strings (>30 chars)

### Example

```typescript
// Input context
{
  username: 'admin',
  password: 'secret123',
  apiKey: 'abc123def456',
  action: 'role_change'
}

// Redacted context stored in audit log
{
  username: 'admin',
  password: '[REDACTED]',
  apiKey: '[REDACTED]',
  action: 'role_change'
}
```

## API Endpoints

### GET /admin/audit

Query audit records with filters and pagination.

**Authentication**: Requires operator token

**Query Parameters**:
- `actor` (optional): Filter by actor
- `actionType` (optional): Filter by action type
- `requestId` (optional): Filter by request ID
- `startDate` (optional): Filter by start date (ISO 8601)
- `endDate` (optional): Filter by end date (ISO 8601)
- `limit` (optional): Number of records to return (default: 100, max: 1000)
- `offset` (optional): Number of records to skip (default: 0)
- `export` (optional): Set to `csv` to export as CSV

**Response** (JSON):
```json
{
  "records": [
    {
      "id": 1,
      "actor": "192.168.1.1",
      "actionType": "AdminRoleChange",
      "target": "/admin/contracts",
      "requestId": "uuid-123",
      "outcome": "Success",
      "redactedContext": { "reason": "token_valid" },
      "ipAddress": "192.168.1.1",
      "userAgent": "Mozilla/5.0...",
      "createdAt": "2024-01-01T00:00:00Z"
    }
  ],
  "total": 100,
  "limit": 100,
  "offset": 0,
  "hasMore": true
}
```

**Response** (CSV when `export=csv`):
```csv
id,actor,actionType,target,requestId,outcome,redactedContext,ipAddress,userAgent,createdAt
"1","192.168.1.1","AdminRoleChange","/admin/contracts","uuid-123","Success","{\"reason\":\"token_valid\"}","192.168.1.1","Mozilla/5.0...","2024-01-01T00:00:00Z"
```

### GET /admin/audit/:requestId

Get a single audit record by request ID.

**Authentication**: Requires operator token

**Response**:
```json
{
  "id": 1,
  "actor": "192.168.1.1",
  "actionType": "AdminRoleChange",
  "target": "/admin/contracts",
  "requestId": "uuid-123",
  "outcome": "Success",
  "redactedContext": { "reason": "token_valid" },
  "ipAddress": "192.168.1.1",
  "userAgent": "Mozilla/5.0...",
  "createdAt": "2024-01-01T00:00:00Z"
}
```

### GET /admin/audit/stats

Get audit statistics.

**Authentication**: Requires operator token

**Response**:
```json
{
  "actionCounts": [
    { "actionType": "AdminRoleChange", "count": 50 },
    { "actionType": "RecoveryOperation", "count": 10 }
  ],
  "recentActivity": [
    {
      "id": 100,
      "actor": "192.168.1.1",
      "actionType": "AdminRoleChange",
      "target": "/admin/contracts",
      "requestId": "uuid-456",
      "outcome": "Success",
      "createdAt": "2024-01-01T12:00:00Z"
    }
  ],
  "totalRecords": 1000
}
```

## Using the Audit Service

### Logging an Audit Record

```typescript
import { getAuditService, AuditActionType, AuditOutcome } from './audit/audit-service.js';

const auditService = getAuditService(prisma);

await auditService.log({
  actor: '192.168.1.1',
  actionType: AuditActionType.AdminRoleChange,
  target: '/admin/contracts',
  requestId: 'unique-request-id',
  outcome: AuditOutcome.Success,
  context: {
    reason: 'token_valid',
    method: 'GET',
  },
  ipAddress: '192.168.1.1',
  userAgent: 'Mozilla/5.0...',
});
```

### Logging Within a Transaction

```typescript
await prisma.$transaction(async (tx) => {
  // Perform domain changes
  await tx.listing.update({ ... });

  // Log audit record in the same transaction
  await auditService.logInTransaction(tx, {
    actor: 'admin',
    actionType: AuditActionType.DataCorrection,
    target: listingId,
    outcome: AuditOutcome.Success,
    context: { field: 'price', oldValue: '100', newValue: '200' },
  });
});
```

### Querying Audit Records

```typescript
const { records, total } = await auditService.query({
  actor: '192.168.1.1',
  actionType: AuditActionType.AdminRoleChange,
  startDate: new Date('2024-01-01'),
  endDate: new Date('2024-12-31'),
  limit: 100,
  offset: 0,
});
```

### Exporting to CSV

```typescript
const csv = await auditService.exportToCsv({
  actionType: AuditActionType.RecoveryOperation,
  startDate: new Date('2024-01-01'),
  endDate: new Date('2024-12-31'),
});

// Save to file or send as response
res.setHeader('Content-Type', 'text/csv');
res.setHeader('Content-Disposition', 'attachment; filename="audit-export.csv"');
res.send(csv);
```

## Retention Policy

Audit records should be retained according to your organization's compliance requirements. A scheduled job can delete old records:

```typescript
const auditService = getAuditService(prisma);

// Delete records older than 90 days
const deletedCount = await auditService.deleteOldRecords(90);
console.log(`Deleted ${deletedCount} old audit records`);
```

**Note**: This operation should only be performed by a scheduled job with appropriate authorization, not by application code.

## Security Considerations

### Tamper Prevention

- **No update/delete methods**: The audit service does not provide methods to update or delete audit records through the application
- **Database-level protection**: Consider adding database triggers to prevent direct updates/deletes to the `OperationalAudit` table
- **Append-only design**: Records are only created, never modified

### Access Control

- **Operator-only access**: All audit endpoints require operator authentication
- **IP allowlist**: Consider restricting audit endpoint access to specific IP addresses
- **Audit the auditors**: Access to audit endpoints is itself logged in the audit trail

### Sensitive Data

- **Automatic redaction**: Sensitive data is redacted before storage
- **No raw secrets**: Never log raw secrets, passwords, or tokens
- **Context scrubbing**: Review all context objects to ensure no sensitive data is included

## Testing

Run the audit service tests:

```bash
cd indexer
npm test -- audit.test.ts
```

Tests cover:
- Redaction logic for sensitive fields and patterns
- Audit record creation with redacted context
- Query functionality with filters
- CSV export
- Retention policy enforcement

## Troubleshooting

### Audit records not appearing

1. Check that the Prisma client is initialized with `setPrismaClient(prisma)` in `index.ts`
2. Verify the audit service is being called in the correct location
3. Check logs for audit logging errors

### Sensitive data appearing in logs

1. Verify the redaction patterns cover your sensitive field names
2. Check that context objects don't contain sensitive data in unexpected fields
3. Review the redaction logic in `audit-service.ts`

### Export failing

1. Verify the query parameters are valid
2. Check that the export limit (10,000 records) is not exceeded
3. Ensure the user has operator authentication

## References

- [Audit Service Source](../../indexer/src/audit/audit-service.ts)
- [Audit Routes](../../indexer/src/api/audit-routes.ts)
- [Auth Middleware](../../indexer/src/api/auth-middleware.ts)
- [Database Schema](../../indexer/prisma/schema.prisma)
