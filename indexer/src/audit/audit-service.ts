/**
 * audit-service.ts
 *
 * Operational audit service for tracking high-risk administrative actions.
 * Provides redaction logic for sensitive data and append-only audit logging.
 */

import { PrismaClient, AuditActionType, AuditOutcome } from '@prisma/client';
import { randomUUID } from 'crypto';

// Re-export types for use in other modules
export type { AuditActionType, AuditOutcome };

export interface AuditContext {
  [key: string]: unknown;
}

export interface AuditOptions {
  actor: string;
  actionType: AuditActionType;
  target?: string;
  requestId?: string;
  outcome: AuditOutcome;
  context: AuditContext;
  ipAddress?: string;
  userAgent?: string;
}

// Fields that should always be redacted from audit context
const SENSITIVE_FIELDS = [
  'secret',
  'password',
  'token',
  'apiKey',
  'privateKey',
  'seed',
  'mnemonic',
  'authToken',
  'sessionToken',
  'cookie',
  'authorization',
  'x-api-key',
  'database_url',
  'redis_url',
  'jwt',
  'signature',
];

// Patterns for detecting sensitive values
const SENSITIVE_PATTERNS = [
  /^S[A-Z0-9]{50,}$/, // Stellar secret keys
  /^sk-[a-zA-Z0-9]{48,}$/, // Stripe secret keys
  /^[a-f0-9]{32}:[a-f0-9]{32}$/, // API keys with separator
  /^[a-zA-Z0-9_-]{20,}$/, // Generic long alphanumeric strings
];

/**
 * Redact sensitive data from audit context
 */
function redactContext(context: AuditContext): AuditContext {
  const redacted: AuditContext = {};

  for (const [key, value] of Object.entries(context)) {
    const lowerKey = key.toLowerCase();
    
    // Check if field name indicates sensitive data
    if (SENSITIVE_FIELDS.some(field => lowerKey.includes(field))) {
      redacted[key] = '[REDACTED]';
      continue;
    }

    // Check if value matches sensitive patterns
    if (typeof value === 'string') {
      if (SENSITIVE_PATTERNS.some(pattern => pattern.test(value))) {
        redacted[key] = '[REDACTED]';
        continue;
      }
      
      // Redact values that look like secrets (long alphanumeric strings)
      if (value.length > 30 && /^[a-zA-Z0-9_-]+$/.test(value)) {
        redacted[key] = `[REDACTED_LENGTH_${value.length}]`;
        continue;
      }
    }

    // Recursively redact nested objects
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      redacted[key] = redactContext(value as AuditContext);
      continue;
    }

    // Keep non-sensitive values as-is
    redacted[key] = value;
  }

  return redacted;
}

/**
 * Audit service class
 */
export class AuditService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Log an audit record
   */
  async log(options: AuditOptions): Promise<void> {
    const requestId = options.requestId || randomUUID();
    const redactedContext = redactContext(options.context);

    await this.prisma.operationalAudit.create({
      data: {
        actor: options.actor,
        actionType: options.actionType,
        target: options.target,
        requestId,
        outcome: options.outcome,
        redactedContext,
        ipAddress: options.ipAddress,
        userAgent: options.userAgent,
      },
    });
  }

  /**
   * Log an audit record within a transaction
   */
  async logInTransaction(
    tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use'>,
    options: AuditOptions
  ): Promise<void> {
    const requestId = options.requestId || randomUUID();
    const redactedContext = redactContext(options.context);

    await tx.operationalAudit.create({
      data: {
        actor: options.actor,
        actionType: options.actionType,
        target: options.target,
        requestId,
        outcome: options.outcome,
        redactedContext,
        ipAddress: options.ipAddress,
        userAgent: options.userAgent,
      },
    });
  }

  /**
   * Query audit records with filters
   */
  async query(filters: {
    actor?: string;
    actionType?: AuditActionType;
    requestId?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }) {
    const where: Record<string, unknown> = {};

    if (filters.actor) {
      where.actor = filters.actor;
    }

    if (filters.actionType) {
      where.actionType = filters.actionType;
    }

    if (filters.requestId) {
      where.requestId = filters.requestId;
    }

    if (filters.startDate || filters.endDate) {
      where.createdAt = {};
      if (filters.startDate) {
        (where.createdAt as Record<string, Date>).gte = filters.startDate;
      }
      if (filters.endDate) {
        (where.createdAt as Record<string, Date>).lte = filters.endDate;
      }
    }

    const [records, total] = await Promise.all([
      this.prisma.operationalAudit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: filters.limit || 100,
        skip: filters.offset || 0,
      }),
      this.prisma.operationalAudit.count({ where }),
    ]);

    return { records, total };
  }

  /**
   * Export audit records as CSV
   */
  async exportToCsv(filters: {
    actor?: string;
    actionType?: AuditActionType;
    startDate?: Date;
    endDate?: Date;
  }): Promise<string> {
    const { records } = await this.query({
      ...filters,
      limit: 10000, // Max export limit
    });

    const headers = ['id', 'actor', 'actionType', 'target', 'requestId', 'outcome', 'redactedContext', 'ipAddress', 'userAgent', 'createdAt'];
    const rows = records.map(record => [
      record.id,
      record.actor,
      record.actionType,
      record.target || '',
      record.requestId,
      record.outcome,
      JSON.stringify(record.redactedContext),
      record.ipAddress || '',
      record.userAgent || '',
      record.createdAt.toISOString(),
    ]);

    return [headers.join(','), ...rows.map(row => row.map(cell => `"${cell}"`).join(','))].join('\n');
  }

  /**
   * Delete audit records older than retention period
   * This should only be called by a scheduled job, not by application code
   */
  async deleteOldRecords(retentionDays: number): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const result = await this.prisma.operationalAudit.deleteMany({
      where: {
        createdAt: {
          lt: cutoffDate,
        },
      },
    });

    return result.count;
  }
}

/**
 * Create a singleton audit service instance
 */
let auditServiceInstance: AuditService | null = null;

export function getAuditService(prisma: PrismaClient): AuditService {
  if (!auditServiceInstance) {
    auditServiceInstance = new AuditService(prisma);
  }
  return auditServiceInstance;
}
