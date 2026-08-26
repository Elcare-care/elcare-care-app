/**
 * moderation-rules.ts
 *
 * Pure business rules shared by moderation-routes.ts. Mirrors the logic in
 * frontend/elcarehub-app/src/lib/moderation.ts (nextStateAfterReport) so the
 * indexer — the source of truth in production — and the frontend fallback
 * agree on when a case escalates. See docs/MODERATION_POLICY.md §2.
 */

import type { ModerationState } from '@prisma/client';

/** How many user reports trigger automatic quarantine. */
export const QUARANTINE_REPORT_THRESHOLD = 3;

/**
 * Determines the next moderation state after a new report is received,
 * based on the current state and cumulative report count.
 */
export function nextModerationStateAfterReport(
  current: ModerationState,
  newReportCount: number
): ModerationState {
  if (current === 'REJECTED') return 'REJECTED';
  if (current === 'QUARANTINED') return 'QUARANTINED';
  if (newReportCount >= QUARANTINE_REPORT_THRESHOLD) return 'QUARANTINED';
  return 'REPORTED';
}
