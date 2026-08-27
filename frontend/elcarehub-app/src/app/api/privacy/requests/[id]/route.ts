// ─────────────────────────────────────────────────────────────
// app/api/privacy/requests/[id]/route.ts
//
// Issue #543 — Server-side proxy: GET /api/privacy/requests/:id
//
// Forwards to the indexer, which scopes the lookup to the wallet supplied in
// X-Wallet-Address and returns 403 if it does not own the request.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";

const INDEXER_BASE = (
  process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://localhost:4000"
).replace(/\/$/, "");

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const wallet = req.headers.get("x-wallet-address");
  if (!wallet) {
    return NextResponse.json(
      { error: "X-Wallet-Address header is required." },
      { status: 401 }
    );
  }

  try {
    const upstream = await fetch(
      `${INDEXER_BASE}/privacy/requests/${encodeURIComponent(id)}`,
      {
        headers: {
          Accept: "application/json",
          "x-wallet-address": wallet,
        },
        signal: AbortSignal.timeout(10_000),
      }
    );

    const data: unknown = await upstream.json().catch(() => ({}));
    return NextResponse.json(data, { status: upstream.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upstream request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
