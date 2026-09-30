/**
 * notification/index.ts — public surface for the notification subsystem.
 *
 * Re-exports the event priority model and notification builder so
 * routes.ts and tests can import from a single path.
 */

export { classifyEvent, isWalletInvolved, EVENT_CLASSIFICATIONS } from './event-priority.js';
export type { EventClassification, EventPriority, EventDomain } from './event-priority.js';
export { buildNotification, buildSummary } from './notification-model.js';
export type { IndexerNotification } from './notification-model.js';
