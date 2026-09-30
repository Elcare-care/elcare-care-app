// ─────────────────────────────────────────────────────────────
// lib/notifications/cron-scheduler.ts
// ─────────────────────────────────────────────────────────────
//
// Lightweight in-process cron scheduler for care reminders.
// In production this would be replaced by a proper job queue
// (e.g. BullMQ, Agenda, or a managed cron service), but for the
// feature branch we keep it dependency-free and deterministic.
//
// The scheduler ticks every 30 seconds and evaluates due reminders.

import type { CareReminder } from "./types";
import { listAllReminders, markReminderSent, markReminderFailed } from "./store";

type JobHandler = (reminder: CareReminder) => Promise<void>;

const TICK_MS = 30_000;
const handlers: JobHandler[] = [];
let timer: NodeJS.Timeout | null = null;
let running = false;

export function registerCronHandler(handler: JobHandler): void {
  handlers.push(handler);
}

export function startCronScheduler(): void {
  if (timer) return;
  running = false;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runDueJobs();
    } finally {
      running = false;
    }
  }, TICK_MS);
}

export function stopCronScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function runDueJobs(): Promise<void> {
  const now = new Date();
  const due = listAllReminders().filter((r) => {
    if (r.status !== "pending") return false;
    const scheduled = new Date(r.scheduledAt);
    return scheduled <= now;
  });

  for (const reminder of due) {
    for (const handler of handlers) {
      try {
        await handler(reminder);
        await markReminderSent(reminder.id);
        break; // stop after first successful handler
      } catch {
        // try next handler; if none succeed, mark failed
      }
    }
    const updated = listAllReminders().find((r) => r.id === reminder.id);
    if (updated && updated.status === "pending") {
      await markReminderFailed(reminder.id, "All handlers failed");
    }
  }
}

// Admin helpers

export function getCronStatus() {
  return {
    running: timer !== null,
    tickIntervalMs: TICK_MS,
    pendingReminders: listAllReminders().filter((r) => r.status === "pending").length,
    totalReminders: listAllReminders().length,
  };
}
