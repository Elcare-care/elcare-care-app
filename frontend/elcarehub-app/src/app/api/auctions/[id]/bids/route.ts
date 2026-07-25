// ─────────────────────────────────────────────────────────────
// app/api/auctions/[id]/bids/route.ts
//
// Server-side proxy: GET /api/auctions/:id/bids?offset=&limit=
//
// Forwards the request to the ELCARE-HUB indexer so the browser
// never needs to know the internal indexer URL, and so we can add
// caching headers without exposing the indexer directly.
//
// Query parameters forwarded to the indexer:
//   offset  – number of bids to skip (default 0)
//   limit   – bids per page (default 20, capped at 100)
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";

const INDEXER_BASE = (
  process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://localhost:4000"
).replace(/\/$/, "");

/** Maximum page size accepted by this proxy. */
const MAX_LIMIT = 100;
/** Default page size. */
const DEFAULT_LIMIT = 20;

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const auctionId = Number(id);

  if (!Number.isFinite(auctionId) || auctionId <= 0) {
    return NextResponse.json(
      { error: "Invalid auction id" },
      { status: 400 }
    );
  }

  const searchParams = req.nextUrl.searchParams;
  const rawOffset = parseInt(searchParams.get("offset") ?? "0", 10);
  const rawLimit = parseInt(
    searchParams.get("limit") ?? String(DEFAULT_LIMIT),
    10
  );

  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_LIMIT)
      : DEFAULT_LIMIT;

  const upstream = `${INDEXER_BASE}/auctions/${auctionId}/bids?offset=${offset}&limit=${limit}`;

  try {
    const res = await fetch(upstream, {
      headers: {
        Accept: "application/json",
        // Forward a request-id for distributed tracing if present
        ...(req.headers.get("x-request-id")
          ? { "x-request-id": req.headers.get("x-request-id")! }
          : {}),
      },
      // 10 s upstream timeout
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      // Surface upstream errors with their original status code
      const body = await res.text();
      return NextResponse.json(
        { error: `Indexer error: ${body}` },
        { status: res.status }
      );
    }

    const data: unknown = await res.json();

    // Cache for 10 s on the CDN edge, revalidate stale in background for 30 s
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upstream request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
