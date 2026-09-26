/**
 * audit-routes.ts
 *
 * Admin API routes for querying and exporting operational audit records.
 * Requires operator authentication.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../db.js';
import { authMiddleware } from './auth-middleware.js';
import { getAuditService, AuditActionType } from '../audit/audit-service.js';
import { badRequest, forbidden } from './errors.js';

const router = Router();

// Query schema for audit log search
const auditQuerySchema = z.object({
  actor: z.string().optional(),
  actionType: z.enum([
    'AdminRoleChange',
    'RecoveryOperation',
    'CacheInvalidation',
    'ReplayJob',
    'ContractUpgrade',
    'EmergencyPause',
    'DataCorrection',
    'BackfillJob',
    'GapRepair',
    'DeadLetterReplay',
  ]).optional(),
  requestId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  limit: z.coerce.number().min(1).max(1000).default(100),
  offset: z.coerce.number().min(0).default(0),
  export: z.enum(['csv']).optional(),
});

// ── GET /admin/audit ─────────────────────────────────────────────────────────────
// Query audit records with filters and pagination
router.get('/admin/audit', authMiddleware('operator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validated = auditQuerySchema.safeParse(req.query);
    if (!validated.success) {
      return next(badRequest('Invalid query parameters'));
    }

    const { actor, actionType, requestId, startDate, endDate, limit, offset, export: exportFormat } = validated.data;

    const auditService = getAuditService(prisma);

    // Handle CSV export
    if (exportFormat === 'csv') {
      const csv = await auditService.exportToCsv({
        actor,
        actionType: actionType as AuditActionType,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="audit-export-${Date.now()}.csv"`);
      return res.send(csv);
    }

    // Handle JSON query
    const { records, total } = await auditService.query({
      actor,
      actionType: actionType as AuditActionType,
      requestId,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      limit,
      offset,
    });

    res.json({
      records,
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    });
  } catch (err) {
    next(badRequest('Failed to query audit records'));
  }
});

// ── GET /admin/audit/:requestId ───────────────────────────────────────────────────
// Get a single audit record by request ID
router.get('/admin/audit/:requestId', authMiddleware('operator'), async (req: Request, res: Response, next: NextFunction) => {
  const { requestId } = req.params;
  try {
    const record = await prisma.operationalAudit.findUnique({
      where: { requestId },
    });

    if (!record) {
      return next(badRequest('Audit record not found'));
    }

    res.json(record);
  } catch (err) {
    next(badRequest('Failed to fetch audit record'));
  }
});

// ── GET /admin/audit/stats ────────────────────────────────────────────────────────
// Get audit statistics (counts by action type, recent activity)
router.get('/admin/audit/stats', authMiddleware('operator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [actionCounts, recentActivity, totalRecords] = await Promise.all([
      prisma.operationalAudit.groupBy({
        by: ['actionType'],
        _count: true,
        orderBy: { _count: { actionType: 'desc' } },
      }),
      prisma.operationalAudit.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          actor: true,
          actionType: true,
          target: true,
          requestId: true,
          outcome: true,
          createdAt: true,
        },
      }),
      prisma.operationalAudit.count(),
    ]);

    res.json({
      actionCounts: actionCounts.map(c => ({
        actionType: c.actionType,
        count: c._count,
      })),
      recentActivity,
      totalRecords,
    });
  } catch (err) {
    next(badRequest('Failed to fetch audit statistics'));
  }
});

export default router;
