// ─────────────────────────────────────────────────────────────
// app/api/moderation/admin/cases/[cid]/decision/route.ts
//
// Issue #542 — Operator-only moderation decision.
// Server-side proxy to the indexer's POST /moderation/cases/:cid/decision.
// See app/api/moderation/admin/cases/route.ts for the auth/token rationale.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";

function indexerBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://localhost:4000").replace(/\/$/, "");
}

export async function POST(req: NextRequest, { params }: { params: { cid: string } }) {
  const { cid } = params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  try {
    const res = await fetch(`${indexerBaseUrl()}/moderation/cases/${encodeURIComponent(cid)}/decision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-operator-token": process.env.OPERATOR_TOKEN ?? "",
      },
      body: JSON.stringify(body),
    });
    const responseBody = await res.json().catch(() => ({}));
    return NextResponse.json(responseBody, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Failed to reach the indexer." }, { status: 502 });
  }
}
