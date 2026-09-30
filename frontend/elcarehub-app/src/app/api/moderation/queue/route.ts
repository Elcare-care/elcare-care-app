// ─────────────────────────────────────────────────────────────
// app/api/moderation/queue/route.ts
//
// Issue #534 — Admin content moderation queue endpoint
//
// GET  /api/moderation/queue
//   Returns all moderation records as a JSON array.
//   Intended for authenticated admin use only.
//
// PATCH /api/moderation/queue
//   Body: { cid, newState, actor, reason? }
//   Applies a manual state transition and returns the updated record.
//   Intended for authenticated admin use only.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import {
  getAllRecords,
  getModerationRecord,
  setModerationState,
  ModerationState,
} from "@/lib/moderation";

const VALID_STATES: ModerationState[] = [
  "PENDING",
  "APPROVED",
  "QUARANTINED",
  "REJECTED",
  "REPORTED",
];

// ── GET — list all moderation records ────────────────────────

export async function GET(_req: NextRequest) {
  const records = getAllRecords();
  return NextResponse.json(records, { status: 200 });
}

// ── PATCH — update a record's state ──────────────────────────

export async function PATCH(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "Request body must be a JSON object." },
      { status: 400 }
    );
  }

  const obj = body as Record<string, unknown>;

  // ── Validate required fields ───────────────────────────────

  if (typeof obj.cid !== "string" || !obj.cid.trim()) {
    return NextResponse.json(
      { error: "Field 'cid' is required." },
      { status: 422 }
    );
  }

  if (!VALID_STATES.includes(obj.newState as ModerationState)) {
    return NextResponse.json(
      { error: `Field 'newState' must be one of: ${VALID_STATES.join(", ")}.` },
      { status: 422 }
    );
  }

  if (typeof obj.actor !== "string" || !obj.actor.trim()) {
    return NextResponse.json(
      { error: "Field 'actor' is required." },
      { status: 422 }
    );
  }

  if (obj.reason !== undefined && typeof obj.reason !== "string") {
    return NextResponse.json(
      { error: "Field 'reason' must be a string." },
      { status: 422 }
    );
  }

  const cid = (obj.cid as string).trim();
  const newState = obj.newState as ModerationState;
  const actor = (obj.actor as string).trim();
  const reason = typeof obj.reason === "string" ? obj.reason : undefined;

  // Check the record exists
  const existing = getModerationRecord(cid);
  if (!existing) {
    return NextResponse.json(
      { error: "No moderation record found for this CID." },
      { status: 404 }
    );
  }

  const updated = setModerationState(cid, newState, actor, reason);
  if (!updated) {
    return NextResponse.json(
      { error: "Failed to update moderation record." },
      { status: 500 }
    );
  }

  return NextResponse.json(updated, { status: 200 });
}
