// ─────────────────────────────────────────────────────────────
// lib/notifications/types.ts
// ─────────────────────────────────────────────────────────────

export type NotificationChannel = "whatsapp" | "sms" | "email" | "push";

export type NotificationStatus = "pending" | "sent" | "delivered" | "read" | "failed";

export type ReminderKind =
  | "medication"
  | "appointment"
  | "checkup"
  | "vaccination"
  | "custom";

export interface CareReminder {
  id: string;
  userId: string;
  kind: ReminderKind;
  title: string;
  message: string;
  scheduledAt: string; // ISO-8601
  timezone: string;
  channel: NotificationChannel;
  status: NotificationStatus;
  createdAt: string;
  updatedAt: string;
  readAt?: string;
  deliveredAt?: string;
  failedReason?: string;
}

export interface ScheduleReminderRequest {
  userId: string;
  kind: ReminderKind;
  title: string;
  message: string;
  scheduledAt: string;
  timezone: string;
  channel: NotificationChannel;
}

export interface ReceiptUpdateRequest {
  status: NotificationStatus;
  deliveredAt?: string;
  readAt?: string;
  failedReason?: string;
}

export interface WhatsAppTemplate {
  id: string;
  name: string;
  language: string;
  category: "marketing" | "utility" | "authentication";
  bodyTemplate: string;
  exampleValues: Record<string, string>;
}

export interface TemplatePreviewRequest {
  templateId: string;
  variables: Record<string, string>;
  recipientPhone?: string;
}

export interface TemplatePreviewResponse {
  templateId: string;
  renderedBody: string;
  isValid: boolean;
  missingVariables: string[];
  warnings: string[];
}
