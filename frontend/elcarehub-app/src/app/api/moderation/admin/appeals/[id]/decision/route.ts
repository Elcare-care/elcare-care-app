// ─────────────────────────────────────────────────────────────
// app/api/moderation/admin/appeals/[id]/decision/route.ts
//
// Issue #542 — Operator-only appeal resolution.
// Server-side proxy to the indexer's POST /moderation/appeals/:id/decision.
// See app/api/moderation/admin/cases/route.ts for the auth/token rationale.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";

function indexerBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://localhost:4000").replace(/\/$/, "");
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  try {
    const res = await fetch(`${indexerBaseUrl()}/moderation/appeals/${encodeURIComponent(id)}/decision`, {
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
