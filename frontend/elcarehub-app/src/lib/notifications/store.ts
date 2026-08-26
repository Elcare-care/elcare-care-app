// ─────────────────────────────────────────────────────────────
// lib/notifications/store.ts
// ─────────────────────────────────────────────────────────────

import type { CareReminder, ScheduleReminderRequest, ReceiptUpdateRequest, NotificationStatus } from "./types";

// In-memory store for reminders. In production this would be backed by
// PostgreSQL or Redis, but for the feature branch we keep it in-process
// so the scheduler and API routes can share state without extra deps.
const reminders = new Map<string, CareReminder>();
const userIndex = new Map<string, Set<string>>();

export function insertReminder(input: ScheduleReminderRequest): CareReminder {
  const now = new Date().toISOString();
  const reminder: CareReminder = {
    id: `rem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    userId: input.userId,
    kind: input.kind,
    title: input.title,
    message: input.message,
    scheduledAt: input.scheduledAt,
    timezone: input.timezone,
    channel: input.channel,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  reminders.set(reminder.id, reminder);
  const bucket = userIndex.get(input.userId) ?? new Set<string>();
  bucket.add(reminder.id);
  userIndex.set(input.userId, bucket);

  return reminder;
}

export function getReminder(id: string): CareReminder | undefined {
  return reminders.get(id);
}

export function getRemindersForUser(userId: string): CareReminder[] {
  const ids = userIndex.get(userId);
  if (!ids) return [];
  return Array.from(ids)
    .map((id) => reminders.get(id))
    .filter((r): r is CareReminder => Boolean(r));
}

export function updateReminderReceipt(id: string, update: ReceiptUpdateRequest): CareReminder | undefined {
  const existing = reminders.get(id);
  if (!existing) return undefined;

  const next: CareReminder = {
    ...existing,
    status: update.status,
    updatedAt: new Date().toISOString(),
  };

  if (update.deliveredAt) next.deliveredAt = update.deliveredAt;
  if (update.readAt) next.readAt = update.readAt;
  if (update.failedReason) next.failedReason = update.failedReason;

  reminders.set(id, next);
  return next;
}

export function markReminderSent(id: string): CareReminder | undefined {
  return updateReminderReceipt(id, { status: "sent" });
}

export function markReminderDelivered(id: string, at?: string): CareReminder | undefined {
  return updateReminderReceipt(id, {
    status: "delivered",
    deliveredAt: at ?? new Date().toISOString(),
  });
}

export function markReminderRead(id: string, at?: string): CareReminder | undefined {
  return updateReminderReceipt(id, {
    status: "read",
    readAt: at ?? new Date().toISOString(),
  });
}

export function markReminderFailed(id: string, reason: string): CareReminder | undefined {
  return updateReminderReceipt(id, {
    status: "failed",
    failedReason: reason,
  });
}

export function listAllReminders(): CareReminder[] {
  return Array.from(reminders.values());
}
