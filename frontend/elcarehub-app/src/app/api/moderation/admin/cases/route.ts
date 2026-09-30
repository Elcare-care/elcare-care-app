// ─────────────────────────────────────────────────────────────
// app/api/moderation/admin/cases/route.ts
//
// Issue #542 — Operator-only moderation triage list.
//
// Server-side proxy to the indexer's GET /moderation/cases. Holds the
// OPERATOR_TOKEN server-side secret so it never ships to the browser
// bundle. The admin page itself is gated behind the on-chain admin wallet
// check and useAdminSession (see app/admin/page.tsx) before this is called.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";

function indexerBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://localhost:4000").replace(/\/$/, "");
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  try {
    const res = await fetch(`${indexerBaseUrl()}/moderation/cases?${params.toString()}`, {
      headers: { "x-operator-token": process.env.OPERATOR_TOKEN ?? "" },
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Failed to reach the indexer." }, { status: 502 });
  }
}
