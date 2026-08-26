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

// ── In-memory store (local fallback only) ─────────────────────
//
// The indexer's /moderation endpoints (indexer/src/api/moderation-routes.ts)
// are now the source of truth — records persist in PostgreSQL via Prisma
// (see indexer/prisma/schema.prisma: ModerationCase / ModerationReport /
// ModerationDecision / ModerationAppeal). This in-memory store only exists
// as a fallback for local development when the indexer is unreachable, so
// the report flow never hard-fails.

const _store = new Map<string, ModerationRecord>();
const _auditLog: ModerationAuditEntry[] = [];

/**
 * Creates a PENDING moderation record for a freshly uploaded CID (local
 * fallback store only — the indexer creates its own ModerationCase lazily
 * on first report).
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

function _localApplyReport(req: ReportRequest): ModerationRecord {
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
 * Sets a moderation state manually (admin action) in the local fallback
 * store. Creates a full audit trail entry.
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
 * Returns all audit log entries for a given CID (local fallback store only).
 */
export function getAuditLog(cid?: string): ModerationAuditEntry[] {
  if (!cid) return [..._auditLog];
  return _auditLog.filter((e) => e.cid === cid);
}

function _appendAudit(entry: ModerationAuditEntry): void {
  _auditLog.push(entry);
}

// ── Indexer-backed API (Issue #542) ───────────────────────────
//
// These functions call the indexer's /moderation endpoints and fall back to
// the in-memory store above when the indexer is unreachable (e.g. local dev
// without the indexer running). Public-facing fields only — reporter
// identity and report evidence never round-trip through these calls.

function indexerBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://localhost:4000").replace(/\/$/, "");
}

/** Link to the human-readable moderation policy, surfaced next to report/decision UI. */
export const MODERATION_POLICY_URL =
  "https://github.com/Elcare-care/elcare-care-app/blob/main/docs/MODERATION_POLICY.md";

/**
 * Submits a report to the indexer. Falls back to the local in-memory store
 * if the indexer request fails, so the report flow never hard-fails.
 * Never receives or echoes back the reporter's address.
 */
export async function applyReport(req: ReportRequest): Promise<ModerationRecord> {
  try {
    const res = await fetch(`${indexerBaseUrl()}/moderation/reports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`indexer responded ${res.status}`);
    const data = await res.json();
    return {
      cid: data.cid,
      kind: data.kind,
      state: data.state,
      updatedAt: data.updatedAt,
      reportCount: data.reportCount,
    };
  } catch {
    return _localApplyReport(req);
  }
}

/**
 * Fetches the public-safe moderation case for a CID from the indexer,
 * falling back to the local in-memory store on failure.
 */
export async function getModerationRecord(cid: string): Promise<ModerationRecord | null> {
  try {
    const res = await fetch(`${indexerBaseUrl()}/moderation/cases/${encodeURIComponent(cid)}`, {
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`indexer responded ${res.status}`);
    const data = await res.json();
    return {
      cid: data.cid,
      kind: data.kind,
      state: data.state,
      updatedAt: data.updatedAt,
      reportCount: data.reportCount,
    };
  } catch {
    return _store.get(cid) ?? null;
  }
}

export interface ModerationCaseFull {
  id: number;
  cid: string;
  kind: ModerationAssetKind;
  state: ModerationState;
  reportCount: number;
  uploaderAddress: string | null;
  listingId: string | null;
  reason: string | null;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
  reports: Array<{
    id: number;
    category: ReportCategory;
    description: string | null;
    reporterAddress: string | null;
    createdAt: string;
  }>;
  decisions: Array<{
    id: number;
    previousState: ModerationState;
    newState: ModerationState;
    actor: string;
    reason: string | null;
    createdAt: string;
  }>;
  appeals: ModerationAppeal[];
}

export type AppealStatus = "PENDING" | "UNDER_REVIEW" | "UPHELD" | "OVERTURNED";

export interface ModerationAppeal {
  id: number;
  caseId: number;
  appellantAddress: string;
  statement: string;
  status: AppealStatus;
  decidedBy: string | null;
  decisionReason: string | null;
  createdAt: string;
  decidedAt: string | null;
}

// ── Operator (admin) calls ─────────────────────────────────────
//
// These route through the Next.js server-side proxy under
// app/api/moderation/admin/* rather than calling the indexer directly, so
// the indexer's OPERATOR_TOKEN never ships to the browser bundle. The admin
// page itself is gated behind the on-chain admin wallet check and
// useAdminSession (see app/admin/page.tsx) before any of these are called.

/** Operator-only: paginated triage list, optionally filtered by state. */
export async function listModerationCases(
  opts: { state?: ModerationState; limit?: number; offset?: number } = {}
): Promise<{ cases: ModerationCaseFull[]; total: number }> {
  const params = new URLSearchParams();
  if (opts.state) params.set("state", opts.state);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.offset) params.set("offset", String(opts.offset));

  const res = await fetch(`/api/moderation/admin/cases?${params.toString()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch moderation cases (${res.status})`);
  return res.json();
}

/** Operator-only: full case detail including reports, decisions, and appeals. */
export async function getModerationCaseFull(cid: string): Promise<ModerationCaseFull> {
  const res = await fetch(`/api/moderation/admin/cases/${encodeURIComponent(cid)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch moderation case (${res.status})`);
  return res.json();
}

/** Operator-only: record a moderation decision (APPROVED / QUARANTINED / REJECTED). */
export async function decideModerationCase(
  cid: string,
  input: { state: "APPROVED" | "QUARANTINED" | "REJECTED"; actor: string; reason?: string }
): Promise<ModerationRecord> {
  const res = await fetch(`/api/moderation/admin/cases/${encodeURIComponent(cid)}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to record decision (${res.status})`);
  return res.json();
}

/** Authenticated: uploader/creator files an appeal against a QUARANTINED/REJECTED case. */
export async function submitAppeal(
  cid: string,
  input: { appellantAddress: string; statement: string }
): Promise<ModerationAppeal> {
  const res = await fetch(`${indexerBaseUrl()}/moderation/cases/${encodeURIComponent(cid)}/appeals`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-wallet-address": input.appellantAddress },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to submit appeal (${res.status})`);
  return res.json();
}

/** Operator-only: resolve an appeal (UPHELD keeps the rejection; OVERTURNED reinstates the case). */
export async function decideAppeal(
  appealId: number,
  input: { status: "UPHELD" | "OVERTURNED"; decidedBy: string; decisionReason?: string; reinstateState?: "APPROVED" | "REPORTED" }
): Promise<ModerationAppeal> {
  const res = await fetch(`/api/moderation/admin/appeals/${appealId}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to record appeal decision (${res.status})`);
  return res.json();
}
