// ─────────────────────────────────────────────────────────────
// app/api/moderation/admin/cases/[cid]/route.ts
//
// Issue #542 — Operator-only full case detail (reports + decisions + appeals).
// Server-side proxy to the indexer's GET /moderation/cases/:cid/full.
// See app/api/moderation/admin/cases/route.ts for the auth/token rationale.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";

function indexerBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://localhost:4000").replace(/\/$/, "");
}

export async function GET(_req: NextRequest, { params }: { params: { cid: string } }) {
  const { cid } = params;
  try {
    const res = await fetch(`${indexerBaseUrl()}/moderation/cases/${encodeURIComponent(cid)}/full`, {
      headers: { "x-operator-token": process.env.OPERATOR_TOKEN ?? "" },
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Failed to reach the indexer." }, { status: 502 });
  }
}
