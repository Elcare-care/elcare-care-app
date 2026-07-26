// ─────────────────────────────────────────────────────────────
// lib/moderation.ts
//
// Issue #308 / #43 — Moderation state model and helpers
//
// MODERATION STATES
// ─────────────────
// Every uploaded asset (image CID or metadata CID) carries a
// moderation state that progresses through this lifecycle:
//
//   PENDING ──► APPROVED
//       │
//       └─────► QUARANTINED ──► REJECTED
//                    │
//                    └──────────► APPROVED  (false-positive review)
//
//   REPORTED ──► (escalates to QUARANTINED on threshold)
//
// • PENDING     — default after upload; scanning in progress or awaiting review
// • APPROVED    — content passed automated + optional manual review
// • QUARANTINED — held for manual review; hidden from all public UI paths
// • REJECTED    — permanently blocked; cannot be minted or promoted
// • REPORTED    — user-submitted flag; still visible but under review
//
// IMMUTABILITY CAVEAT
// ───────────────────
// IPFS content is content-addressed and replicated globally.
// Quarantine/rejection only removes content from ElcareHub UI
// and prevents contract interactions — it does NOT delete IPFS pins
// from every public gateway. See docs/MODERATION_POLICY.md for the
// full takedown policy and its operational limitations.
// ─────────────────────────────────────────────────────────────

// ── State enum ────────────────────────────────────────────────

export type ModerationState =
  | "PENDING"
  | "APPROVED"
  | "QUARANTINED"
  | "REJECTED"
  | "REPORTED";

// ── Asset types covered by moderation ─────────────────────────

export type ModerationAssetKind = "IMAGE" | "METADATA";

// ── Report categories ─────────────────────────────────────────

export type ReportCategory =
  | "PROHIBITED_CONTENT"
  | "INTELLECTUAL_PROPERTY"
  | "MISLEADING_METADATA"
  | "SPAM"
  | "MALWARE_SUSPECTED"
  | "OTHER";

// ── Core moderation record ────────────────────────────────────

/**
 * A moderation record persisted per CID.
 * In production this would live in the indexer DB (Prisma model `ModerationRecord`).
 * During the current phase it is stored in the Next.js server's in-memory map
 * and in the indexer via the /moderation API (see indexer/src/api/routes.ts).
 */
export interface ModerationRecord {
  /** IPFS CID of the asset */
  cid: string;
  kind: ModerationAssetKind;
  state: ModerationState;
  /** ISO-8601 timestamp of the last state transition */
  updatedAt: string;
  /** Wallet address of the uploader */
  uploaderAddress?: string;
  /** Actor who set the current state (wallet address or "system") */
  reviewedBy?: string;
  /** Free-text reason for the current state (internal; never shown to uploaders) */
  reason?: string;
  /** Number of user reports received */
  reportCount: number;
}

// ── Report request payload ────────────────────────────────────

export interface ReportRequest {
  cid: string;
  kind: ModerationAssetKind;
  category: ReportCategory;
  /** Optional reporter wallet address */
  reporterAddress?: string;
  /** Optional description (max 1000 chars) */
  description?: string;
}

// ── Audit log entry ───────────────────────────────────────────

export interface ModerationAuditEntry {
  cid: string;
  previousState: ModerationState | null;
  newState: ModerationState;
  actor: string;
  reason?: string;
  timestamp: string;
}

// ── Business rules ────────────────────────────────────────────

/** How many user reports trigger automatic quarantine */
export const QUARANTINE_REPORT_THRESHOLD = 3;

/**
 * Returns true when content is safe to display in public UI paths
 * (listing pages, explore, profile galleries).
 */
export function isModerationSafeForDisplay(state: ModerationState): boolean {
  return state === "APPROVED" || state === "PENDING" || state === "REPORTED";
}

/**
 * Returns true when content can proceed to mint or be promoted.
 * Quarantined and rejected assets must never reach this state.
 */
export function isModerationSafeForMint(state: ModerationState): boolean {
  return state === "APPROVED";
}

/**
 * Determines the next moderation state after a new report is received,
 * based on the current state and cumulative report count.
 */
export function nextStateAfterReport(
  current: ModerationState,
  newReportCount: number
): ModerationState {
  if (current === "REJECTED") return "REJECTED";
  if (current === "QUARANTINED") return "QUARANTINED";
  if (newReportCount >= QUARANTINE_REPORT_THRESHOLD) return "QUARANTINED";
  return "REPORTED";
}

// ── In-memory store (development / MVP) ──────────────────────
//
// In production, replace with calls to the indexer's /moderation endpoints.
// The indexer will persist records in PostgreSQL via Prisma.

const _store = new Map<string, ModerationRecord>();
const _auditLog: ModerationAuditEntry[] = [];

/**
 * Creates a PENDING moderation record for a freshly uploaded CID.
 * Idempotent — calling again for the same CID is a no-op.
 */
export function registerUpload(
  cid: string,
  kind: ModerationAssetKind,
  uploaderAddress?: string
): ModerationRecord {
  if (_store.has(cid)) return _store.get(cid)!;
  const record: ModerationRecord = {
    cid,
    kind,
    state: "PENDING",
    updatedAt: new Date().toISOString(),
    uploaderAddress,
    reportCount: 0,
  };
  _store.set(cid, record);
  _appendAudit({ cid, previousState: null, newState: "PENDING", actor: "system", timestamp: record.updatedAt });
  return record;
}

/**
 * Returns the moderation record for a CID, or null if unknown.
 */
export function getModerationRecord(cid: string): ModerationRecord | null {
  return _store.get(cid) ?? null;
}

/**
 * Applies a report to a CID, advancing state if threshold is crossed.
 * Returns the updated record.
 */
export function applyReport(req: ReportRequest): ModerationRecord {
  let record = _store.get(req.cid);
  if (!record) {
    record = registerUpload(req.cid, req.kind);
  }

  const prevState = record.state;
  record.reportCount += 1;
  const nextState = nextStateAfterReport(prevState, record.reportCount);

  if (nextState !== prevState) {
    record.state = nextState;
    record.updatedAt = new Date().toISOString();
    record.reviewedBy = req.reporterAddress ?? "user";
    _appendAudit({
      cid: req.cid,
      previousState: prevState,
      newState: nextState,
      actor: req.reporterAddress ?? "user",
      reason: `${req.category}: ${req.description ?? ""}`.trim(),
      timestamp: record.updatedAt,
    });
  } else {
    record.updatedAt = new Date().toISOString();
  }

  _store.set(req.cid, record);
  return record;
}

/**
 * Sets a moderation state manually (admin action).
 * Creates a full audit trail entry.
 */
export function setModerationState(
  cid: string,
  newState: ModerationState,
  actor: string,
  reason?: string
): ModerationRecord | null {
  const record = _store.get(cid);
  if (!record) return null;

  const prevState = record.state;
  record.state = newState;
  record.updatedAt = new Date().toISOString();
  record.reviewedBy = actor;
  record.reason = reason;
  _store.set(cid, record);

  _appendAudit({
    cid,
    previousState: prevState,
    newState,
    actor,
    reason,
    timestamp: record.updatedAt,
  });

  return record;
}

/**
 * Returns all audit log entries for a given CID.
 */
export function getAuditLog(cid?: string): ModerationAuditEntry[] {
  if (!cid) return [..._auditLog];
  return _auditLog.filter((e) => e.cid === cid);
}

function _appendAudit(entry: ModerationAuditEntry): void {
  _auditLog.push(entry);
}
