/**
 * app/api/support/route.ts
 *
 * Work item B — Support report submission endpoint.
 *
 * POST /api/support
 *   Body: SupportFormInput (JSON)
 *   Returns: { id, status, responseSlaHours } on success
 *            { error } on validation failure
 *
 * Security notes:
 *  • Rejects submissions containing secret-key patterns server-side.
 *  • Does not persist reporter secrets; wallet address is optional.
 *  • Support staff cannot alter on-chain state through this endpoint.
 *  • In production, replace the in-memory store with an indexer API call.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import {
  containsSecret,
  validateSupportForm,
  SUPPORT_CATEGORIES,
  SupportReport,
  SupportFormInput,
} from '@/lib/support';

// In-memory store (dev/MVP). Replace with indexer DB call in production.
const _reports = new Map<string, SupportReport>();

export async function POST(req: NextRequest) {
  let body: SupportFormInput;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  // Server-side secret guard (defence-in-depth; client also validates)
  const allText = [
    body.resourceId ?? '', body.transactionHash ?? '', body.ipfsCid ?? '',
    body.screenshotUrl ?? '', body.description ?? '', body.reporterAddress ?? '',
  ].join(' ');
  if (containsSecret(allText)) {
    return NextResponse.json(
      { error: 'Submission rejected: contains a pattern that looks like a private key or seed phrase. Remove it and resubmit.' },
      { status: 422 }
    );
  }

  const errors = validateSupportForm({
    category: body.category ?? '',
    resourceId: body.resourceId ?? '',
    transactionHash: body.transactionHash ?? '',
    ipfsCid: body.ipfsCid ?? '',
    screenshotUrl: body.screenshotUrl ?? '',
    description: body.description ?? '',
    reporterAddress: body.reporterAddress ?? '',
  });

  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ error: 'Validation failed.', fields: errors }, { status: 422 });
  }

  const category = body.category as keyof typeof SUPPORT_CATEGORIES;
  const meta = SUPPORT_CATEGORIES[category];
  const now = new Date().toISOString();
  const id = `SUP-${randomUUID().slice(0, 8).toUpperCase()}`;

  const report: SupportReport = {
    id,
    category,
    resourceId:       body.resourceId?.trim()       || undefined,
    transactionHash:  body.transactionHash?.trim()   || undefined,
    screenshotUrl:    body.screenshotUrl?.trim()     || undefined,
    ipfsCid:          body.ipfsCid?.trim()           || undefined,
    reporterAddress:  body.reporterAddress?.trim()   || undefined,
    description:      body.description.trim(),
    status:           'RECEIVED',
    createdAt:        now,
    updatedAt:        now,
  };

  _reports.set(id, report);

  return NextResponse.json(
    { id: report.id, status: report.status, responseSlaHours: meta.responseSlaHours },
    { status: 201 }
  );
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'Missing ?id= param.' }, { status: 400 });
  }
  const report = _reports.get(id);
  if (!report) {
    return NextResponse.json({ error: 'Report not found.' }, { status: 404 });
  }
  // Do not expose internal fields to the public endpoint
  const { resolutionNote, ...publicReport } = report;
  return NextResponse.json({ ...publicReport, resolutionNote: resolutionNote ?? null });
}
