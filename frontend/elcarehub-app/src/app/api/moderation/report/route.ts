// ─────────────────────────────────────────────────────────────
// app/api/moderation/report/route.ts
//
// Issue #308 / #43 — Content report endpoint
//
// POST /api/moderation/report
//   Accepts a user content report for an IPFS CID.
//   Advances moderation state to QUARANTINED when the
//   report threshold (3) is reached.
//
// GET /api/moderation/report?cid=<CID>
//   Returns the current moderation record for a CID.
//   Audit trail and internal reason fields are omitted
//   from the public response.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import {
  applyReport,
  getModerationRecord,
  ReportRequest,
  ReportCategory,
  ModerationAssetKind,
} from "@/lib/moderation";

const ALLOWED_CATEGORIES: ReportCategory[] = [
  "PROHIBITED_CONTENT",
  "INTELLECTUAL_PROPERTY",
  "MISLEADING_METADATA",
  "SPAM",
  "MALWARE_SUSPECTED",
  "OTHER",
];

const ALLOWED_KINDS: ModerationAssetKind[] = ["IMAGE", "METADATA"];

const DESCRIPTION_MAX_LEN = 1000;

// ── POST — submit a report ────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }

  const obj = body as Record<string, unknown>;

  // ── Validate required fields ───────────────────────────────
  if (typeof obj.cid !== "string" || !obj.cid.trim()) {
    return NextResponse.json({ error: "Field 'cid' is required." }, { status: 422 });
  }

  if (!ALLOWED_KINDS.includes(obj.kind as ModerationAssetKind)) {
    return NextResponse.json(
      { error: `Field 'kind' must be one of: ${ALLOWED_KINDS.join(", ")}.` },
      { status: 422 }
    );
  }

  if (!ALLOWED_CATEGORIES.includes(obj.category as ReportCategory)) {
    return NextResponse.json(
      { error: `Field 'category' must be one of: ${ALLOWED_CATEGORIES.join(", ")}.` },
      { status: 422 }
    );
  }

  if (
    obj.description !== undefined &&
    (typeof obj.description !== "string" || obj.description.length > DESCRIPTION_MAX_LEN)
  ) {
    return NextResponse.json(
      { error: `Field 'description' must be a string of at most ${DESCRIPTION_MAX_LEN} characters.` },
      { status: 422 }
    );
  }

  if (
    obj.reporterAddress !== undefined &&
    typeof obj.reporterAddress !== "string"
  ) {
    return NextResponse.json({ error: "Field 'reporterAddress' must be a string." }, { status: 422 });
  }

  const request: ReportRequest = {
    cid: (obj.cid as string).trim(),
    kind: obj.kind as ModerationAssetKind,
    category: obj.category as ReportCategory,
    description: typeof obj.description === "string" ? obj.description : undefined,
    reporterAddress: typeof obj.reporterAddress === "string" ? obj.reporterAddress : undefined,
  };

  const record = applyReport(request);

  // Return the public-safe subset (no internal reason or reviewer identity)
  return NextResponse.json(
    {
      cid: record.cid,
      kind: record.kind,
      state: record.state,
      reportCount: record.reportCount,
      updatedAt: record.updatedAt,
    },
    { status: 200 }
  );
}

// ── GET — query moderation state ──────────────────────────────

export async function GET(req: NextRequest) {
  const cid = req.nextUrl.searchParams.get("cid");

  if (!cid || !cid.trim()) {
    return NextResponse.json({ error: "Query param 'cid' is required." }, { status: 400 });
  }

  const record = getModerationRecord(cid.trim());
  if (!record) {
    return NextResponse.json({ error: "No moderation record found for this CID." }, { status: 404 });
  }

  return NextResponse.json({
    cid: record.cid,
    kind: record.kind,
    state: record.state,
    reportCount: record.reportCount,
    updatedAt: record.updatedAt,
  });
}
