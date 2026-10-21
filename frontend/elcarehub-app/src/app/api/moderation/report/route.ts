// ─────────────────────────────────────────────────────────────
// app/api/moderation/report/route.ts
//
// Issue #308 / #43, extended by Issue #542 — Content report endpoint
//
// Proxies to the indexer's POST /moderation/reports and GET
// /moderation/cases/:cid (see lib/moderation.ts), falling back to an
// in-memory store only if the indexer is unreachable.
//
// POST /api/moderation/report
//   Accepts a user content report for an IPFS CID.
//   Advances moderation state to QUARANTINED when the
//   report threshold (3) is reached. Never echoes reporterAddress back.
//   See docs/MODERATION_POLICY.md for the full workflow.
//
// GET /api/moderation/report?cid=<CID>
//   Returns the current moderation record for a CID.
//   Audit trail, reporter identity, and internal reason fields are
//   omitted from the public response.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import {
  applyReport,
  getModerationRecord,
  ReportRequest,
  ReportCategory,
  ModerationAssetKind,
} from "@/lib/moderation";

// Header used by the request logging/correlation middleware to propagate
// a stable request identifier. Falls back to a generated ID when absent.
const REQUEST_ID_HEADER = "x-request-id";

function getRequestId(req: NextRequest): string {
  const incoming = req.headers.get(REQUEST_ID_HEADER);
  if (incoming && incoming.trim()) {
    return incoming.trim();
  }
  return crypto.randomUUID();
}

function errorResponse(
  req: NextRequest,
  message: string,
  status: number
): NextResponse {
  const requestId = getRequestId(req);
  return NextResponse.json(
    { error: message, requestId },
    { status, headers: { [REQUEST_ID_HEADER]: requestId } }
  );
}

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
    return errorResponse(req, "Request body must be valid JSON.", 400);
  }

  if (!body || typeof body !== "object") {
    return errorResponse(req, "Request body must be a JSON object.", 400);
  }

  const obj = body as Record<string, unknown>;

  // ── Validate required fields ───────────────────────────────
  if (typeof obj.cid !== "string" || !obj.cid.trim()) {
    return errorResponse(req, "Field 'cid' is required.", 422);
  }

  if (!ALLOWED_KINDS.includes(obj.kind as ModerationAssetKind)) {
    return errorResponse(
      req,
      `Field 'kind' must be one of: ${ALLOWED_KINDS.join(", ")}.`,
      422
    );
  }

  if (!ALLOWED_CATEGORIES.includes(obj.category as ReportCategory)) {
    return errorResponse(
      req,
      `Field 'category' must be one of: ${ALLOWED_CATEGORIES.join(", ")}.`,
      422
    );
  }

  if (
    obj.description !== undefined &&
    (typeof obj.description !== "string" || obj.description.length > DESCRIPTION_MAX_LEN)
  ) {
    return errorResponse(
      req,
      `Field 'description' must be a string of at most ${DESCRIPTION_MAX_LEN} characters.`,
      422
    );
  }

  if (
    obj.reporterAddress !== undefined &&
    typeof obj.reporterAddress !== "string"
  ) {
    return errorResponse(req, "Field 'reporterAddress' must be a string.", 422);
  }

  const request: ReportRequest = {
    cid: (obj.cid as string).trim(),
    kind: obj.kind as ModerationAssetKind,
    category: obj.category as ReportCategory,
    description: typeof obj.description === "string" ? obj.description : undefined,
    reporterAddress: typeof obj.reporterAddress === "string" ? obj.reporterAddress : undefined,
  };

  const record = await applyReport(request);

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
    return errorResponse(req, "Query param 'cid' is required.", 400);
  }

  const record = await getModerationRecord(cid.trim());
  if (!record) {
    return errorResponse(req, "No moderation record found for this CID.", 404);
  }

  return NextResponse.json({
    cid: record.cid,
    kind: record.kind,
    state: record.state,
    reportCount: record.reportCount,
    updatedAt: record.updatedAt,
  });
}
