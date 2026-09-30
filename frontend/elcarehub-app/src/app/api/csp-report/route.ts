// app/api/csp-report/route.ts
//
// POST /api/csp-report
//   Receives Content-Security-Policy violation reports sent by the browser
//   when the Content-Security-Policy-Report-Only header is active.
//
//   Reports are logged to stdout (visible in server logs / Sentry) and held
//   in a bounded in-memory ring buffer for local inspection during development.
//   In production, forward to a dedicated sink (Sentry, Datadog, CloudWatch)
//   by extending the `forwardReport` function below.
//
//   Blocked-uri values are truncated to origin-only to prevent query-string
//   tokens from appearing in logs.
//
// Retention: the in-memory buffer holds at most MAX_BUFFER reports and is
// cleared on process restart — it is NOT a durable store.

import { NextRequest, NextResponse } from "next/server";

const MAX_BUFFER = 200;
const reports: unknown[] = [];

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  const safe = sanitizeReport(body);

  if (reports.length >= MAX_BUFFER) reports.shift();
  reports.push({ receivedAt: new Date().toISOString(), ...asObject(safe) });

  console.warn("[CSP]", JSON.stringify(safe));

  // Hook: forward to an external sink in production
  await forwardReport(safe);

  return new NextResponse(null, { status: 204 });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sanitizeReport(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") return {};
  const report = body as Record<string, unknown>;
  const inner = report["csp-report"];
  if (inner && typeof inner === "object") {
    const cspReport = inner as Record<string, unknown>;
    // Truncate blocked-uri to origin to avoid leaking tokens in query strings
    if (typeof cspReport["blocked-uri"] === "string") {
      try {
        cspReport["blocked-uri"] = new URL(cspReport["blocked-uri"]).origin;
      } catch {
        cspReport["blocked-uri"] = "[non-url]";
      }
    }
    // Truncate source-file similarly
    if (typeof cspReport["source-file"] === "string") {
      try {
        cspReport["source-file"] = new URL(cspReport["source-file"]).origin;
      } catch {
        // keep as-is if it's a relative path
      }
    }
  }
  return report;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

// Replace this stub with a real forwarding call (Sentry, Datadog, etc.) for
// production deployments where stdout is not monitored.
async function forwardReport(_report: unknown): Promise<void> {
  // Example (Sentry breadcrumb):
  // Sentry.addBreadcrumb({ category: 'csp', message: JSON.stringify(_report), level: 'warning' });
}
