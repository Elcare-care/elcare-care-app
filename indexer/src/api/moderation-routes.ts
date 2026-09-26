/**
 * moderation-routes.ts
 *
 * Content moderation and report-abuse workflow (Issue #542).
 *
 * Implements the state model documented in docs/MODERATION_POLICY.md as a
 * concrete API + Postgres-backed workflow:
 *
 *   POST /moderation/reports                    — public report submission
 *   GET  /moderation/cases/:cid                  — public-safe case lookup
 *   GET  /moderation/cases                       — operator triage list
 *   GET  /moderation/cases/:cid/full              — operator: reports + decisions + appeals
 *   POST /moderation/cases/:cid/decision          — operator: set state, writes ModerationDecision
 *   POST /moderation/cases/:cid/appeals           — authenticated: uploader files an appeal
 *   POST /moderation/appeals/:id/decision         — operator: resolve an appeal
 *
 * SAFETY INVARIANTS
 * ─────────────────
 *  - Reporter identity (reporterAddress) and report evidence (description) are
 *    NEVER returned from a public route — only /cases/:cid/full (operator-only).
 *  - Moderation never deletes or rewrites a Listing row or its provenance
 *    fields. It is purely an overlay keyed by CID / listingId (see routes.ts
 *    for how listing responses attach `moderationState`).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../db.js';
import type { Prisma } from '@prisma/client';
import { authMiddleware } from './auth-middleware.js';
import { lightRateLimiter, strictRateLimiter, operationalRateLimiter } from './rate-limit-middleware.js';
import { badRequest, notFound, internalError } from './errors.js';
import { QUARANTINE_REPORT_THRESHOLD, nextModerationStateAfterReport } from './moderation-rules.js';

const router = Router();

// ── Serialise helper (consistent with routes.ts) ──────────────────────────────

const serialize = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val)));

const DESCRIPTION_MAX_LEN = 1000;
const STATEMENT_MAX_LEN = 2000;
const REASON_MAX_LEN = 1000;

// ── Public-safe projections ────────────────────────────────────────────────────
//
// Strips reporter identity, report evidence, and internal reason/reviewer
// fields from a ModerationCase before it is ever sent to a non-operator caller.

function toPublicCase(row: {
  cid: string;
  kind: string;
  state: string;
  reportCount: number;
  listingId: bigint | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    cid: row.cid,
    kind: row.kind,
    state: row.state,
    reportCount: row.reportCount,
    listingId: row.listingId !== null ? row.listingId.toString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    policyUrl: '/docs/MODERATION_POLICY.md',
  };
}

// ── Zod request schemas ────────────────────────────────────────────────────────

const reportBodySchema = z.object({
  cid: z.string().trim().min(1).max(500),
  kind: z.enum(['IMAGE', 'METADATA']),
  category: z.enum([
    'PROHIBITED_CONTENT',
    'INTELLECTUAL_PROPERTY',
    'MISLEADING_METADATA',
    'SPAM',
    'MALWARE_SUSPECTED',
    'OTHER',
  ]),
  description: z.string().max(DESCRIPTION_MAX_LEN).optional(),
  reporterAddress: z.string().trim().min(1).max(64).optional(),
});

const decisionBodySchema = z.object({
  state: z.enum(['APPROVED', 'QUARANTINED', 'REJECTED']),
  actor: z.string().trim().min(1).max(64),
  reason: z.string().max(REASON_MAX_LEN).optional(),
});

const appealBodySchema = z.object({
  appellantAddress: z.string().trim().min(1).max(64),
  statement: z.string().trim().min(1).max(STATEMENT_MAX_LEN),
});

const appealDecisionBodySchema = z.object({
  status: z.enum(['UPHELD', 'OVERTURNED']),
  decidedBy: z.string().trim().min(1).max(64),
  decisionReason: z.string().max(REASON_MAX_LEN).optional(),
  /** State to reinstate the case to when overturning (defaults to APPROVED). */
  reinstateState: z.enum(['APPROVED', 'REPORTED']).optional(),
});

const casesQuerySchema = z.object({
  state: z.enum(['PENDING', 'APPROVED', 'REPORTED', 'QUARANTINED', 'REJECTED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

// ── POST /moderation/reports ────────────────────────────────────────────────────
//
// Public submission. Creates the ModerationCase on first report if it doesn't
// exist yet (a report can arrive before an explicit "registerUpload" call).
// Deduplicates by (cid, reporterAddress) — a second report from the same
// wallet against the same CID is accepted idempotently without double-counting.
// Never echoes reporterAddress back in the response.

router.post('/moderation/reports', strictRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  const parsed = reportBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return next(badRequest('Invalid report payload', parsed.error.flatten()));
  }
  const { cid, kind, category, description, reporterAddress } = parsed.data;

  try {
    const result = await prisma.$transaction(async (tx) => {
      let moderationCase = await tx.moderationCase.findUnique({ where: { cid } });
      if (!moderationCase) {
        moderationCase = await tx.moderationCase.create({
          data: { cid, kind, state: 'PENDING', reportCount: 0 },
        });
      }

      // Dedupe: a NULL reporterAddress (anonymous) is never deduped by Postgres
      // uniqueness semantics, so only check explicitly when an address is given.
      if (reporterAddress) {
        const existing = await tx.moderationReport.findUnique({
          where: { cid_reporterAddress: { cid, reporterAddress } },
        });
        if (existing) {
          // Duplicate report from the same reporter — return current state,
          // do not increment the count again.
          return moderationCase;
        }
      }

      await tx.moderationReport.create({
        data: { caseId: moderationCase.id, cid, category, description, reporterAddress },
      });

      const newReportCount = moderationCase.reportCount + 1;
      const nextState = nextModerationStateAfterReport(moderationCase.state, newReportCount);

      const updated = await tx.moderationCase.update({
        where: { id: moderationCase.id },
        data: {
          reportCount: newReportCount,
          ...(nextState !== moderationCase.state
            ? { state: nextState, reviewedBy: 'system', updatedAt: new Date() }
            : {}),
        },
      });

      if (nextState !== moderationCase.state) {
        await tx.moderationDecision.create({
          data: {
            caseId: moderationCase.id,
            previousState: moderationCase.state,
            newState: nextState,
            actor: 'system',
            reason: `Auto-transition: ${newReportCount} report(s) received (threshold ${QUARANTINE_REPORT_THRESHOLD})`,
          },
        });
      }

      return updated;
    });

    return res.status(201).json(serialize(toPublicCase(result)));
  } catch (err) {
    next(internalError('Failed to submit report'));
  }
});

// ── GET /moderation/cases/:cid ─────────────────────────────────────────────────
//
// Public-safe single case lookup — state + report count only. No reporter
// identities, no evidence text, no internal reason.

router.get('/moderation/cases/:cid', lightRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  const cid = req.params.cid as string;
  try {
    const moderationCase = await prisma.moderationCase.findUnique({ where: { cid } });
    if (!moderationCase) return next(notFound('No moderation case found for this CID'));
    return res.json(serialize(toPublicCase(moderationCase)));
  } catch (err) {
    next(internalError('Failed to fetch moderation case'));
  }
});

// ── GET /moderation/cases ──────────────────────────────────────────────────────
//
// Operator-only triage list. Filter by state, paginated.

router.get('/moderation/cases', operationalRateLimiter, authMiddleware('operator'), async (req: Request, res: Response, next: NextFunction) => {
  const parsed = casesQuerySchema.safeParse(req.query);
  if (!parsed.success) return next(badRequest('Invalid query parameters', parsed.error.flatten()));
  const { state, limit, offset } = parsed.data;

  try {
    const where = state ? { state } : {};
    const [cases, total] = await Promise.all([
      prisma.moderationCase.findMany({
        where,
        orderBy: [{ state: 'asc' }, { updatedAt: 'desc' }],
        take: limit,
        skip: offset,
      }),
      prisma.moderationCase.count({ where }),
    ]);

    res.setHeader('X-Total-Count', String(total));
    return res.json(serialize({ cases, total, limit, offset }));
  } catch (err) {
    next(internalError('Failed to fetch moderation cases'));
  }
});

// ── GET /moderation/cases/:cid/full ────────────────────────────────────────────
//
// Operator-only full case view: reports (with evidence + reporter address),
// decisions, and appeals. This is the only route that ever surfaces reporter
// identity or report descriptions.

router.get('/moderation/cases/:cid/full', operationalRateLimiter, authMiddleware('operator'), async (req: Request, res: Response, next: NextFunction) => {
  const cid = req.params.cid as string;
  try {
    const moderationCase = await prisma.moderationCase.findUnique({
      where: { cid },
      include: {
        reports: { orderBy: { createdAt: 'desc' } },
        decisions: { orderBy: { createdAt: 'desc' } },
        appeals: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!moderationCase) return next(notFound('No moderation case found for this CID'));
    return res.json(serialize(moderationCase));
  } catch (err) {
    next(internalError('Failed to fetch moderation case detail'));
  }
});

// ── POST /moderation/cases/:cid/decision ───────────────────────────────────────
//
// Operator-only. Sets a new state (APPROVED / QUARANTINED / REJECTED), writes
// a ModerationDecision audit record. `reason` is internal-only and is never
// surfaced through a public route.

router.post('/moderation/cases/:cid/decision', operationalRateLimiter, authMiddleware('operator'), async (req: Request, res: Response, next: NextFunction) => {
  const cid = req.params.cid as string;
  const parsed = decisionBodySchema.safeParse(req.body);
  if (!parsed.success) return next(badRequest('Invalid decision payload', parsed.error.flatten()));
  const { state, actor, reason } = parsed.data;

  try {
    const moderationCase = await prisma.moderationCase.findUnique({ where: { cid } });
    if (!moderationCase) return next(notFound('No moderation case found for this CID'));

    const [updated] = await prisma.$transaction([
      prisma.moderationCase.update({
        where: { id: moderationCase.id },
        data: { state, reviewedBy: actor, reason },
      }),
      prisma.moderationDecision.create({
        data: {
          caseId: moderationCase.id,
          previousState: moderationCase.state,
          newState: state,
          actor,
          reason,
        },
      }),
    ]);

    return res.json(serialize(updated));
  } catch (err) {
    next(internalError('Failed to record moderation decision'));
  }
});

// ── POST /moderation/cases/:cid/appeals ────────────────────────────────────────
//
// Authenticated: the uploader/creator appeals a QUARANTINED or REJECTED case.

router.post('/moderation/cases/:cid/appeals', lightRateLimiter, authMiddleware('authenticated'), async (req: Request, res: Response, next: NextFunction) => {
  const cid = req.params.cid as string;
  const parsed = appealBodySchema.safeParse(req.body);
  if (!parsed.success) return next(badRequest('Invalid appeal payload', parsed.error.flatten()));
  const { appellantAddress, statement } = parsed.data;

  try {
    const moderationCase = await prisma.moderationCase.findUnique({ where: { cid } });
    if (!moderationCase) return next(notFound('No moderation case found for this CID'));

    if (moderationCase.state !== 'QUARANTINED' && moderationCase.state !== 'REJECTED') {
      return next(badRequest('Appeals can only be filed against a QUARANTINED or REJECTED case'));
    }

    const appeal = await prisma.moderationAppeal.create({
      data: { caseId: moderationCase.id, appellantAddress, statement, status: 'PENDING' },
    });

    return res.status(201).json(serialize(appeal));
  } catch (err) {
    next(internalError('Failed to submit appeal'));
  }
});

// ── POST /moderation/appeals/:id/decision ──────────────────────────────────────
//
// Operator-only. Resolves an appeal:
//   UPHELD     — the original decision stands; case state is untouched.
//   OVERTURNED — reinstates the case to `reinstateState` (default APPROVED)
//                and writes a ModerationDecision recording the reversal.

router.post('/moderation/appeals/:id/decision', operationalRateLimiter, authMiddleware('operator'), async (req: Request, res: Response, next: NextFunction) => {
  const appealId = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(appealId)) return next(badRequest('Invalid appeal id'));

  const parsed = appealDecisionBodySchema.safeParse(req.body);
  if (!parsed.success) return next(badRequest('Invalid appeal decision payload', parsed.error.flatten()));
  const { status, decidedBy, decisionReason, reinstateState } = parsed.data;

  try {
    const appeal = await prisma.moderationAppeal.findUnique({ where: { id: appealId } });
    if (!appeal) return next(notFound('Appeal not found'));

    const moderationCase = await prisma.moderationCase.findUnique({ where: { id: appeal.caseId } });
    if (!moderationCase) return next(notFound('Associated moderation case not found'));

    const ops: Prisma.PrismaPromise<unknown>[] = [
      prisma.moderationAppeal.update({
        where: { id: appealId },
        data: { status, decidedBy, decisionReason, decidedAt: new Date() },
      }),
    ];

    if (status === 'OVERTURNED') {
      const newState = reinstateState ?? 'APPROVED';
      ops.push(
        prisma.moderationCase.update({
          where: { id: moderationCase.id },
          data: { state: newState, reviewedBy: decidedBy, reason: decisionReason },
        })
      );
      ops.push(
        prisma.moderationDecision.create({
          data: {
            caseId: moderationCase.id,
            previousState: moderationCase.state,
            newState,
            actor: decidedBy,
            reason: `Appeal #${appealId} overturned: ${decisionReason ?? ''}`.trim(),
          },
        })
      );
    }

    const [updatedAppeal] = await prisma.$transaction(ops);
    return res.json(serialize(updatedAppeal));
  } catch (err) {
    next(internalError('Failed to record appeal decision'));
  }
});

export default router;
