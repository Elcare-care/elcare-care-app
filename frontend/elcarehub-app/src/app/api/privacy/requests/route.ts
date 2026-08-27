// ─────────────────────────────────────────────────────────────
// app/api/privacy/requests/route.ts
//
// Issue #543 — Server-side proxy: POST/GET /api/privacy/requests
//
// Forwards to the ELCARE-HUB indexer's wallet-scoped privacy endpoints so the
// browser never needs to know the internal indexer URL. The caller's wallet
// address travels as the X-Wallet-Address header — the same trust model used
// by the indexer's other "authenticated" routes (a claimed wallet address,
// no signature challenge). This route does not add or remove trust; it only
// hides the indexer's internal address from the browser.
//
// POST /api/privacy/requests
//   Headers: X-Wallet-Address: <G...>
//   Body:    { type: 'EXPORT' | 'DELETION' }
//   Returns: the created (and, for this MVP, immediately processed) request.
//
// GET /api/privacy/requests
//   Headers: X-Wallet-Address: <G...>
//   Returns: the caller's own privacy requests, newest first.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";

const INDEXER_BASE = (
  process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://localhost:4000"
).replace(/\/$/, "");

function walletHeader(req: NextRequest): string | null {
  return req.headers.get("x-wallet-address");
}

export async function POST(req: NextRequest) {
  const wallet = walletHeader(req);
  if (!wallet) {
    return NextResponse.json(
      { error: "X-Wallet-Address header is required." },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const type = (body as { type?: unknown })?.type;
  if (type !== "EXPORT" && type !== "DELETION") {
    return NextResponse.json(
      { error: "Field 'type' must be 'EXPORT' or 'DELETION'." },
      { status: 422 }
    );
  }

  try {
    const upstream = await fetch(`${INDEXER_BASE}/privacy/requests`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-wallet-address": wallet,
      },
      body: JSON.stringify({ type }),
      signal: AbortSignal.timeout(15_000),
    });

    const data: unknown = await upstream.json().catch(() => ({}));
    return NextResponse.json(data, { status: upstream.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upstream request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function GET(req: NextRequest) {
  const wallet = walletHeader(req);
  if (!wallet) {
    return NextResponse.json(
      { error: "X-Wallet-Address header is required." },
      { status: 401 }
    );
  }

  try {
    const upstream = await fetch(`${INDEXER_BASE}/privacy/requests`, {
      headers: {
        Accept: "application/json",
        "x-wallet-address": wallet,
      },
      signal: AbortSignal.timeout(10_000),
    });

    const data: unknown = await upstream.json().catch(() => ({}));
    return NextResponse.json(data, { status: upstream.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upstream request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
